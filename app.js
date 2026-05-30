'use strict'

const path = require('path')
const fastify = require('fastify')({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug'
  },
  trustProxy: true
})
const autoLoad = require('@fastify/autoload')
const helmet = require('@fastify/helmet')
const config = require('./config')

fastify.register(helmet, { contentSecurityPolicy: false })

fastify.register(autoLoad, {
  dir: path.join(__dirname, 'plugins')
})

fastify.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, 'request error')

  if (error.sMessageName) {
    return reply.error({ message: error.sMessageName, statusCode: error.statusCode || 500 })
  }

  if (error.validation) {
    return reply.error({ message: error.message, statusCode: 400 })
  }

  return reply.error({ message: 'Internal Server Error', statusCode: 500 })
})

fastify.listen({ port: config.PORT || 3000, host: '0.0.0.0' }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  console.log(`Server running on port ${config.PORT || 3000}`)
})

module.exports = fastify
