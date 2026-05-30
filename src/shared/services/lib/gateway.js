'use strict'

const config = require('../../../../config')
const { GatewayError } = require('../../utils')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const randomRef = () => 'gw_' + Math.random().toString(36).slice(2, 12)

// Fake payment provider. Each call randomly behaves like one of four real-world
// outcomes, weighted by the probabilities in config. This is the ONLY place
// failure/randomness is injected into the system.
class GatewayService {
  // Pick an outcome from the configured probability bands.
  _pickOutcome () {
    const { GATEWAY_SUCCESS_PROB: s, GATEWAY_FAILURE_PROB: f, GATEWAY_DELAY_PROB: d } = config
    const roll = Math.random()
    if (roll < s) return 'success'
    if (roll < s + f) return 'failure'
    if (roll < s + f + d) return 'delay'
    return 'timeout'
  }

  // The actual "talk to the provider" work, before the timeout guard.
  async _attempt ({ paymentId }) {
    const outcome = this._pickOutcome()

    switch (outcome) {
      case 'success':
        return { success: true, providerRef: randomRef(), outcome }

      case 'failure':
        // Hard decline — retrying will never help.
        throw new GatewayError('card_declined', { retriable: false })

      case 'delay': {
        // Slow but answers within the timeout window → still succeeds.
        const ms = Math.floor(Math.random() * (config.GATEWAY_TIMEOUT_MS * 0.6))
        await sleep(ms)
        return { success: true, providerRef: randomRef(), outcome }
      }

      case 'timeout':
      default:
        // Hang past the timeout so the guard below fires.
        await sleep(config.GATEWAY_TIMEOUT_MS + 500)
        return { success: true, providerRef: randomRef(), outcome }
    }
  }

  // Public API: charge a payment. Wraps _attempt in a timeout guard so a hung
  // provider can never freeze a worker — it rejects as a retriable timeout.
  async charge ({ paymentId, amount, currency } = {}) {
    let timer
    const timeoutGuard = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new GatewayError('timeout', { retriable: true }))
      }, config.GATEWAY_TIMEOUT_MS)
    })

    try {
      return await Promise.race([this._attempt({ paymentId, amount, currency }), timeoutGuard])
    } finally {
      clearTimeout(timer)
    }
  }
}

module.exports = new GatewayService()
