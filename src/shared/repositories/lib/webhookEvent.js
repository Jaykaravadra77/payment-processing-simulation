'use strict'

const db = require('../../lib/knex')
const { eWebhookStatus } = require('../../models')
const { isDuplicateKeyError } = require('../../utils')

const TABLE = 'webhook_events'

class WebhookEventRepository {
  _q (trx) {
    return (trx || db)(TABLE)
  }

  // Insert relying on the event_id UNIQUE index for dedup. If the same callback
  // arrives twice, the DB rejects the second insert and we report it as a duplicate
  // instead of processing it again.
  async insertUnique ({ eventId, paymentId, status = eWebhookStatus.description.RECEIVED, payload }, trx) {
    try {
      const [id] = await this._q(trx).insert({
        event_id: eventId,
        payment_id: paymentId,
        status,
        payload: payload ? JSON.stringify(payload) : null
      })
      return { duplicate: false, id }
    } catch (err) {
      if (isDuplicateKeyError(err)) return { duplicate: true }
      throw err
    }
  }

  async exists (eventId, trx) {
    const row = await this._q(trx).where({ event_id: eventId }).first()
    return Boolean(row)
  }

  async markProcessed (id, status, trx) {
    return this._q(trx).where({ id }).update({
      status,
      processed_at: db.fn.now(),
      updated_at: db.fn.now()
    })
  }
}

module.exports = new WebhookEventRepository()
