'use strict'

const { PaymentRepository } = require('../../repositories')
const { ePaymentStatus } = require('../../models')
const { canTransition } = require('../../lib/stateMachine')
const logger = require('../../lib/logger')
const gatewayService = require('./gateway')
const { GatewayError } = require('../../utils')

const { PENDING, PROCESSING, SUCCESS, FAILED } = ePaymentStatus.description

// paymentService.process — the concurrency showpiece.
//
// Two-phase, lock NEVER held across the gateway call:
//   1) claim:  FOR UPDATE; only PENDING is claimable; flip -> PROCESSING (durable),
//              stamp processing_started_at, attempts++. Lock released on COMMIT.
//   2) charge: call the gateway with no lock held.
//   3) settle: FOR UPDATE again; apply the result via the state machine. If an
//              early webhook already settled it, no-op (convergence).
//
// Firing process() twice in parallel => only one wins the PENDING claim; the
// other reads PROCESSING and bails BEFORE charging => exactly one gateway call.
class PaymentService {
  async process (paymentId) {
    const claim = await this._claim(paymentId)
    if (!claim.claimed) {
      logger.info({ paymentId, reason: claim.reason, status: claim.status }, 'process: not claimable, bailing')
      return { outcome: 'not_claimable', reason: claim.reason, status: claim.status }
    }

    logger.info({ paymentId, attempts: claim.attempts }, 'process: claimed, calling gateway')

    let result
    let gwError
    try {
      result = await gatewayService.charge({
        paymentId,
        amount: claim.amount,
        currency: claim.currency
      })
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err
      gwError = err
    }

    const settled = await this._settle(paymentId, { result, gwError })

    // Release-for-retry: the PENDING write is already committed; throw now (outside
    // the transaction) so the Step 9 queue reschedules this payment.
    if (settled.outcome === 'retry') {
      logger.warn({ paymentId, reason: settled.reason }, 'process: retriable failure, released to PENDING for retry')
      throw new GatewayError(settled.reason, { retriable: true })
    }

    logger.info({ paymentId, outcome: settled.outcome, status: settled.status }, 'process: settled')
    return settled
  }

  // Defensive terminal-fail used by the worker when a job dies from an
  // unexpected (non-gateway) crash and leaves the row stuck. State-machine
  // guarded so we never clobber a payment that already reached SUCCESS.
  async failPayment (paymentId, reason) {
    return PaymentRepository.transaction(async (trx) => {
      const row = await PaymentRepository.findByIdForUpdate(paymentId, trx)
      if (!row) return { outcome: 'noop', reason: 'not_found' }
      if (!canTransition(row.status, FAILED)) {
        return { outcome: 'noop', reason: 'illegal_fail', status: row.status }
      }
      await PaymentRepository.updateStatus(paymentId, FAILED, { last_error: reason }, trx)
      return { outcome: 'failed', status: FAILED }
    })
  }

  // Crash recovery (Step 11). A payment stuck in PROCESSING past the stale threshold
  // means the worker that claimed it died mid-charge. process() only claims PENDING
  // rows, so we can't just re-enqueue — we have to release the stale lock first.
  // State-machine guarded and re-checked under the row lock so we never clobber a
  // payment the original (slow-but-alive) worker just settled.
  async recoverStalePayment (paymentId) {
    return PaymentRepository.transaction(async (trx) => {
      const row = await PaymentRepository.findByIdForUpdate(paymentId, trx)

      // The original worker may have settled it between the sweep's SELECT and this
      // lock (now SUCCESS/FAILED, or already released to PENDING) — leave it alone.
      if (!row || row.status !== PROCESSING) {
        return { action: 'skip', reason: 'not_processing', status: row && row.status }
      }

      // Attempts already exhausted → retrying is pointless, settle terminal FAILED.
      if (row.attempts >= row.max_attempts) {
        await PaymentRepository.updateStatus(
          paymentId, FAILED,
          { last_error: 'recovered: stuck in processing, attempts exhausted', processing_started_at: null },
          trx
        )
        return { action: 'failed', status: FAILED }
      }

      // Otherwise release the stale lock back to PENDING so a live worker re-claims it.
      await PaymentRepository.updateStatus(
        paymentId, PENDING,
        { last_error: 'recovered from stale processing', processing_started_at: null },
        trx
      )
      return { action: 'released', status: PENDING }
    })
  }

  // Phase 1 — atomically claim a PENDING payment.
  async _claim (paymentId) {
    return PaymentRepository.transaction(async (trx) => {
      const row = await PaymentRepository.findByIdForUpdate(paymentId, trx)
      if (!row) return { claimed: false, reason: 'not_found' }
      if (row.status !== PENDING) {
        return { claimed: false, reason: 'not_pending', status: row.status }
      }

      await PaymentRepository.updateStatus(paymentId, PROCESSING, { processing_started_at: new Date() }, trx)
      await PaymentRepository.incrementAttempts(paymentId, trx)

      return {
        claimed: true,
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts,
        amount: row.amount,
        currency: row.currency
      }
    })
  }

  // Phase 3 — apply the gateway result under a fresh lock, gated by the state machine.
  async _settle (paymentId, { result, gwError }) {
    return PaymentRepository.transaction(async (trx) => {
      const row = await PaymentRepository.findByIdForUpdate(paymentId, trx)

      // Something else (e.g. an early webhook) already moved it on — converge.
      if (!row || row.status !== PROCESSING) {
        return { outcome: 'noop', reason: 'not_processing', status: row && row.status }
      }

      // Success.
      if (!gwError) {
        if (!canTransition(PROCESSING, SUCCESS)) {
          return { outcome: 'noop', reason: 'illegal_success', status: row.status }
        }
        await PaymentRepository.updateStatus(
          paymentId, SUCCESS, { provider_ref: result.providerRef, last_error: null }, trx
        )
        return { outcome: 'success', status: SUCCESS }
      }

      // Retriable failure with attempts still left → release back to PENDING.
      if (gwError.retriable && row.attempts < row.max_attempts) {
        await PaymentRepository.updateStatus(
          paymentId, PENDING, { last_error: gwError.reason, processing_started_at: null }, trx
        )
        return { outcome: 'retry', reason: gwError.reason, status: PENDING }
      }

      // Non-retriable, or retriable but attempts exhausted → terminal FAILED.
      const lastError = gwError.retriable
        ? `max attempts exhausted: ${gwError.reason}`
        : gwError.reason
      await PaymentRepository.updateStatus(paymentId, FAILED, { last_error: lastError }, trx)
      return { outcome: 'failed', status: FAILED }
    })
  }
}

module.exports = new PaymentService()
