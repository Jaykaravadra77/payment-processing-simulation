'use strict'

const { Queue, Worker } = require('bullmq')
const connection = require('../src/shared/lib/redis')
const logger = require('../src/shared/lib/logger')
const { PaymentRepository } = require('../src/shared/repositories')
const { paymentService } = require('../src/shared/services')
const { paymentQueue, enqueuePayment, jobIdFor } = require('./retryQueue')
const config = require('../config')

const QUEUE_NAME = 'payment-reconcile'

// The sweep. Find every payment stuck in PROCESSING past the stale threshold and
// recover it. Kept independent of BullMQ so it can be called directly from a test.
//
// Recovery is DB-driven on purpose: the worker that owned a stuck payment is gone,
// but its row survives the crash — so the row is the source of truth, not the queue.
// recoverStalePayment releases PROCESSING -> PENDING (state-machine guarded); we then
// hand the payment back to the processing queue for a fresh attempt.
async function reconcileStale () {
  const stale = await PaymentRepository.findStale(config.STALE_PROCESSING_MS)

  for (const row of stale) {
    const r = await paymentService.recoverStalePayment(row.id)

    if (r.action === 'released') {
      // A kept failed/stalled job under the same jobId would dedup-block a fresh
      // enqueue, leaving the now-PENDING payment with nothing pulling it — clear it
      // first (ignore if it's currently active/locked), then enqueue a runnable job.
      await paymentQueue.remove(jobIdFor(row.id)).catch(() => {})
      await enqueuePayment(row.id)
    }

    logger.warn({ paymentId: row.id, action: r.action, status: r.status }, 'reconciler: recovered stale payment')
  }

  return { swept: stale.length }
}

// Schedule the sweep as a BullMQ repeatable job + its own worker. The schedule lives
// in Redis, so it survives a worker restart. A fixed repeat key means restarts don't
// stack duplicate schedulers.
function startReconciler () {
  const reconcileQueue = new Queue(QUEUE_NAME, { connection })

  reconcileQueue.add(
    'sweep',
    {},
    {
      repeat: { every: config.RECONCILE_INTERVAL_MS },
      removeOnComplete: true,
      removeOnFail: true
    }
  )

  const reconcileWorker = new Worker(QUEUE_NAME, reconcileStale, {
    connection: connection.duplicate()
  })

  reconcileWorker.on('completed', (job, result) => {
    logger.info({ swept: result && result.swept }, 'reconciler: sweep completed')
  })
  reconcileWorker.on('failed', (job, err) => {
    logger.error({ err: err.message }, 'reconciler: sweep failed')
  })
  reconcileWorker.on('error', (err) => logger.error({ err: err.message }, 'reconciler worker error'))

  logger.info({ everyMs: config.RECONCILE_INTERVAL_MS }, 'reconciler started')

  return { reconcileQueue, reconcileWorker }
}

module.exports = { reconcileStale, startReconciler, QUEUE_NAME }
