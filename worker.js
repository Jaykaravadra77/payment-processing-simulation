'use strict'

require('dotenv').config()
const logger = require('./src/shared/lib/logger')
const { createPaymentWorker } = require('./queue/paymentProcessor')
const { startReconciler } = require('./queue/reconciler')

// Background worker process — separate from the API (npm run worker). The API
// only enqueues; this process pulls jobs and runs paymentService.process with
// retry/backoff. They scale independently.
const worker = createPaymentWorker()

// Crash recovery (Step 11): a repeatable sweep that re-claims payments left stuck
// in PROCESSING by a dead worker. Lives in the same process as the worker.
const { reconcileQueue, reconcileWorker } = startReconciler()

logger.info('payment worker started')

async function shutdown (signal) {
  logger.info({ signal }, 'worker shutting down')
  await worker.close()
  await reconcileWorker.close()
  await reconcileQueue.close()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
