'use strict'

const { ePaymentStatus } = require('../models')
const APIError = require('../utils/APIError')

const { PENDING, PROCESSING, SUCCESS, FAILED } = ePaymentStatus.description

// Legal status transitions. SUCCESS and FAILED are terminal (empty arrays) —
// once a payment settles, nothing is allowed to change it. This single rule
// blocks late/duplicate/conflicting events from corrupting a finished payment.
// PROCESSING -> PENDING is the "release for retry" move: a retriable gateway
// failure (e.g. timeout) hands the payment back to PENDING so a later attempt
// can re-claim it. SUCCESS/FAILED remain terminal regardless.
// PENDING -> SUCCESS exists for the "truly early" webhook: a provider-authoritative
// SUCCESS callback can beat our worker's claim and settle the payment directly;
// the worker's later settle then sees a terminal state and no-ops (convergence).
const transitions = {
  [PENDING]: [PROCESSING, SUCCESS, FAILED],
  [PROCESSING]: [SUCCESS, FAILED, PENDING],
  [SUCCESS]: [],
  [FAILED]: []
}

/**
 * Whether `from` → `to` is a legal move. Self-transitions and unknown
 * statuses return false.
 */
function canTransition (from, to) {
  const allowed = transitions[from]
  if (!allowed) return false
  return allowed.includes(to)
}

/**
 * A status no payment can ever leave (SUCCESS / FAILED).
 */
function isTerminal (status) {
  return transitions[status] !== undefined && transitions[status].length === 0
}

/**
 * Hard guard for services that want to fail loudly on an illegal move.
 * Throws an APIError (409 Conflict) the central error handler turns into JSON.
 */
function assertTransition (from, to) {
  if (!canTransition(from, to)) {
    throw new APIError(`Illegal payment transition: ${from} -> ${to}`, 409)
  }
}

module.exports = {
  transitions,
  canTransition,
  isTerminal,
  assertTransition
}
