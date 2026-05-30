'use strict'

// MySQL raises ER_DUP_ENTRY (errno 1062) when a UNIQUE constraint is violated.
// This is the backbone of idempotency (idempotency_key) and webhook dedup (event_id):
// we let the DB reject the duplicate, then detect it here instead of racing in app code.
function isDuplicateKeyError (err) {
  return Boolean(err) && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)
}

module.exports = {
  isDuplicateKeyError
}
