'use strict'

const pino = require('pino')

// Shared structured logger for code that runs outside a Fastify request
// (services, the worker, the reconciler). Lifecycle logs are tagged with
// paymentId so one id can be grepped across the whole payment story (Step 12).
const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug'
})

module.exports = logger
