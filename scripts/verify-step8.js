'use strict'

require('dotenv').config()
const db = require('../src/shared/lib/knex')
const { PaymentRepository } = require('../src/shared/repositories')
const services = require('../src/shared/services')
const gatewayService = services.gatewayService
const { paymentService } = services
const { GatewayError } = require('../src/shared/utils')

const log = (ok, msg) => console.log((ok ? 'PASS' : 'FAIL') + '  ' + msg)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const realCharge = gatewayService.charge.bind(gatewayService)
let chargeCalls = 0
// Stub the gateway so each test controls the outcome and we can count calls.
const stub = (impl) => { gatewayService.charge = async (...a) => { chargeCalls++; return impl(...a) } }

const mkPayment = async ({ maxAttempts = 3, attempts = 0 } = {}) => {
  const p = await PaymentRepository.create({
    idempotencyKey: 'step8-' + Math.random().toString(36).slice(2),
    amount: 4200,
    currency: 'INR',
    maxAttempts
  })
  if (attempts) await db('payments').where({ id: p.id }).update({ attempts })
  return p.id
}

async function main () {
  const ids = []
  try {
    // 1. Success
    chargeCalls = 0
    stub(async () => ({ success: true, providerRef: 'gw_ok_1' }))
    const id1 = await mkPayment(); ids.push(id1)
    const r1 = await paymentService.process(id1)
    const row1 = await PaymentRepository.findById(id1)
    log(r1.outcome === 'success' && row1.status === 'SUCCESS', `success: outcome=${r1.outcome} status=${row1.status}`)
    log(row1.provider_ref === 'gw_ok_1', `success: provider_ref set (${row1.provider_ref})`)
    log(row1.attempts === 1, `success: attempts=1 (${row1.attempts})`)
    log(chargeCalls === 1, `success: exactly 1 gateway call (${chargeCalls})`)

    // 2. Concurrency showpiece — two parallel process() on one payment
    chargeCalls = 0
    stub(async () => { await sleep(150); return { success: true, providerRef: 'gw_ok_2' } })
    const id2 = await mkPayment(); ids.push(id2)
    const [a, b] = await Promise.all([paymentService.process(id2), paymentService.process(id2)])
    const row2 = await PaymentRepository.findById(id2)
    const outcomes = [a.outcome, b.outcome].sort()
    log(chargeCalls === 1, `concurrency: exactly 1 gateway call across 2 parallel process() (${chargeCalls})`)
    log(row2.status === 'SUCCESS', `concurrency: final status SUCCESS (${row2.status})`)
    log(row2.attempts === 1, `concurrency: attempts incremented exactly once (${row2.attempts})`)
    log(outcomes[0] === 'not_claimable' && outcomes[1] === 'success', `concurrency: one claimed, one bailed (${outcomes.join(' + ')})`)

    // 3. Non-retriable failure → FAILED
    chargeCalls = 0
    stub(async () => { throw new GatewayError('card_declined', { retriable: false }) })
    const id3 = await mkPayment(); ids.push(id3)
    const r3 = await paymentService.process(id3)
    const row3 = await PaymentRepository.findById(id3)
    log(r3.outcome === 'failed' && row3.status === 'FAILED', `non-retriable: outcome=${r3.outcome} status=${row3.status}`)
    log(row3.last_error === 'card_declined', `non-retriable: last_error set (${row3.last_error})`)

    // 4. Retriable with attempts remaining → throws + row back to PENDING
    chargeCalls = 0
    stub(async () => { throw new GatewayError('timeout', { retriable: true }) })
    const id4 = await mkPayment({ maxAttempts: 3 }); ids.push(id4)
    let threw = false
    try { await paymentService.process(id4) } catch (e) { threw = e instanceof GatewayError && e.retriable }
    const row4 = await PaymentRepository.findById(id4)
    log(threw, 'retriable: process() threw a retriable GatewayError')
    log(row4.status === 'PENDING', `retriable: row released back to PENDING (${row4.status})`)
    log(row4.last_error === 'timeout', `retriable: last_error recorded (${row4.last_error})`)

    // 5. Retriable but attempts exhausted → FAILED, no throw
    chargeCalls = 0
    stub(async () => { throw new GatewayError('timeout', { retriable: true }) })
    const id5 = await mkPayment({ maxAttempts: 3, attempts: 2 }); ids.push(id5) // becomes 3 after claim
    let threw5 = false
    let outcome5 = null
    try { outcome5 = (await paymentService.process(id5)).outcome } catch (e) { threw5 = true }
    const row5 = await PaymentRepository.findById(id5)
    log(!threw5 && outcome5 === 'failed' && row5.status === 'FAILED', `exhausted: outcome=${outcome5} status=${row5.status} (no throw=${!threw5})`)
    log(/max attempts exhausted/.test(row5.last_error || ''), `exhausted: last_error notes exhaustion (${row5.last_error})`)
  } finally {
    gatewayService.charge = realCharge
    if (ids.length) await db('payments').whereIn('id', ids).del()
    await db.destroy()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
