'use strict'

require('dotenv').config()
const db = require('../src/shared/lib/knex')
const { PaymentRepository, WebhookEventRepository } = require('../src/shared/repositories')
const { isDuplicateKeyError } = require('../src/shared/utils')

const log = (ok, msg) => console.log((ok ? 'PASS' : 'FAIL') + '  ' + msg)

async function main () {
  const key = 'verify-step5-' + Date.now()
  const eventId = 'evt-step5-' + Date.now()
  let paymentId

  try {
    // 1. create
    const p = await PaymentRepository.create({ idempotencyKey: key, amount: 5000, currency: 'INR', maxAttempts: 3 })
    paymentId = p.id
    log(p && p.status === 'PENDING' && p.attempts === 0, `create() → id=${p.id} status=${p.status} attempts=${p.attempts}`)

    // 2. lookups
    const byKey = await PaymentRepository.findByIdempotencyKey(key)
    const byId = await PaymentRepository.findById(paymentId)
    log(byKey.id === paymentId && byId.id === paymentId, 'findByIdempotencyKey() and findById() match')

    // 3. duplicate idempotency key
    try {
      await PaymentRepository.create({ idempotencyKey: key, amount: 1, currency: 'INR', maxAttempts: 3 })
      log(false, 'duplicate create did NOT throw')
    } catch (err) {
      log(isDuplicateKeyError(err), 'duplicate create throws + isDuplicateKeyError===true')
    }

    // 4. FOR UPDATE inside a transaction
    const locked = await PaymentRepository.transaction(trx => PaymentRepository.findByIdForUpdate(paymentId, trx))
    log(locked && locked.id === paymentId, 'transaction(findByIdForUpdate) returns locked row')

    // 5. updateStatus → findStale
    await PaymentRepository.updateStatus(paymentId, 'PROCESSING', { processing_started_at: new Date(Date.now() - 1000) })
    const stale = await PaymentRepository.findStale(0)
    log(stale.some(r => r.id === paymentId), `findStale(0) includes the PROCESSING row (count=${stale.length})`)

    // 6. webhook dedup
    const w1 = await WebhookEventRepository.insertUnique({ eventId, paymentId, payload: { foo: 'bar' } })
    const w2 = await WebhookEventRepository.insertUnique({ eventId, paymentId, payload: { foo: 'bar' } })
    log(w1.duplicate === false && w2.duplicate === true, `insertUnique twice → first duplicate=${w1.duplicate}, second duplicate=${w2.duplicate}`)
  } finally {
    // cleanup
    await db('webhook_events').where({ event_id: eventId }).del()
    if (paymentId) await db('payments').where({ id: paymentId }).del()
    await db.destroy()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
