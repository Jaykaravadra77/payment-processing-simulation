'use strict'

// Small timing so the test is fast. Must be set BEFORE requiring config-using modules.
process.env.RETRY_BACKOFF_DELAY_MS = '150'
process.env.MAX_PAYMENT_ATTEMPTS = '3'
require('dotenv').config()

const db = require('../src/shared/lib/knex')
const connection = require('../src/shared/lib/redis')
const { PaymentRepository } = require('../src/shared/repositories')
const services = require('../src/shared/services')
const gatewayService = services.gatewayService
const { enqueuePayment, paymentQueue, jobIdFor } = require('../queue/retryQueue')
const { createPaymentWorker } = require('../queue/paymentProcessor')
const { GatewayError } = require('../src/shared/utils')

const log = (ok, msg) => console.log((ok ? 'PASS' : 'FAIL') + '  ' + msg)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const realCharge = gatewayService.charge.bind(gatewayService)

const mkPayment = async () => PaymentRepository.create({
  idempotencyKey: 'step9-' + Math.random().toString(36).slice(2),
  amount: 7700,
  currency: 'INR',
  maxAttempts: 3
})

const waitForStatus = async (id, statuses, timeoutMs = 8000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const row = await PaymentRepository.findById(id)
    if (row && statuses.includes(row.status)) return row
    await sleep(50)
  }
  return PaymentRepository.findById(id)
}

async function main () {
  const worker = createPaymentWorker({ concurrency: 5 })
  await worker.waitUntilReady()
  const ids = []

  try {
    // 1. Always retriable → grows → FAILED after max attempts
    const callTimes = []
    gatewayService.charge = async () => { callTimes.push(Date.now()); throw new GatewayError('timeout', { retriable: true }) }
    const p1 = await mkPayment(); ids.push(p1.id)
    await enqueuePayment(p1.id)
    const row1 = await waitForStatus(p1.id, ['FAILED', 'SUCCESS'])
    log(callTimes.length === 3, `retry: exactly 3 gateway attempts (${callTimes.length})`)
    log(row1.status === 'FAILED', `retry: final status FAILED (${row1.status})`)
    log(row1.attempts === 3, `retry: DB attempts = 3 (${row1.attempts})`)
    log(/exhausted/.test(row1.last_error || ''), `retry: last_error notes exhaustion (${row1.last_error})`)
    if (callTimes.length === 3) {
      const gap1 = callTimes[1] - callTimes[0]
      const gap2 = callTimes[2] - callTimes[1]
      log(gap2 > gap1, `retry: delay grows (gap1=${gap1}ms < gap2=${gap2}ms)`)
    } else {
      log(false, 'retry: cannot measure gaps (wrong attempt count)')
    }

    // 2. Non-retriable → immediate FAILED, one call
    let declineCalls = 0
    gatewayService.charge = async () => { declineCalls++; throw new GatewayError('card_declined', { retriable: false }) }
    const p2 = await mkPayment(); ids.push(p2.id)
    await enqueuePayment(p2.id)
    const row2 = await waitForStatus(p2.id, ['FAILED', 'SUCCESS'])
    log(row2.status === 'FAILED', `non-retriable: FAILED (${row2.status})`)
    log(row2.attempts === 1, `non-retriable: attempts = 1, no retries (${row2.attempts})`)
    log(declineCalls === 1, `non-retriable: exactly 1 gateway call (${declineCalls})`)

    // 3. Success
    gatewayService.charge = async () => ({ success: true, providerRef: 'gw_step9_ok' })
    const p3 = await mkPayment(); ids.push(p3.id)
    await enqueuePayment(p3.id)
    const row3 = await waitForStatus(p3.id, ['SUCCESS', 'FAILED'])
    log(row3.status === 'SUCCESS', `success: SUCCESS (${row3.status})`)
    log(row3.provider_ref === 'gw_step9_ok', `success: provider_ref set (${row3.provider_ref})`)
  } finally {
    gatewayService.charge = realCharge
    for (const id of ids) {
      const job = await paymentQueue.getJob(jobIdFor(id))
      if (job) await job.remove().catch(() => {})
    }
    if (ids.length) await db('payments').whereIn('id', ids).del()
    await worker.close()
    await paymentQueue.close()
    await db.destroy()
    await connection.quit()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
