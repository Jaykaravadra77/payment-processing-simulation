'use strict'

require('dotenv').config()
const config = require('./config')

module.exports = {
  development: {
    client: 'mysql2',
    connection: {
      host: config.DB_HOST,
      port: config.DB_PORT,
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD
    },
    migrations: {
      directory: './migrations'
    },
    pool: { min: 2, max: 10 }
  },
  production: {
    client: 'mysql2',
    connection: {
      host: config.DB_HOST,
      port: config.DB_PORT,
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD
    },
    migrations: {
      directory: './migrations'
    },
    pool: { min: 2, max: 20 }
  }
}
