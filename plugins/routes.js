'use strict'

const fp = require('fastify-plugin')

module.exports = fp(async (fastify) => {
  fastify.get('/health', {
    schema: {
      description: 'Health check',
      tags: ['Health'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object' }
          }
        }
      }
    }
  }, async (request, reply) => {
    return reply.success({ message: 'Server is healthy', data: { uptime: process.uptime() } })
  })

  fastify.register(require('../src/payment/routes'), { prefix: '/api/payments' })
  fastify.register(require('../src/webhook/routes'), { prefix: '/api/webhooks' })
})
