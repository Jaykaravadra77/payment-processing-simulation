'use strict'

const IORedis = require('ioredis')
const config = require('../../../config')

// Single shared Redis connection for BullMQ (producer here + worker in Step 9).
// maxRetriesPerRequest: null is required by BullMQ's blocking commands.
const connection = new IORedis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  maxRetriesPerRequest: null
})

module.exports = connection
