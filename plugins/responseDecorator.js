'use strict'

const fp = require('fastify-plugin')

module.exports = fp(async (fastify) => {
  fastify.decorateReply('success', function ({ data = null, message = 'Success', statusCode = 200 } = {}) {
    return this.code(statusCode).send({ success: true, message, data })
  })

  fastify.decorateReply('error', function ({ message = 'Something went wrong', statusCode = 500 } = {}) {
    return this.code(statusCode).send({ success: false, message })
  })
})
