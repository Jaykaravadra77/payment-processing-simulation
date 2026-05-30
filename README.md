# Payment Processing System

A backend that simulates a real-world payment gateway integration — built to demonstrate
correct handling of the messy edge cases in distributed payments: **idempotency,
concurrency, retries with backoff, asynchronous webhooks, and crash recovery.**

> Assignment: *Backend Engineer (Mid-Level) — Payment Processing System.*

---

## Architecture at a glance

Two processes that scale independently, sharing a MySQL database and a Redis-backed queue:

```
   Client
     │  POST /api/payments  (Idempotency-Key)
     ▼
┌─────────────┐   enqueue job    ┌──────────┐
│  API (HTTP) │ ───────────────► │  Redis   │
│  Fastify    │                  │ (BullMQ) │
└─────┬───────┘                  └────┬─────┘
      │ write                         │ pull job
      ▼                               ▼
┌───────────────────────┐     ┌──────────────────┐     charge      ┌──────────────────┐
│       MySQL 8         │◄────│  Worker process  │ ──────────────► │  Gateway (fake)  │
│  payments             │     │  process()       │ ◄────────────── │  success/fail/   │
│  webhook_events       │     │  + reconciler    │     result      │  delay/timeout   │
└───────────────────────┘     └──────────────────┘                 └──────────────────┘
      ▲                                                                      │
      │  POST /api/webhooks/payment  (async provider callback)               │
      └──────────────────────────────────────────────────────────────────────┘
```

- **API process** (`npm run dev`) — accepts requests, writes the payment row, enqueues a
  background job. It never calls the gateway itself.
- **Worker process** (`npm run worker`) — pulls jobs, drives the payment through its
  lifecycle with row-level locking and retry/backoff, and runs a periodic **reconciler**
  that rescues payments left stuck by a crash.
- **Gateway** is a built-in simulator (the assignment says "simulate a provider"), so the
  whole system runs locally with no external dependency.

---

## Tech stack & why

| Choice | Reason |
|---|---|
| **MySQL 8** (not Mongo) | Money needs relational + ACID. `SELECT ... FOR UPDATE` row locking is the conventional, correct concurrency primitive for payments. |
| **Knex** | Makes the row-locking SQL explicit rather than hidden behind an ORM. |
| **Fastify 5** | Fast, schema-first (validation + Swagger from the same JSON schema). |
| **BullMQ + Redis** | Durable, queue-based retry with exponential backoff — survives restarts (bonus). |
| **fluent-json-schema + @fastify/swagger** | One schema drives request validation *and* the API docs. |
| **pino** | Structured, `paymentId`-tagged logs for traceability. |

---

## How each requirement is met

| Requirement | Where / how |
|---|---|
| **Payment lifecycle** | `PENDING → PROCESSING → SUCCESS/FAILED` state machine (`src/shared/lib/stateMachine.js`); SUCCESS/FAILED are terminal. |
| **Retry + backoff** | BullMQ `attempts` + custom exponential-with-jitter backoff (`queue/retryQueue.js`, `queue/paymentProcessor.js`). |
| **Idempotency** | `payments.idempotency_key` UNIQUE index; duplicate insert returns the existing payment (`src/payment/services.js`). |
| **Concurrency control** | `SELECT ... FOR UPDATE` claim inside a transaction; only `PENDING` is claimable, so exactly one worker processes a payment (`src/shared/services/lib/payment.js`). |
| **Gateway simulation** | Random success / hard-decline / delay / timeout with a timeout guard (`src/shared/services/lib/gateway.js`). |
| **Webhook handling** | `POST /api/webhooks/payment` applies a *state-machine transition*, dedups on `event_id`; handles duplicate / early / conflicting callbacks (`src/webhook/`). |
| **Data consistency / recovery** | Reconciler sweep finds payments stuck in PROCESSING and releases them back for a retry (`queue/reconciler.js`). |
| **Logging** | Structured pino logs at every lifecycle event, tagged with `paymentId`. |
| **Bonus** | Queue-based retry ✅. (Circuit breaker / rate limiting are the remaining optional bonus.) |

---

## Run it in under 5 minutes

**Prerequisites:** Node.js ≥ 20, Docker.

```bash
# 1. Install
npm install

# 2. Start MySQL + Redis
docker-compose up -d

# 3. Configure env (defaults match docker-compose)
cp .env.example .env

# 4. Create the tables
npm run migrate

# 5. Start the two processes (separate terminals)
npm run dev       # API on http://localhost:3000
npm run worker    # background worker + reconciler
```

- **API docs (Swagger UI):** http://localhost:3000/documentation
- **Health check:** http://localhost:3000/health

### Try it

```bash
# Initiate a payment (idempotent on the Idempotency-Key header)
curl -X POST http://localhost:3000/api/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-123' \
  -d '{"amount": 4200, "currency": "INR"}'

# Send the same request again → same payment id, no duplicate (idempotency)
curl -X POST http://localhost:3000/api/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-123' \
  -d '{"amount": 4200, "currency": "INR"}'

# Simulate a provider callback (replace <id> with the returned payment id)
curl -X POST http://localhost:3000/api/webhooks/payment \
  -H 'Content-Type: application/json' \
  -d '{"eventId": "evt-1", "paymentId": <id>, "status": "SUCCESS", "providerRef": "gw_abc"}'
```

---

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `POST` | `/api/payments` | Initiate a payment. **Requires** `Idempotency-Key` header. Body: `{ amount (minor units, int), currency (3-letter) }`. |
| `POST` | `/api/webhooks/payment` | Provider callback. Body: `{ eventId, paymentId, status: SUCCESS\|FAILED, providerRef? }`. |

All responses share the envelope `{ success, message, data }`. Full request/response
schemas are live in **Swagger UI** at `/documentation`.

---

## How the hard cases are handled

**Idempotency** — the unique index on `idempotency_key` is the backbone. Two simultaneous
requests with the same key both try to insert; the DB lets exactly one win and the other
gets a duplicate-key error, which we translate into "return the existing payment." No
app-level locking required.

**Concurrency** — processing claims the row with `SELECT ... FOR UPDATE` inside a
transaction and only proceeds if the status is `PENDING`. A second worker blocks on the
lock, then sees `PROCESSING` and bails — so the gateway is called exactly once. The lock
is **never held across the gateway call** (claim and settle are two short transactions),
so a slow provider can't stall the database.

**Retry & backoff** — retriable failures (timeout/5xx) release the payment back to
`PENDING` and throw, so BullMQ reschedules with exponential backoff + jitter. Non-retriable
failures (hard decline) go straight to terminal `FAILED`. Attempts are bounded by
`MAX_PAYMENT_ATTEMPTS`.

**Webhooks** — a callback applies a *transition*, never a blind overwrite:
- **Duplicate** → `event_id` UNIQUE index rejects the re-insert → ack & ignore.
- **Early** (arrives before our worker settles) → the legal transition applies now; the
  worker's later settle sees a terminal state and no-ops. Both paths converge.
- **Conflicting** (says FAILED but already SUCCESS) → the state machine refuses the
  illegal move; the payment is untouched and a warning is logged.

**Crash recovery** — if a worker dies mid-charge, the payment is stuck in `PROCESSING`.
The reconciler periodically finds rows stuck past `STALE_PROCESSING_MS` and releases them
back to `PENDING` for a fresh attempt (or terminal `FAILED` if attempts are exhausted).
The guarantee comes from **DB state surviving the crash** — not from in-memory timers.

---

## Verifying the behavior

Each build step has a standalone script that asserts its requirement and prints `PASS`
lines (MySQL + Redis must be up). These double as a behavioral demo:

```bash
node scripts/verify-step7.js    # idempotency: same key twice → one payment
node scripts/verify-step8.js    # concurrency: parallel process() → one gateway call
node scripts/verify-step9.js    # retry/backoff: forced failures → FAILED after max
node scripts/verify-step10.js   # webhooks: duplicate / early / conflicting
node scripts/verify-step11.js   # recovery: stale PROCESSING rows rescued
```

(A full Jest suite under `tests/` is the next step.)

---

## Configuration

All knobs are env-driven (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `MAX_PAYMENT_ATTEMPTS` | `3` | Max processing attempts before terminal FAILED |
| `RETRY_BACKOFF_DELAY_MS` | `5000` | Base delay for exponential backoff |
| `STALE_PROCESSING_MS` | `60000` | Age after which a PROCESSING row is considered stuck |
| `RECONCILE_INTERVAL_MS` | `30000` | How often the reconciler sweep runs |
| `GATEWAY_*_PROB`, `GATEWAY_TIMEOUT_MS` | — | Gateway simulator outcome probabilities & timeout |

---

## Project structure

```
app.js / index.js        Fastify bootstrap + entry
worker.js                Background worker + reconciler entry
config.js                Env-driven config
knexfile.js              Knex/MySQL config
migrations/              payments + webhook_events tables (UNIQUE indexes)
plugins/                 autoloaded: cors/swagger, mysql, response decorators, routes
queue/                   retryQueue, paymentProcessor (worker), reconciler
src/payment/             initiate endpoint (routes/controllers/schema/services)
src/webhook/             webhook endpoint (routes/controllers/schema/services)
src/shared/
  lib/                   knex, redis, logger, stateMachine
  models/                enums
  repositories/          PaymentRepository, WebhookEventRepository
  services/              paymentService (process/recover), gatewayService
  utils/                 APIError, GatewayError, helpers
scripts/                 verify-stepN.js behavioral checks
```

---

## Design decisions & tradeoffs

- **Repository pattern over Knex** — controllers/services never write raw SQL, so logic
  stays testable and the storage layer is swappable.
- **Two-transaction claim/settle** — keeps the row lock off the critical path during the
  (slow, unreliable) gateway call, trading a tiny re-lock cost for much better throughput.
- **Transitions, not overwrites** — every status change goes through `canTransition`, with
  SUCCESS/FAILED terminal. This single rule is what makes out-of-order events safe.
- **DB as source of truth, queue as delivery** — recovery relies on durable DB rows, so a
  crash is a hiccup, not data loss. BullMQ's own stalled-job handling is complementary.

**What I'd add at scale:** a circuit breaker around the gateway (fail fast during an
outage), per-key/IP rate limiting, an outbox for emitting our own events, partitioning /
read replicas for the payments table, and metrics (success rate, p95 settle latency,
queue depth) feeding alerts.
