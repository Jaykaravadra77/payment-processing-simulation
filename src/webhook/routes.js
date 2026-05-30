'use strict'

const { handleWebhook } = require('./controllers')
const { webhookSchema } = require('./schema')

module.exports = function (fastify, opts, done) {
  fastify.post('/payment', { schema: webhookSchema }, handleWebhook)

  done()
}
