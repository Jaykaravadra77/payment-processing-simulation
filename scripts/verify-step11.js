'use strict'

require('dotenv').config()

const db = require('../src/shared/lib/knex')
const connection = require('../src/shared/lib/redis')
const { PaymentRepository } = require('../src/shared/repositories')
const { paymentService } = require('../src/shared/services')
const { paymentQueue, jobIdFor } = require('../queue/retryQueue')
const { reconcileStale } = require('../queue/reconciler')
const config = require('../config')

const log = (ok, msg) => console.log((ok ? 'PASS' : 'FAIL') + '  ' + msg)
const rnd = () => Math.random().toString(36).slice(2)
const STALE = config.STALE_PROCESSING_MS

// Seed a payment directly into a chosen state, with processing_started_at aged by
// ageMs (so we can make it look stale or fresh) and a chosen attempts count.
const seed = async ({ status = 'PROCESSING', attempts = 1, ageMs = STALE + 5000 } = {}) => {
  const p = await PaymentRepository.create({
    idempotencyKey: 'step11-' + rnd(),
    amount: 4200,
    currency: 'INR',
    maxAttempts: 3
  })
  await db('payments').where({ id: p.id }).update({
    status,
    attempts,
    processing_started_at: new Date(Date.now() - ageMs)
  })
  return p.id
}

async function main () {
  const ids = []
  try {
    // 1. Stale + attempts left → released back to PENDING, lock cleared.
    const id1 = await seed({ attempts: 1 }); ids.push(id1)
    const r1 = await paymentService.recoverStalePayment(id1)
    const row1 = await PaymentRepository.findById(id1)
    log(r1.action === 'released' && row1.status === 'PENDING', `stale+attempts-left: action=${r1.action} status=${row1.status}`)
    log(row1.processing_started_at === null, `stale+attempts-left: processing_started_at cleared (${row1.processing_started_at})`)

    // 2. Stale + attempts exhausted → terminal FAILED, no retry.
    const id2 = await seed({ attempts: 3 }); ids.push(id2)
    const r2 = await paymentService.recoverStalePayment(id2)
    const row2 = await PaymentRepository.findById(id2)
    log(r2.action === 'failed' && row2.status === 'FAILED', `stale+exhausted: action=${r2.action} status=${row2.status}`)
    log(/attempts exhausted/.test(row2.last_error || ''), `stale+exhausted: last_error notes exhaustion (${row2.last_error})`)

    // 3. PROCESSING but NOT stale → findStale must exclude it.
    const id3 = await seed({ attempts: 1, ageMs: 1000 }); ids.push(id3)
    const staleIds = (await PaymentRepository.findStale(STALE)).map(r => r.id)
    log(!staleIds.includes(id3), `fresh-processing: excluded from findStale (id3=${id3} present=${staleIds.includes(id3)})`)

    // 4. Already terminal (SUCCESS) with an old timestamp → findStale matches only PROCESSING.
    const id4 = await seed({ status: 'SUCCESS', attempts: 1 }); ids.push(id4)
    const staleIds4 = (await PaymentRepository.findStale(STALE)).map(r => r.id)
    const row4 = await PaymentRepository.findById(id4)
    log(!staleIds4.includes(id4) && row4.status === 'SUCCESS', `terminal: SUCCESS untouched, excluded from findStale (status=${row4.status})`)

    // 5. Full sweep: two fresh stale rows → both recovered + a job enqueued for each.
    const id5 = await seed({ attempts: 1 }); ids.push(id5)
    const id6 = await seed({ attempts: 1 }); ids.push(id6)
    const sweep = await reconcileStale()
    const row5 = await PaymentRepository.findById(id5)
    const row6 = await PaymentRepository.findById(id6)
    log(sweep.swept >= 2, `sweep: swept count >= 2 (${sweep.swept})`)
    log(row5.status === 'PENDING' && row6.status === 'PENDING', `sweep: both released to PENDING (${row5.status}/${row6.status})`)
    const job5 = await paymentQueue.getJob(jobIdFor(id5))
    const job6 = await paymentQueue.getJob(jobIdFor(id6))
    log(Boolean(job5) && Boolean(job6), `sweep: a processing job exists for each (${Boolean(job5)}/${Boolean(job6)})`)
  } finally {
    for (const id of ids) {
      const job = await paymentQueue.getJob(jobIdFor(id))
      if (job) await job.remove().catch(() => {})
    }
    if (ids.length) await db('payments').whereIn('id', ids).del()
    await paymentQueue.close()
    await db.destroy()
    await connection.quit()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
