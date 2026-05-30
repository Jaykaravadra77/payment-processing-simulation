'use strict'

const { Queue } = require('bullmq')
const connection = require('../src/shared/lib/redis')
const config = require('../config')

const QUEUE_NAME = 'payment-processing'

// BullMQ forbids purely-numeric job ids, so prefix the payment id.
const jobIdFor = (paymentId) => `payment-${paymentId}`

// Custom backoff: exponential growth + up to ~20% jitter.
//   attempt 1 fail -> ~delay, attempt 2 -> ~2*delay, attempt 3 -> ~4*delay
// Exponential so we don't hammer a struggling provider; jitter so a batch of
// simultaneous failures doesn't retry in a synchronized stampede.
// Registered on the Worker (Step 9) via settings.backoffStrategy.
function backoffStrategy (attemptsMade) {
  const base = config.RETRY_BACKOFF_DELAY_MS * Math.pow(2, Math.max(0, attemptsMade - 1))
  const jitter = Math.random() * base * 0.2
  return Math.round(base + jitter)
}

const paymentQueue = new Queue(QUEUE_NAME, { connection })

// Enqueue a payment for background processing. jobId = paymentId means BullMQ
// dedups: two enqueues for the same payment collapse into a single job, so
// retried/double-clicked requests can never create duplicate processing work.
// attempts + exponential backoff power the retry strategy (consumed in Step 9).
async function enqueuePayment (paymentId) {
  return paymentQueue.add(
    'process',
    { paymentId },
    {
      jobId: jobIdFor(paymentId),
      attempts: config.MAX_PAYMENT_ATTEMPTS,
      backoff: { type: 'custom' },
      removeOnComplete: true,
      removeOnFail: false
    }
  )
}

module.exports = { paymentQueue, enqueuePayment, jobIdFor, backoffStrategy, QUEUE_NAME }
