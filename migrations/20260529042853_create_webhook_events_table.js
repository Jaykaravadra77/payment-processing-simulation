'use strict'

exports.up = (knex) => knex.schema.createTable('webhook_events', (t) => {
  t.increments('id').primary()
  t.string('event_id', 255).notNullable().unique() // dedup key — DB enforces no double processing
  t.integer('payment_id').unsigned().notNullable().references('id').inTable('payments').onDelete('CASCADE')
  t.enum('status', ['received', 'processed', 'ignored']).notNullable().defaultTo('received')
  t.json('payload').nullable() // raw webhook body for audit/debug
  t.datetime('processed_at').nullable()
  t.timestamps(true, true)
})

exports.down = (knex) => knex.schema.dropTable('webhook_events')
