'use strict'

const S = require('fluent-json-schema')

const paymentResponse = S.object()
  .prop('id', S.integer())
  .prop('status', S.string())
  .prop('amount', S.integer())
  .prop('currency', S.string())
  .prop('attempts', S.integer())

const successEnvelope = (code) => S.object()
  .prop('success', S.boolean())
  .prop('message', S.string())
  .prop('data', paymentResponse)

const initiatePaymentSchema = {
  description: 'Initiate a payment. Idempotent on the Idempotency-Key header.',
  tags: ['Payments'],
  headers: S.object()
    .prop('idempotency-key', S.string().minLength(1))
    .required(['idempotency-key']),
  body: S.object()
    .prop('amount', S.integer().minimum(1))
    .prop('currency', S.string().minLength(3).maxLength(3))
    .required(['amount', 'currency'])
    .additionalProperties(false),
  response: {
    201: successEnvelope(201),
    200: successEnvelope(200)
  }
}

module.exports = { initiatePaymentSchema }
