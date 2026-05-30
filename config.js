'use strict'

const dev = {
  PORT: process.env.PORT || 3000,

  DB_HOST: process.env.DB_HOST || '127.0.0.1',
  DB_PORT: Number(process.env.DB_PORT) || 3306,
  DB_NAME: process.env.DB_NAME || 'payment_db',
  DB_USER: process.env.DB_USER || 'root',
  DB_PASSWORD: process.env.DB_PASSWORD || 'secret',

  REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
  REDIS_PORT: Number(process.env.REDIS_PORT) || 6379,

  GATEWAY_SUCCESS_PROB: Number(process.env.GATEWAY_SUCCESS_PROB) || 0.6,
  GATEWAY_FAILURE_PROB: Number(process.env.GATEWAY_FAILURE_PROB) || 0.2,
  GATEWAY_DELAY_PROB: Number(process.env.GATEWAY_DELAY_PROB) || 0.1,
  GATEWAY_TIMEOUT_MS: Number(process.env.GATEWAY_TIMEOUT_MS) || 3000,

  MAX_PAYMENT_ATTEMPTS: Number(process.env.MAX_PAYMENT_ATTEMPTS) || 3,
  RETRY_BACKOFF_DELAY_MS: Number(process.env.RETRY_BACKOFF_DELAY_MS) || 5000,
  STALE_PROCESSING_MS: Number(process.env.STALE_PROCESSING_MS) || 60000,
  RECONCILE_INTERVAL_MS: Number(process.env.RECONCILE_INTERVAL_MS) || 30000
}

const production = {
  ...dev,
  PORT: process.env.PORT
}

switch (process.env.NODE_ENV) {
  case 'production':
    module.exports = production
    break
  default:
    module.exports = dev
}
