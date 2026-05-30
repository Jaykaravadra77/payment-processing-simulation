'use strict'

// Error thrown by the gateway simulator. The `retriable` flag is the key signal
// the retry layer (Step 9) reads: retriable (timeout/transient) → reschedule;
// non-retriable (hard decline) → fail the payment immediately.
class GatewayError extends Error {
  constructor (reason, { retriable = false } = {}) {
    super(reason)
    this.name = 'GatewayError'
    this.reason = reason
    this.retriable = retriable
  }
}

module.exports = GatewayError
