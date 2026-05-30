'use strict'

const fp = require('fastify-plugin')
const db = require('../src/shared/lib/knex')

module.exports = fp(async (fastify) => {
  await db.raw('SELECT 1')
  fastify.log.info('DB connected')

  fastify.decorate('db', db)

  fastify.addHook('onClose', async () => {
    await db.destroy()
    fastify.log.info('DB connection pool closed')
  })
})
