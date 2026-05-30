'use strict'

const { handleWebhook: handleWebhookService } = require('./services')

// Human-readable line per outcome, for the ack body.
const messages = {
  duplicate: 'Duplicate event ignored',
  unknown_payment: 'Unknown payment ignored',
  already_in_state: 'Payment already in reported state',
  conflict: 'Conflicting callback refused',
  applied: 'Payment status updated'
}

async function handleWebhook (request, reply) {
  const { eventId, paymentId, status, providerRef } = request.body

  const result = await handleWebhookService({
    eventId,
    paymentId,
    status,
    providerRef,
    payload: request.body
  })

  request.log.info({ paymentId, eventId, outcome: result.outcome }, 'webhook processed')

  // Always ack 200 for a well-formed callback so the provider stops retrying —
  // duplicate/conflict/unknown are not something a retry would fix.
  return reply.success({
    data: { paymentId, outcome: result.outcome, status: result.status || null },
    message: messages[result.outcome] || 'Webhook processed'
  })
}

module.exports = { handleWebhook }
