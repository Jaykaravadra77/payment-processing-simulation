'use strict'

// Use a short timeout so the test runs fast (real default is 3000ms).
process.env.GATEWAY_TIMEOUT_MS = '200'
require('dotenv').config()

const { gatewayService } = require('../src/shared/services')
const { GatewayError } = require('../src/shared/utils')

const log = (ok, msg) => console.log((ok ? 'PASS' : 'FAIL') + '  ' + msg)

async function main () {
  const tally = { success: 0, delayedSuccess: 0, hardDecline: 0, timeout: 0 }
  let maxTimeoutMs = 0
  const N = 80

  for (let i = 0; i < N; i++) {
    const start = Date.now()
    try {
      const res = await gatewayService.charge({ paymentId: i, amount: 100, currency: 'INR' })
      if (res.outcome === 'delay') tally.delayedSuccess++
      else tally.success++
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err
      if (err.reason === 'timeout') {
        tally.timeout++
        maxTimeoutMs = Math.max(maxTimeoutMs, Date.now() - start)
        if (err.retriable !== true) log(false, 'timeout error must be retriable=true')
      } else if (err.reason === 'card_declined') {
        tally.hardDecline++
        if (err.retriable !== false) log(false, 'hard decline must be retriable=false')
      }
    }
  }

  console.log('outcomes over', N, 'calls:', tally)

  log(tally.success > 0, `success occurred (${tally.success})`)
  log(tally.delayedSuccess > 0, `delayed-success occurred (${tally.delayedSuccess})`)
  log(tally.hardDecline > 0, `hard-decline occurred (${tally.hardDecline})`)
  log(tally.timeout > 0, `timeout occurred (${tally.timeout})`)
  log(maxTimeoutMs > 0 && maxTimeoutMs < 200 + 150, `timeouts rejected within guard window (max ${maxTimeoutMs}ms, limit 200ms)`)
}

main().catch(err => { console.error(err); process.exit(1) })
