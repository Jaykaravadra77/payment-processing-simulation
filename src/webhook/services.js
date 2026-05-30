'use strict'

const { PaymentRepository, WebhookEventRepository } = require('../shared/repositories')
const { ePaymentStatus, eWebhookStatus } = require('../shared/models')
const { canTransition } = require('../shared/lib/stateMachine')
const logger = require('../shared/lib/logger')

const { SUCCESS } = ePaymentStatus.description
const { RECEIVED, PROCESSED, IGNORED } = eWebhookStatus.description

// handleWebhook — consume a provider callback and converge the payment to its
// final state. The whole thing runs in ONE transaction so the dedup-insert, the
// row lock, the transition and the event bookkeeping commit atomically.
//
// A webhook applies a *state-machine transition*, never a blind overwrite. Because
// SUCCESS/FAILED are terminal, the arrival order (our worker vs. this callback)
// can't corrupt a finished payment — the three nasty cases all resolve safely:
//   - duplicate   → event_id UNIQUE rejects the re-insert → ack & ignore
//   - early       → legal transition applies now; the worker's later settle no-ops
//   - conflicting → state machine refuses the illegal move; payment unchanged
async function handleWebhook ({ eventId, paymentId, status, providerRef, payload }) {
  return PaymentRepository.transaction(async (trx) => {
    // 1. Lock the payment row first — serializes this callback against our
    //    worker's _settle and any other concurrent callback for the same payment.
    //    It also has to come before the event insert: webhook_events.payment_id is
    //    a FK to payments.id, so an unknown payment can't even be recorded — we just
    //    ack and drop it.
    const row = await PaymentRepository.findByIdForUpdate(paymentId, trx)
    if (!row) {
      logger.warn({ paymentId, eventId }, 'webhook: unknown payment, ignoring')
      return { outcome: 'unknown_payment' }
    }

    // 2. Dedup on event_id. A repeated callback never gets processed twice.
    const ins = await WebhookEventRepository.insertUnique(
      { eventId, paymentId, status: RECEIVED, payload }, trx)
    if (ins.duplicate) {
      logger.info({ paymentId, eventId }, 'webhook: duplicate event, ignoring')
      return { outcome: 'duplicate' }
    }

    const target = status // 'SUCCESS' | 'FAILED' — already match ePaymentStatus

    // 3a. Already settled in the reported state → idempotent convergence, no-op.
    if (row.status === target) {
      await WebhookEventRepository.markProcessed(ins.id, IGNORED, trx)
      logger.info({ paymentId, eventId, status: target }, 'webhook: already in target state')
      return { outcome: 'already_in_state', status: row.status }
    }

    // 3b. Illegal move (e.g. already SUCCESS, callback says FAILED) → conflict.
    if (!canTransition(row.status, target)) {
      await WebhookEventRepository.markProcessed(ins.id, IGNORED, trx)
      logger.warn({ paymentId, from: row.status, to: target, eventId },
        'webhook: conflicting callback refused by state machine')
      return { outcome: 'conflict', from: row.status, to: target, status: row.status }
    }

    // 3c. Legal → apply the transition.
    const extra = target === SUCCESS
      ? { provider_ref: providerRef || row.provider_ref, last_error: null }
      : { last_error: 'failed via provider webhook' }
    await PaymentRepository.updateStatus(paymentId, target, extra, trx)
    await WebhookEventRepository.markProcessed(ins.id, PROCESSED, trx)
    logger.info({ paymentId, from: row.status, to: target, eventId }, 'webhook: applied')
    return { outcome: 'applied', status: target }
  })
}

module.exports = { handleWebhook }
