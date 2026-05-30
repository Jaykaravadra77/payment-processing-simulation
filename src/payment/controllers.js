'use strict'

const { initiatePayment: initiatePaymentService } = require('./services')

const shape = (p) => ({
  id: p.id,
  status: p.status,
  amount: Number(p.amount),
  currency: p.currency,
  attempts: p.attempts
})

async function initiatePayment (request, reply) {
  const idempotencyKey = request.headers['idempotency-key']
  const { amount, currency } = request.body

  const { payment, created } = await initiatePaymentService({ idempotencyKey, amount, currency })

  request.log.info({ paymentId: payment.id, created }, 'payment initiated')

  return reply.success({
    data: shape(payment),
    message: created ? 'Payment created' : 'Payment already exists',
    statusCode: created ? 201 : 200
  })
}

module.exports = { initiatePayment }
