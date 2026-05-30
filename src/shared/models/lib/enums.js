'use strict'

const enums = {
  ePaymentStatus: {
    value: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'],
    description: {
      PENDING: 'PENDING',
      PROCESSING: 'PROCESSING',
      SUCCESS: 'SUCCESS',
      FAILED: 'FAILED'
    },
    default: 'PENDING'
  },
  // webhook_events.status — tracks our handling of a callback, not the payment itself
  eWebhookStatus: {
    value: ['received', 'processed', 'ignored'],
    description: {
      RECEIVED: 'received',
      PROCESSED: 'processed',
      IGNORED: 'ignored'
    },
    default: 'received'
  }
}

module.exports = enums
