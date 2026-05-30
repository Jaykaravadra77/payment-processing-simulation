'use strict'

const { initiatePayment } = require('./controllers')
const { initiatePaymentSchema } = require('./schema')

module.exports = function (fastify, opts, done) {
  fastify.post('/', { schema: initiatePaymentSchema }, initiatePayment)

  done()
}
