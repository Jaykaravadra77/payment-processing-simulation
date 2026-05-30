'use strict'

const S = require('fluent-json-schema')

// The status a provider reports in a callback is always a final outcome.
const webhookResult = S.object()
  .prop('paymentId', S.integer())
  .prop('outcome', S.string())
  .prop('status', S.string())

const successEnvelope = S.object()
  .prop('success', S.boolean())
  .prop('message', S.string())
  .prop('data', webhookResult)

const webhookSchema = {
  description: 'Provider payment callback. Idempotent on eventId; applies a state-machine transition (never a blind overwrite).',
  tags: ['Webhooks'],
  body: S.object()
    .prop('eventId', S.string().minLength(1))
    .prop('paymentId', S.integer().minimum(1))
    .prop('status', S.string().enum(['SUCCESS', 'FAILED']))
    .prop('providerRef', S.string())
    .required(['eventId', 'paymentId', 'status'])
    .additionalProperties(false),
  response: {
    200: successEnvelope
  }
}

module.exports = { webhookSchema }
