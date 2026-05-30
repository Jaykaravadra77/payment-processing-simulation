'use strict'

const { PaymentRepository } = require('../shared/repositories')
const { isDuplicateKeyError } = require('../shared/utils')
const { enqueuePayment } = require('../../queue/retryQueue')
const config = require('../../config')

// Idempotent payment creation. Relies on the DB UNIQUE index on idempotency_key:
// we attempt the insert and treat a duplicate-key error as "already exists".
// Returns { payment, created } — created=false means we returned an existing one.
async function initiatePayment ({ idempotencyKey, amount, currency }) {
  try {
    const payment = await PaymentRepository.create({
      idempotencyKey,
      amount,
      currency,
      maxAttempts: config.MAX_PAYMENT_ATTEMPTS
    })

    // First time we've seen this key — queue the background charge.
    // (jobId = paymentId dedups, so a retried request won't double-queue.)
    await enqueuePayment(payment.id)

    return { payment, created: true }
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const payment = await PaymentRepository.findByIdempotencyKey(idempotencyKey)
      return { payment, created: false }
    }
    throw err
  }
}

module.exports = { initiatePayment }
