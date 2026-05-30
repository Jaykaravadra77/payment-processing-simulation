'use strict'

require('dotenv').config()
const db = require('../src/shared/lib/knex')
const { PaymentRepository } = require('../src/shared/repositories')
const { handleWebhook } = require('../src/webhook/services')

const log = (ok, msg) => console.log((ok ? 'PASS' : 'FAIL') + '  ' + msg)
const rnd = () => Math.random().toString(36).slice(2)

const mkPayment = async () => {
  const p = await PaymentRepository.create({
    idempotencyKey: 'step10-' + rnd(),
    amount: 4200,
    currency: 'INR',
    maxAttempts: 3
  })
  return p.id
}
const eventRows = (paymentId) => db('webhook_events').where({ payment_id: paymentId })

async function main () {
  const ids = []
  const eventIds = []
  try {
    // 1. Happy webhook — fresh event settles a PENDING payment to SUCCESS.
    const id1 = await mkPayment(); ids.push(id1)
    const ev1 = 'evt-' + rnd(); eventIds.push(ev1)
    const r1 = await handleWebhook({ eventId: ev1, paymentId: id1, status: 'SUCCESS', providerRef: 'gw_wh_1' })
    const row1 = await PaymentRepository.findById(id1)
    log(r1.outcome === 'applied' && row1.status === 'SUCCESS', `happy: outcome=${r1.outcome} status=${row1.status}`)
    log(row1.provider_ref === 'gw_wh_1', `happy: provider_ref stored (${row1.provider_ref})`)
    const ws1 = await eventRows(id1)
    log(ws1.length === 1 && ws1[0].status === 'processed', `happy: one event row, status=processed (${ws1.length}/${ws1[0] && ws1[0].status})`)

    // 2. Duplicate — same eventId again → ignored, no second row, payment unchanged.
    const r2 = await handleWebhook({ eventId: ev1, paymentId: id1, status: 'SUCCESS', providerRef: 'gw_wh_1' })
    const ws2 = await eventRows(id1)
    log(r2.outcome === 'duplicate', `duplicate: outcome=${r2.outcome}`)
    log(ws2.length === 1, `duplicate: still exactly one event row (${ws2.length})`)

    // 3. Conflicting — new event says FAILED on an already-SUCCESS payment → refused.
    const ev3 = 'evt-' + rnd(); eventIds.push(ev3)
    const r3 = await handleWebhook({ eventId: ev3, paymentId: id1, status: 'FAILED' })
    const row3 = await PaymentRepository.findById(id1)
    log(r3.outcome === 'conflict' && row3.status === 'SUCCESS', `conflict: outcome=${r3.outcome}, payment stays ${row3.status}`)
    const ws3 = await eventRows(id1)
    const conflictRow = ws3.find(r => r.event_id === ev3)
    log(conflictRow && conflictRow.status === 'ignored', `conflict: event marked ignored (${conflictRow && conflictRow.status})`)

    // 4. Early — webhook beats the worker; payment still PENDING settles to SUCCESS.
    const id4 = await mkPayment(); ids.push(id4)
    const before4 = await PaymentRepository.findById(id4)
    const ev4 = 'evt-' + rnd(); eventIds.push(ev4)
    const r4 = await handleWebhook({ eventId: ev4, paymentId: id4, status: 'SUCCESS', providerRef: 'gw_wh_4' })
    const row4 = await PaymentRepository.findById(id4)
    log(before4.status === 'PENDING' && r4.outcome === 'applied' && row4.status === 'SUCCESS',
      `early: PENDING(${before4.status}) -> ${row4.status} via webhook (outcome=${r4.outcome})`)

    // 5. Idempotent convergence — a second, different event reporting the same SUCCESS.
    const ev5 = 'evt-' + rnd(); eventIds.push(ev5)
    const r5 = await handleWebhook({ eventId: ev5, paymentId: id4, status: 'SUCCESS' })
    log(r5.outcome === 'already_in_state', `already_in_state: outcome=${r5.outcome}`)

    // 6. Unknown payment — non-existent id → ignored, HTTP-level still acks.
    const ev6 = 'evt-' + rnd(); eventIds.push(ev6)
    const r6 = await handleWebhook({ eventId: ev6, paymentId: 999999999, status: 'SUCCESS' })
    log(r6.outcome === 'unknown_payment', `unknown_payment: outcome=${r6.outcome}`)
  } finally {
    if (eventIds.length) await db('webhook_events').whereIn('event_id', eventIds).del()
    if (ids.length) await db('payments').whereIn('id', ids).del()
    await db.destroy()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
