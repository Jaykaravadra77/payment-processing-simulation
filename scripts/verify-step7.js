'use strict'

require('dotenv').config()
const db = require('../src/shared/lib/knex')
const connection = require('../src/shared/lib/redis')
const { initiatePayment } = require('../src/payment/services')
const { paymentQueue, jobIdFor } = require('../queue/retryQueue')

const log = (ok, msg) => console.log((ok ? 'PASS' : 'FAIL') + '  ' + msg)
const countRows = async (key) => (await db('payments').where({ idempotency_key: key }).count('* as c'))[0].c

async function main () {
  const keyA = 'verify-step7-A-' + Date.now()
  const keyB = 'verify-step7-B-' + Date.now()
  const ids = []

  try {
    // 1. sequential same key → one row, same id, created flips to false
    const r1 = await initiatePayment({ idempotencyKey: keyA, amount: 5000, currency: 'INR' })
    const r2 = await initiatePayment({ idempotencyKey: keyA, amount: 5000, currency: 'INR' })
    ids.push(r1.payment.id)
    log(r1.created === true && r2.created === false, `sequential: first created=${r1.created}, second created=${r2.created}`)
    log(r1.payment.id === r2.payment.id, `sequential: same id (${r1.payment.id})`)
    log((await countRows(keyA)) === 1, `sequential: exactly 1 row for keyA (count=${await countRows(keyA)})`)

    // 2. 5 parallel same key → all same id, one row
    const parallel = await Promise.all(
      Array.from({ length: 5 }, () => initiatePayment({ idempotencyKey: keyB, amount: 999, currency: 'USD' }))
    )
    const uniqueIds = [...new Set(parallel.map(r => r.payment.id))]
    ids.push(uniqueIds[0])
    log(uniqueIds.length === 1, `parallel: all 5 resolved to one id (${uniqueIds.join(',')})`)
    log((await countRows(keyB)) === 1, `parallel: exactly 1 row for keyB (count=${await countRows(keyB)})`)
    const createdCount = parallel.filter(r => r.created).length
    log(createdCount === 1, `parallel: exactly one call created the row (created count=${createdCount})`)

    // 3. job dedup — one job per payment id
    const jobA = await paymentQueue.getJob(jobIdFor(r1.payment.id))
    const jobB = await paymentQueue.getJob(jobIdFor(uniqueIds[0]))
    log(Boolean(jobA) && jobA.data.paymentId === r1.payment.id, `queue: one job for keyA payment (jobId=${jobA && jobA.id})`)
    log(Boolean(jobB) && jobB.data.paymentId === uniqueIds[0], `queue: one job for keyB payment (jobId=${jobB && jobB.id})`)
  } finally {
    // cleanup queue jobs + rows
    for (const id of ids) {
      const job = await paymentQueue.getJob(jobIdFor(id))
      if (job) await job.remove()
    }
    await db('payments').whereIn('id', ids).del()
    await db.destroy()
    await paymentQueue.close()
    await connection.quit()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
