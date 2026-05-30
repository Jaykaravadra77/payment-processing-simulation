'use strict'

const knex = require('knex')
const config = require('../../../config')

// Single shared connection pool, used by both the Fastify plugin (plugins/mysql.js)
// and the standalone worker/reconciler processes. One pool, not two.
const db = knex({
  client: 'mysql2',
  connection: {
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD
  },
  pool: { min: 2, max: 10 }
})

module.exports = db
