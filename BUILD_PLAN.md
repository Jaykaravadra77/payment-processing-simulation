# Payment Processing System — Step-by-Step Build Plan

> **How to use this file:** Do **one step at a time**. Build it with AI, read the code,
> make sure you understand the "Understand / interview talking point" line, tick the box,
> then move to the next step. Don't batch steps — the whole point is to learn each chunk.

---

## Tech Stack (decided)
- **Runtime:** Node.js
- **Framework:** Fastify 5 (conventions copied from your `cinetopia-backend`)
- **Database:** MySQL 8 (relational + ACID — standard payments choice)
- **Query builder:** Knex (makes `SELECT ... FOR UPDATE` row-locking explicit)
- **Queue:** BullMQ + Redis (queue-based retry with exponential backoff — bonus)
- **Validation/Docs:** fluent-json-schema + @fastify/swagger
- **Logging:** pino (built into Fastify)
- **Tests:** Jest + Fastify `app.inject()`
- **Infra:** docker-compose (MySQL + Redis)

## Conventions (from cinetopia-backend)
- `plugins/` autoloaded; `src/<feature>/{routes,controllers,schema}.js`
- Repository pattern (class per table) — wrapping **Knex** instead of Mongoose
- `reply.success` / `reply.error` decorators + `_.APIError` + central error handler
- Hungarian naming: `s`tring `n`umber `e`num `a`rray `b`oolean `i`d `o`bject `d`ate
- Enums as `{ value: [codes], description: { NAME: code } }`
- ESLint `standard` (no semicolons, single quotes, 2-space indent)

---

## How the 7 requirements map to steps
| Requirement | Covered in step(s) |
|---|---|
| Payment lifecycle (states) | 4, 7, 8 |
| Failure handling & retry (backoff) | 9 |
| Idempotency | 7 |
| Concurrency control | 8 |
| External gateway simulation | 6 |
| Webhook / callback handling | 10 |
| Data consistency / recovery | 8, 11 |
| Logging & observability | every step + 12 |
| Testing | 13 (a–f) |
| Bonus (queue / circuit breaker / rate limit / docs) | 9, 14, 15 |

---

## Progress Checklist
- [ ] **Step 0** — Project scaffold & dependencies
- [ ] **Step 1** — Config + Fastify bootstrap + core plugins
- [ ] **Step 2** — MySQL connection plugin + Knex setup
- [ ] **Step 3** — Database migrations (`payments`, `webhook_events` tables)
- [ ] **Step 4** — Enums + payment state machine
- [ ] **Step 5** — Repository layer (PaymentRepository, WebhookEventRepository)
- [ ] **Step 6** — External gateway simulator
- [ ] **Step 7** — Initiate payment endpoint (idempotency)
- [ ] **Step 8** — Process payment core (concurrency + state transitions)
- [ ] **Step 9** — Retry + exponential backoff (BullMQ worker)
- [ ] **Step 10** — Webhook / callback endpoint (dedup, early, conflicting)
- [ ] **Step 11** — Reconciliation / crash recovery (stale-lock sweep)
- [ ] **Step 12** — Logging & observability polish
- [ ] **Step 13** — Tests (a–f)
- [ ] **Step 14** — API docs (Swagger) + README
- [ ] **Step 15** — Bonus: circuit breaker + rate limiting *(optional)*

---

# The Steps

### Step 0 — Project scaffold & dependencies
- **Goal:** Empty but runnable project skeleton.
- **Build:** `package.json`, install deps, folder structure (`plugins/`, `src/`, `tests/`),
  `.gitignore`, `.eslintrc.js`, `.env.example`, `docker-compose.yml` (MySQL + Redis), npm
  scripts (`dev`, `worker`, `test`, `migrate`, `lint`).
- **Understand / talking point:** Why a separate `worker` entry point exists (API process vs
  background retry process — they scale independently).
- **Done when:** `npm install` succeeds and `docker-compose up -d` starts MySQL + Redis.

### Step 1 — Config + Fastify bootstrap + core plugins
- **Goal:** Server boots and responds.
- **Build:** `config.js` (env-driven, dev/prod switch), `app.js` (Fastify instance, autoload,
  helmet, central error handler), `index.js`, plus plugins: `common.js` (cors/swagger/formbody)
  and `responseDecorator.js` (`reply.success` / `reply.error`).
- **Understand / talking point:** How the central error handler turns a thrown `_.APIError`
  into a clean JSON response — one place handles all errors.
- **Done when:** `npm run dev` boots; a health route returns 200.

### Step 2 — MySQL connection plugin + Knex setup
- **Goal:** App talks to MySQL.
- **Build:** `knexfile.js`, a `mysql.js` plugin that creates the Knex instance and decorates it
  onto Fastify (`fastify.db`), graceful shutdown.
- **Understand / talking point:** Connection pooling — why we reuse a pool instead of opening a
  connection per request, and why that matters under load.
- **Done when:** App logs "DB connected" and a test query (`SELECT 1`) works.

### Step 3 — Database migrations (tables)
- **Goal:** Schema exists and is reproducible.
- **Build:** Knex migrations for:
  - `payments` — `id`, `idempotency_key` **UNIQUE**, `amount` (DECIMAL/int minor units),
    `currency`, `status`, `attempts`, `max_attempts`, `provider_ref`, `last_error`,
    `processing_started_at`, timestamps.
  - `webhook_events` — `id`, `event_id` **UNIQUE**, `payment_id`, `status`, `payload`,
    `processed_at`.
- **Understand / talking point:** The two **UNIQUE indexes are the backbone** — `idempotency_key`
  blocks duplicate payments, `event_id` blocks duplicate webhook processing, both enforced
  atomically by the DB (not app code).
- **Done when:** `npm run migrate` creates both tables; rollback works.

### Step 4 — Enums + payment state machine
- **Goal:** Legal status transitions are codified in one place.
- **Build:** `src/shared/models/enums.js` (`ePaymentStatus`: PENDING/PROCESSING/SUCCESS/FAILED),
  `src/shared/lib/stateMachine.js` (`canTransition(from, to)`, terminal-state rules).
- **Understand / talking point:** Why SUCCESS & FAILED are **terminal** — this single rule kills
  a whole class of bugs (e.g. a late webhook flipping a succeeded payment to failed).
- **Done when:** `canTransition('SUCCESS', 'FAILED')` returns false; valid moves return true.

### Step 5 — Repository layer
- **Goal:** All DB access goes through clean, testable classes.
- **Build:** `PaymentRepository` (create, findById, findByIdempotencyKey, claim-for-update,
  updateStatus, findStale) and `WebhookEventRepository` (insert with dedup, exists).
- **Understand / talking point:** Why a repository layer — controllers/services never write raw
  SQL, so logic stays testable and the DB can change without touching business code.
- **Done when:** A quick script can create and fetch a payment row via the repository.

### Step 6 — External gateway simulator
- **Goal:** A fake payment provider that behaves like the messy real world.
- **Build:** `gatewayService.charge()` returning random **success / failure / delay / timeout**
  with configurable probabilities; calls wrapped in a timeout guard.
- **Understand / talking point:** Distinguish **retriable** (timeout, 5xx) vs **non-retriable**
  (hard decline) failures — this decision drives the whole retry strategy.
- **Done when:** Repeated calls show all four outcomes; timeouts reject within the timeout window.

### Step 7 — Initiate payment endpoint (Idempotency ✅)
- **Goal:** `POST /api/payments` creates exactly one payment per idempotency key.
- **Build:** route + schema + controller. Read `Idempotency-Key` header; insert payment; on
  duplicate-key error, return the **existing** payment instead of creating a new one. Enqueue
  processing job.
- **Understand / talking point:** Double-click / network-retry safety — the unique index means
  even two simultaneous requests with the same key yield one payment; the DB picks the winner.
- **Done when:** Same key twice → one row, same id returned both times.

### Step 8 — Process payment core (Concurrency ✅ + Lifecycle ✅)
- **Goal:** Move a payment through its lifecycle safely, even under parallel processing.
- **Build:** `paymentService.process(paymentId)`:
  1. `BEGIN` transaction → `SELECT ... FOR UPDATE` the row (or guarded
     `UPDATE ... WHERE status='PENDING'`).
  2. If not claimable (already PROCESSING/terminal) → bail out.
  3. Flip to PROCESSING, call gateway, apply result via the state machine, `COMMIT`.
- **Understand / talking point:** **This is the concurrency showpiece.** `SELECT ... FOR UPDATE`
  inside a transaction means a second worker blocks/sees it's taken — exactly one processes it.
  Explain row-lock vs the guarded-update alternative.
- **Done when:** Firing `process()` twice in parallel results in exactly one gateway call.

### Step 9 — Retry + exponential backoff (Retry ✅ + Queue bonus ✅)
- **Goal:** Failed payments retry a limited number of times with growing delays.
- **Build:** `queue/retryQueue.js` (BullMQ queue, `jobId = paymentId` for dedup),
  `queue/paymentProcessor.js` (job handler calling `paymentService.process`), `worker.js` entry.
  Configure `attempts: maxAttempts`, `backoff: { type: 'exponential', delay }`. Retriable error →
  throw (BullMQ reschedules); non-retriable → mark FAILED now; attempts exhausted → final FAILED.
- **Understand / talking point:** Why exponential backoff + jitter (don't hammer a struggling
  provider; avoid retry stampedes). Why `jobId = paymentId` prevents duplicate queued jobs.
- **Done when:** A forced-failure payment retries with growing delays, then lands FAILED after max.

### Step 10 — Webhook / callback endpoint (Webhooks ✅)
- **Goal:** Handle async provider callbacks correctly, including the nasty cases.
- **Build:** `POST /api/webhooks/payment` → route + schema + controller. Insert `webhook_events`
  (dedup on `event_id`); apply status via the state machine inside a transaction.
  - **Duplicate** callback → event_id already exists → ack & ignore.
  - **Early** callback (arrives before our processing finished) → transition applies; later job
    sees terminal state and no-ops.
  - **Conflicting** callback (says FAILED but already SUCCESS) → state machine refuses & logs.
- **Understand / talking point:** Convergence — because webhooks apply a *transition* (not a blind
  overwrite) and the state machine is idempotent, order of arrival doesn't corrupt state.
- **Done when:** Duplicate/early/conflicting callbacks each resolve to the correct final state.

### Step 11 — Reconciliation / crash recovery (Data consistency ✅)
- **Goal:** Self-heal payments stuck mid-processing after a crash.
- **Build:** `queue/reconciler.js` — a repeatable job that finds payments in PROCESSING longer
  than `STALE_PROCESSING_MS` (stale lock) and re-enqueues them.
- **Understand / talking point:** Why `setTimeout` retries are unsafe (lost on crash) but DB +
  queue state survives restarts → "recovery from partial failures."
- **Done when:** A payment manually left in PROCESSING gets picked up and re-processed.

### Step 12 — Logging & observability polish
- **Goal:** Every lifecycle event is traceable.
- **Build:** structured pino logs tagged with `paymentId` at: initiated, claimed, attempt N,
  gateway result, retry scheduled, success, failed, webhook received, conflict. Request-id
  correlation.
- **Understand / talking point:** What you'd actually need to debug a stuck payment in prod —
  one `paymentId` should let you trace the whole story.
- **Done when:** A full payment run produces a readable, correlated log trail.

### Step 13 — Tests
Do these as sub-steps so each is reviewable on its own:
- [ ] **13a — Core flow:** PENDING → PROCESSING → SUCCESS happy path.
- [ ] **13b — Idempotency:** same key twice (incl. parallel) → one payment.
- [ ] **13c — Concurrency:** parallel `process()` → exactly one claim wins.
- [ ] **13d — Gateway scenarios:** success/failure/delay/timeout all handled.
- [ ] **13e — Retry/backoff:** forced failures → retries → final FAILED after max attempts.
- [ ] **13f — Webhooks:** duplicate / early / conflicting callbacks.
- **Understand / talking point:** How you *prove* concurrency/idempotency in a test (fire
  parallel requests, assert a single side effect) — this is what the evaluator is really checking.
- **Done when:** `npm test` is green and covers each requirement above.

### Step 14 — API docs (Swagger) + README
- **Goal:** The project is self-documenting and easy to run.
- **Build:** Swagger UI at `/documentation` (auto from fluent-json-schema), a thorough `README`
  (architecture diagram in words, how to run, design decisions, edge-case handling, tradeoffs).
- **Understand / talking point:** The README is where you score "system design thinking" — call
  out MySQL choice, atomic transitions, queue-based retries, and what you'd change at scale.
- **Done when:** Swagger lists all endpoints; README lets a stranger run it in <5 minutes.

### Step 15 — Bonus (optional, only if time)
- **Circuit breaker** around the gateway (open after N consecutive failures → fail fast → half-open).
- **Rate limiting** per idempotency key / IP (`@fastify/rate-limit`).
- **Understand / talking point:** Resilience patterns — circuit breaker protects you from a
  provider outage cascading into your system.
- **Done when:** Breaker opens under sustained failure; rate limiter rejects bursts.

---

## Suggested working rhythm per step
1. Tell AI: *"Let's do Step N."*
2. AI builds just that step.
3. You read the code + the "Understand" line; ask "why" questions until it clicks.
4. Run / test that chunk.
5. Tick the box, commit, move on.
