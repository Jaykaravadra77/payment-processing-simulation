'use strict'

const { Worker } = require('bullmq')
const connection = require('../src/shared/lib/redis')
const logger = require('../src/shared/lib/logger')
const { paymentService } = require('../src/shared/services')
const { backoffStrategy, QUEUE_NAME } = require('./retryQueue')
const config = require('../config')

// Job handler: drive the Step 8 engine. A retriable failure throws out of
// process() and propagates here, which tells BullMQ to reschedule (with backoff).
async function paymentProcessor (job) {
  const { paymentId } = job.data
  return paymentService.process(paymentId)
}

// Build a configured Worker. Exposed as a factory so the API/worker entry point
// and the verification scripts can each start one in their own process.
function createPaymentWorker ({ concurrency = 5 } = {}) {
  const worker = new Worker(QUEUE_NAME, paymentProcessor, {
    // Separate Redis connection from the producer — BullMQ best practice, since
    // the worker issues blocking commands that shouldn't share the queue's conn.
    connection: connection.duplicate(),
    concurrency,
    settings: { backoffStrategy }
  })

  worker.on('completed', (job) => {
    logger.info({ paymentId: job.data.paymentId, jobId: job.id }, 'job completed')
  })

  worker.on('failed', async (job, err) => {
    if (!job) return
    const attemptsLeft = (job.opts.attempts || config.MAX_PAYMENT_ATTEMPTS) - job.attemptsMade
    logger.warn(
      { paymentId: job.data.paymentId, jobId: job.id, attemptsMade: job.attemptsMade, attemptsLeft, err: err.message },
      'job attempt failed'
    )

    // Final failure with no retries left. process() normally settles FAILED itself
    // (returns, so we don't land here); this defends against an unexpected crash
    // that left the payment stuck — mark it FAILED if the state machine allows.
    if (attemptsLeft <= 0) {
      try {
        await paymentService.failPayment(job.data.paymentId, `worker: ${err.message}`)
      } catch (e) {
        logger.error({ paymentId: job.data.paymentId, err: e.message }, 'defensive failPayment errored')
      }
    }
  })

  worker.on('error', (err) => logger.error({ err: err.message }, 'worker error'))

  return worker
}

module.exports = { paymentProcessor, createPaymentWorker }
