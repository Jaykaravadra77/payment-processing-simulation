'use strict'

const db = require('../../lib/knex')
const { ePaymentStatus } = require('../../models')

const TABLE = 'payments'

class PaymentRepository {
  // Pick the connection: a passed-in transaction, or the shared pool.
  _q (trx) {
    return (trx || db)(TABLE)
  }

  // INSERT a new payment. Lets a duplicate idempotency_key error bubble up so
  // the caller (Step 7) can return the existing payment instead.
  async create ({ idempotencyKey, amount, currency, maxAttempts }, trx) {
    const [id] = await this._q(trx).insert({
      idempotency_key: idempotencyKey,
      amount,
      currency,
      status: ePaymentStatus.description.PENDING,
      attempts: 0,
      max_attempts: maxAttempts
    })
    return this.findById(id, trx)
  }

  async findById (id, trx) {
    return this._q(trx).where({ id }).first()
  }

  async findByIdempotencyKey (idempotencyKey, trx) {
    return this._q(trx).where({ idempotency_key: idempotencyKey }).first()
  }

  // The concurrency primitive: lock the row for the life of the transaction so a
  // second worker blocks here until we COMMIT. MUST be called inside a transaction.
  async findByIdForUpdate (id, trx) {
    return this._q(trx).where({ id }).forUpdate().first()
  }

  // Raw status write. Legality of the move is the service's job (state machine, Step 4).
  async updateStatus (id, status, extra = {}, trx) {
    return this._q(trx).where({ id }).update({
      status,
      ...extra,
      updated_at: db.fn.now()
    })
  }

  async incrementAttempts (id, trx) {
    return this._q(trx).where({ id }).increment('attempts', 1)
  }

  // Payments stuck in PROCESSING past the stale threshold — crash recovery (Step 11).
  async findStale (olderThanMs, trx) {
    const cutoff = new Date(Date.now() - olderThanMs)
    return this._q(trx)
      .where({ status: ePaymentStatus.description.PROCESSING })
      .andWhere('processing_started_at', '<', cutoff)
  }

  // Open a transaction without the caller importing knex directly.
  async transaction (fn) {
    return db.transaction(fn)
  }
}

module.exports = new PaymentRepository()
