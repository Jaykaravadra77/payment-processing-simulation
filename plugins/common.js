'use strict'

const fp = require('fastify-plugin')
const cors = require('@fastify/cors')

module.exports = fp(async (fastify) => {
  fastify.register(cors)
  fastify.register(require('@fastify/formbody'))

  await fastify.register(require('@fastify/swagger'), {
    openapi: {
      info: {
        title: 'Payment Processing API',
        description: 'Payment lifecycle, idempotency, retry, and webhook handling',
        version: '1.0.0'
      }
    }
  })

  await fastify.register(require('@fastify/swagger-ui'), {
    routePrefix: '/documentation',
    uiConfig: { docExpansion: 'none' },
    staticCSP: false
  })
})
