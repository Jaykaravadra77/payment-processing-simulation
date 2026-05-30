'use strict'

exports.up = (knex) => knex.schema.createTable('payments', (t) => {
  t.increments('id').primary()
  t.string('idempotency_key', 255).notNullable().unique()
  t.bigInteger('amount').notNullable() // minor units (e.g. paise, cents)
  t.string('currency', 3).notNullable()
  t.enum('status', ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED']).notNullable().defaultTo('PENDING')
  t.integer('attempts').notNullable().defaultTo(0)
  t.integer('max_attempts').notNullable().defaultTo(3)
  t.string('provider_ref', 255).nullable() // reference id returned by gateway
  t.text('last_error').nullable() // last failure reason
  t.datetime('processing_started_at').nullable() // used to detect stale locks (Step 11)
  t.timestamps(true, true) // created_at, updated_at
})

exports.down = (knex) => knex.schema.dropTable('payments')
