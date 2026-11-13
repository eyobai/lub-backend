# Architecture

Backend for a Lowest Unique Bid (LUB) auction platform. Users pay a fixed fee per bid; when an
auction closes, the lowest amount that was submitted exactly once wins.

Status: **Phase 1** (project setup, full database schema, authentication) is implemented.
Later phases are designed here and in the schema, but not yet coded.

## 1. Shape of the system

A modular monolith: one NestJS application, one PostgreSQL database, one Redis instance.
Modules own their tables and talk to each other through exported services, so a module can
later be extracted without rewriting the others.

```
Client ──HTTPS──> NestJS API ──> PostgreSQL   source of truth: users, ledger, bids, results
                     │
                     ├─────────> Redis        rate limits, login lockouts, revoked sessions, BullMQ
                     │
                     └─ BullMQ workers        auction open/close, winner calculation, notifications,
                                              payment reconciliation (later phases)
```

Rules that hold everywhere:

- **PostgreSQL decides.** Anything that must be correct under concurrency (balances, bids,
  winner selection) is enforced by database transactions and constraints. Redis only holds
  data that can be lost without corrupting money or results.
- **Server time only.** Auction open/close decisions use the database clock, never the client's.
- **Money is integers.** Amounts are `BIGINT` minor units (santim for ETB) plus an ISO-4217
  currency code. No floating point anywhere.
- **Default deny.** Every route requires a valid access token unless it is marked `@Public()`;
  role-restricted routes use `@Roles(...)`.

## 2. Request pipeline

`helmet` → CORS allow-list → rate limiter (Redis-backed, per IP) → JWT guard → roles guard →
validation pipe (unknown fields rejected) → controller → service → Prisma.

Every error leaves through one filter and has one shape:

```json
{
  "statusCode": 401,
  "error": "INVALID_CREDENTIALS",
  "message": "Incorrect phone number or password",
  "details": {},
  "path": "/api/v1/auth/login",
  "requestId": "…",
  "timestamp": "2026-11-13T16:00:00.000Z"
}
```

`error` is a stable machine-readable code that clients can switch on. Unexpected errors are
logged with the request ID and returned as a generic 500 with no internals.

Logs are structured JSON (pino). Request logs contain method, URL, status and request ID only:
no headers, bodies, tokens, passwords or OTP codes.

## 3. Source layout

```
src/
  main.ts, app.module.ts, app.setup.ts   bootstrap; app.setup is shared with integration tests
  config/                                env validation (Joi) and typed AppConfig
  common/                                error type + filter, guards, decorators, shared DTOs
  infra/prisma, infra/redis              database and Redis clients
  modules/
    health/                              liveness and readiness probes
    phone/                               phone parsing and E.164 normalization
    otp/                                 OTP issuing/verification + SMS sender abstraction
    auth/                                registration, login, tokens, password recovery
  scripts/seed-admin.ts                  bootstrap SUPER_ADMIN
prisma/schema.prisma, prisma/migrations  schema and SQL migrations
test/                                    integration tests against real PostgreSQL + Redis
```

Planned modules, one per phase: `wallet` (ledger), `payments`, `products`, `auctions`,
`bidding`, `results` (winner calculation), `notifications`, `admin`, `audit`.

## 4. Authentication

### Identity

- The phone number is the login identifier. Input such as `0911234567`, `911234567`,
  `251911234567` or `+251 91 123 4567` is normalized to E.164 (`+251911234567`) with
  libphonenumber, and must be a valid **mobile** number of an allowed country.
- Allowed countries come from `PHONE_ALLOWED_COUNTRIES` (default `ET`), so adding a country is
  a configuration change. The database also checks the E.164 format.
- Passwords are hashed with Argon2id (19 MiB, 2 iterations). Minimum 8 characters with at
  least one letter and one digit.

### Registration and phone verification

1. `POST /auth/register` creates the user as unverified, sends a 6-digit code by SMS and
   returns a `verificationToken`.
2. `POST /auth/verify-phone` with phone, code and `verificationToken` marks the phone verified
   and signs the user in.

Until a number is verified, a new registration for it replaces the pending one (otherwise
anyone could block a number they do not own). The `verificationToken` is bound to the pending
registration, so if person A registers a number and person B (the SIM owner) registers it again,
A cannot use B's code to finish with A's password.

### OTP codes

- Generated with a CSPRNG; stored only as `HMAC-SHA256(secret, phone | purpose | code)`.
- Bound to a purpose: a phone-verification code cannot reset a password.
- Single use, expire after `OTP_TTL_SECONDS`, and die after `OTP_MAX_ATTEMPTS` wrong guesses.
- Requesting a new code invalidates the previous one. Requests are limited by a resend
  cooldown and an hourly cap per phone number.
- Delivery goes through the `OtpSender` interface. The only sender so far is `console`, which
  logs the code for local development. It cannot run in production: environment validation
  rejects `OTP_PROVIDER=console` when `NODE_ENV=production`, and the sender's constructor
  throws there as a second barrier. Codes are never returned in API responses in any
  environment.

### Sessions and tokens

| Token   | Lifetime (default) | Storage                                   |
| ------- | ------------------ | ----------------------------------------- |
| Access  | 15 minutes         | Not stored; JWT (HS256) verified per call |
| Refresh | 30 days            | SHA-256 hash in `refresh_tokens`          |

- Access and refresh tokens are signed with different secrets and carry a `typ` claim, so one
  cannot be used as the other.
- **Rotation:** each refresh returns a new pair and revokes the old refresh token. The swap is
  a compare-and-swap in one transaction, so two concurrent refreshes cannot both succeed.
- **Reuse detection:** presenting an already-rotated refresh token revokes the whole session
  (token family) and records a security event.
- **Immediate revocation:** logout, logout-all, password reset/change and reuse detection put
  the session ID on a Redis deny-list for the remaining access-token lifetime, so access tokens
  stop working at once rather than after up to 15 minutes.
- Every authenticated request re-reads the user, so suspending or blocking an account, or
  changing its roles, takes effect on the next request.

### Abuse protection

- **Per account:** `LOGIN_MAX_FAILED_ATTEMPTS` wrong passwords inside the window lock sign-in
  for that phone number for `LOGIN_LOCKOUT_SECONDS`. A successful password reset clears the lock.
- **Per IP:** all routes are rate limited; authentication routes have a stricter limit
  (`AUTH_THROTTLE_LIMIT` per `THROTTLE_TTL_SECONDS`). Counters live in Redis, so the limit holds
  across multiple API instances.
- **No account enumeration:** login gives the same answer (and takes the same time) for a wrong
  password and an unknown number; forgot-password and resend-verification always answer `202`
  with the same body.
- Logins, failures, lockouts, token reuse and password changes are written to `security_events`.

### Account status and roles

`ACTIVE`, `SUSPENDED`, `BLOCKED`. Non-active accounts cannot sign in, refresh or use existing
access tokens. Roles: `USER`, `SUPPORT`, `FINANCE`, `ADMIN`, `SUPER_ADMIN` (many-to-many, with
who granted each role). Clients can never set a role or status: unknown request fields are
rejected.

## 5. Database design

All tables exist from the first migration, so later phases add code rather than reshape data.

| Area          | Tables                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------- |
| Identity      | `users`, `user_profiles`, `roles`, `user_roles`, `refresh_tokens`, `otp_verifications`, `security_events` |
| Money         | `currencies`, `wallets`, `ledger_accounts`, `ledger_entries`, `wallet_transactions`       |
| Payments      | `payment_transactions`, `payment_provider_events`, `withdrawal_requests`                  |
| Catalogue     | `products`, `product_images`                                                              |
| Auctions      | `auctions`, `bid_submissions`, `bids`, `auction_results`, `winners`                       |
| Fulfilment    | `prize_deliveries`, `prize_delivery_events`                                               |
| Cross-cutting | `notifications`, `audit_logs`, `idempotency_records`, `system_settings`                   |

### Ledger (double entry)

- Every money movement is one `wallet_transactions` row (the journal header) with two or more
  `ledger_entries` (debit/credit lines) against `ledger_accounts`.
- Account types: user wallet, user wallet hold (pending withdrawals), platform revenue,
  payment clearing, withdrawal clearing, adjustments.
- A deferred constraint trigger rejects any transaction whose debits and credits differ at commit.
- `ledger_entries` cannot be updated or deleted (trigger). Corrections are new reversing
  transactions; a journal header can only change status (`POSTED` → `REVERSED`).
- Wallet balances are cached on the account row, updated in the same transaction as the
  entries, and constrained to never go negative. Each entry stores the balance after it, so a
  balance can be re-derived and reconciled from the entries alone.

### Bids and results

- `bid_submissions` is one paid request (one or many amounts, one fee total, one ledger
  transaction); `bids` holds one row per amount. Both are append-only (trigger).
- Each bid gets a globally increasing sequence number when it is accepted, giving a total
  order for audits and tie-breaking rules.
- A unique index on (auction, user, amount) backs the "same user cannot bid the same amount
  twice" policy; the policy is per auction.
- `auction_results` stores, per finalized auction, the algorithm version, total and unique bid
  counts, the last bid sequence included, the full amount histogram and a hash of the input,
  so a result can be recomputed and compared later. It is append-only.
- What happens when no amount is unique is a per-auction policy that must be chosen before the
  auction can be finalized; there is no silent default.

### Database-level protections

Foreign keys everywhere; unique constraints on phone number, provider references, idempotency
keys and transaction references; `CHECK` constraints for positive amounts, non-negative
balances, valid auction price ranges and time windows, and bid-submission totals; append-only
triggers on `ledger_entries`, `bids`, `bid_submissions`, `audit_logs` and `auction_results`.

## 6. Planned concurrency design (later phases)

- **Placing a bid** is one PostgreSQL transaction: lock the auction row, check status and time
  against the database clock, insert the bids, debit the wallet through the ledger, commit. If
  any step fails, nothing is charged and no bid exists.
- **Idempotency:** bid, deposit and withdrawal requests carry an `Idempotency-Key`; the key and
  a hash of the request are stored in `idempotency_records` in the same transaction, so a retry
  returns the original result instead of charging twice.
- **Payment callbacks** are stored raw in `payment_provider_events` with a unique provider
  event ID; a wallet is credited at most once per provider transaction.
- **Closing an auction** is a BullMQ job that moves the auction to `CLOSING` under a row lock
  (which blocks new bids), computes the result with one deterministic SQL aggregation and
  writes `auction_results` and `winners` in the same transaction.

## 7. Configuration and environments

All settings come from environment variables, validated at startup; the app refuses to start
on a bad configuration. In production it additionally refuses placeholder secrets, the
development OTP provider, and serves API docs only if `SWAGGER_ENABLED=true` is set explicitly.
See `.env.example` for the full list.

## 8. Testing

- Unit tests (`npm test`): environment validation, OTP sender selection, phone parsing, roles guard.
- Integration tests (`npm run test:e2e`): boot the real application against PostgreSQL and
  Redis (database `lub_test`, Redis DB 1) and drive it over HTTP. Only SMS delivery is
  replaced, by a sender that captures messages so tests read the code the way a user would.
  The test setup refuses to run against a database whose name does not contain `test`.

## 9. Not built yet / decisions needed

- A real SMS provider for OTP delivery. Production cannot start without one.
- Wallet, payments, products, auctions, bidding, winner calculation, notifications, admin APIs.
- Real-money payments and public paid auctions must wait for legal and regulatory review.
