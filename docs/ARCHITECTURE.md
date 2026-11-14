# Architecture

Backend for a Lowest Unique Bid (LUB) auction platform. Users pay a fixed fee per bid; when an
auction closes, the lowest amount that was submitted exactly once wins.

Status: authentication, wallet and ledger, products and auctions, bidding, winner calculation,
winners and prize delivery, and notifications are implemented. What is left is listed in
section 9.

## 1. Shape of the system

A modular monolith: one NestJS application, one PostgreSQL database, one Redis instance.
Modules own their tables and talk to each other through exported services, so a module can
later be extracted without rewriting the others.

```
Client ──HTTPS──> NestJS API ──> PostgreSQL   source of truth: users, ledger, bids, results
                     │
                     ├─────────> Redis        rate limits, login lockouts, revoked sessions, BullMQ
                     │
                     └─ BullMQ workers        auction open/close, winner calculation, notifications;
                                              payment reconciliation (later phase)
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

`helmet` → CORS allow-list → rate limiter (Redis-backed, per IP) → JWT guard → password-change guard → roles guard →
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
    ledger/                              double-entry posting, reversal, reconciliation
    wallet/                              wallet balance/history, admin adjustments and freezing
    audit/                               audit-log writer used inside business transactions
    currency/                            resolves and validates the currency of a request
    products/                            product catalogue (back office)
    auctions/                            auction setup, lifecycle, public listing, open/close job
    bidding/                             placing bids, bid history, bid-fee refunds
    results/                             winner calculation, auction results, result re-check
    winners/                             winner verification, publishing, prize delivery
    notifications/                       in-app notifications, provider abstraction, dispatch job
    admin/                               user management, staff password reset, audit viewer, dashboard
    auth/                                registration, login, tokens, password recovery
  scripts/seed-admin.ts                  bootstrap SUPER_ADMIN
prisma/schema.prisma, prisma/migrations  schema and SQL migrations
test/                                    integration tests against real PostgreSQL + Redis
```

Planned module: `payments`.

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

`PHONE_VERIFICATION_REQUIRED` selects one of two modes.

**Off (default): phone number + password only.** `POST /auth/register` creates the account and
returns the user and tokens at once. No SMS is sent and no SMS provider is configured
(`OTP_PROVIDER=none`). Consequences that follow from not proving who owns a number:

- The first registration owns the number; a second one gets `409 PHONE_ALREADY_REGISTERED`.
- `verify-phone`, `resend-verification`, `forgot-password` and `reset-password` answer
  `403 SMS_VERIFICATION_DISABLED`. A forgotten password must be reset by staff (admin phase);
  a signed-in user can still use `change-password`.
- `phoneVerified` stays `false` on these accounts, so verification can be required later for
  sensitive actions (e.g. withdrawals) without a data migration.

**On: SMS verification.** The startup check refuses this mode without an `OTP_PROVIDER`.

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

### Admin management

- **Who may manage whom:** nobody can act on their own account, and only a `SUPER_ADMIN` can
  suspend, block, reset, sign out or change the roles of an account holding a back-office role.
  The acting account's status and roles are read again inside the transaction, and all account
  changes are serialized by one advisory lock, so two racing requests cannot bypass the rule.
  Together these keep at least one active `SUPER_ADMIN`: a staff account can only be changed by
  a different, active `SUPER_ADMIN`, who is still one afterwards.
- **Status:** suspend, block and reactivate need a reason, revoke every session (suspend and
  block) and write an audit record with the status before and after.
- **Roles:** `PUT /admin/users/:id/roles` replaces the account's whole set of back-office roles,
  records who granted them and revokes the account's sessions, so the change applies at once.
  `USER` is never granted or removed here.
- **Staff password reset:** generates a 14-character temporary password, stores only its
  Argon2id hash, returns it once, revokes every session, clears the sign-in lockout and sets
  `users.must_change_password`. The password is in no audit record, security event, log or
  notification. The owner gets an in-app notification that a reset happened.
- **Forced change:** while `must_change_password` is set, a global guard answers
  `403 PASSWORD_CHANGE_REQUIRED` on every route except `GET /auth/me`,
  `POST /auth/change-password` and `POST /auth/logout-all`. Changing the password clears it; the
  temporary password is refused as the new one.
- **Audit viewer:** read-only. Audit records filter by actor, action prefix (`user.` matches
  every user action), entity and period; security events by type, user, phone and period.
- **Dashboard:** all figures are read in one `REPEATABLE READ` transaction, so they describe the
  same instant. Revenue per currency is the balance of the platform revenue ledger account (bid
  fees credit it, refunds debit it); the 24-hour, 7-day and 30-day figures are the net of its
  ledger lines in that period.

## 5. Database design

All tables exist from the first migration, so later phases add code rather than reshape data.

| Area          | Tables                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Identity      | `users`, `user_profiles`, `roles`, `user_roles`, `refresh_tokens`, `otp_verifications`, `security_events` |
| Money         | `currencies`, `wallets`, `ledger_accounts`, `ledger_entries`, `wallet_transactions`                       |
| Payments      | `payment_transactions`, `payment_provider_events`, `withdrawal_requests`                                  |
| Catalogue     | `products`, `product_images`                                                                              |
| Auctions      | `auctions`, `bid_submissions`, `bids`, `auction_results`, `winners`                                       |
| Fulfilment    | `prize_deliveries`, `prize_delivery_events`                                                               |
| Cross-cutting | `notifications`, `audit_logs`, `idempotency_records`, `system_settings`                                   |

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

How it runs (`src/modules/ledger`, `src/modules/wallet`):

- `LedgerService.post` is the only code that moves money. In one database transaction it
  validates that the lines balance, row-locks the affected accounts in id order (so concurrent
  postings queue instead of deadlocking or overdrawing), checks the resulting balances, writes
  the journal and its lines, and updates the cached balances. It accepts the caller's
  transaction, so a bid and its fee will commit or roll back together.
- Each wallet has two accounts: `USER_WALLET` (spendable) and `USER_WALLET_HOLD` (reserved for
  withdrawals). Wallets and system accounts are created on first use with
  `INSERT … ON CONFLICT DO NOTHING`.
- Journals: deposit = debit payment clearing / credit wallet; bid fee = debit wallet / credit
  platform revenue; refund = the reverse; manual adjustment = wallet against `ADJUSTMENTS`.
- Idempotency: a journal may carry a globally unique key. Same-key requests are serialized with
  a transaction-scoped advisory lock; a repeat returns the first journal, and the same key with
  different content is rejected (`IDEMPOTENCY_KEY_REUSED`).
- Reversal posts a mirror-image journal linked by `reverses_id` (unique, so once only) and
  flips the original to `REVERSED`. It fails if the money has already been spent.
- A frozen wallet still receives money but cannot be debited by user activity.
- Ledger lines have a `sequence` assigned while the account is locked; history pages by it.
- `ReconciliationService` recomputes every balance from the lines in one repeatable-read
  snapshot and reports mismatches, unbalanced journals, negative balances and a non-zero trial
  balance. Exposed at `GET /admin/ledger/reconciliation`.
- Manual adjustments, reversals and freezes need the `FINANCE` role, an `Idempotency-Key`
  header (money movements), a reason, and write an `audit_logs` row in the same transaction.
  Staff cannot adjust their own wallet.
- Money is `bigint` end to end and is serialized as a string; nothing passes through a float.

Known limit: every bid fee locks the single platform-revenue row for its currency, which
serializes fee postings platform-wide. Transactions are short, so this is fine at launch scale;
if it becomes a bottleneck the revenue account can be sharded or its cached balance dropped.

### Products

- A product is a prize description: name, brand, model, market value (minor units + currency),
  a flat specifications object and an ordered list of image URLs. Image files are hosted
  elsewhere; this backend stores only their URLs.
- Products are never deleted. `ARCHIVED` retires one; the same product can back any number of
  auctions.
- A product's currency cannot be changed after creation.
- While a product has a `SCHEDULED`, `ACTIVE` or `CLOSING` auction it must stay `AVAILABLE`.
  Product updates lock the product row, and publishing an auction share-locks it, so the two
  cannot slip past each other.

### Auctions

Lifecycle:

```
DRAFT ──schedule──▶ SCHEDULED ──opensAt (job) or activate──▶ ACTIVE ──closesAt (job)──▶ CLOSING ──▶ COMPLETED
  │  ◀──unschedule──┘   │                                      │                          (winner phase)
  └── activate ─────────┼──────────────────────────────────────▶
  cancel from DRAFT, SCHEDULED or ACTIVE (only while there are no bids) ──▶ CANCELLED
```

- An auction takes its currency from its product. Bid fee, minimum, maximum and step are minor
  units; the maximum must sit on the step grid (`min + n × step`).
- `DRAFT` auctions are invisible to users. Scheduling or activating requires an `AVAILABLE`
  product, a chosen no-unique-bid policy (`NO_WINNER` or `REFUND_BID_FEES`; `EXTEND_AUCTION`
  is in the schema but not accepted until its rules are defined) and a closing time in the
  future. Scheduling also needs an opening time in the future; activating opens it now and
  sets `opensAt` to the actual opening time.
- Everything is editable in `DRAFT` and `SCHEDULED` (a scheduled auction must stay publishable).
  In `ACTIVE` only title and description can change, so the rules bidders paid under are fixed.
  From `CLOSING` on nothing can change.
- Cancelling needs a reason. It stops bidding in the same transaction; if bids exist, every bid
  fee is then refunded (see Bidding).
- The bid fee must be greater than zero: every bid request is backed by a ledger journal.
- Every admin action row-locks the auction, bumps `version` and writes an audit record with
  before/after snapshots in the same transaction. Concurrent requests for the same transition
  succeed exactly once.
- **Time:** the database clock (`clock_timestamp()` / `now()`) decides every deadline; request
  bodies and application servers' clocks are never trusted. Responses include `serverTime` so
  clients can run countdowns against it.
- **Automatic transitions:** a repeating BullMQ job runs one sweep transaction that opens due
  `SCHEDULED` auctions and moves `ACTIVE` auctions past `closesAt` to `CLOSING`, each recorded
  in the audit log as a `SYSTEM` action. A transaction-level advisory lock keeps sweeps from
  overlapping across instances. The sweep only bounds how late the _status_ flips; the bidding
  module must still compare the database clock with `closesAt` itself, so a bid can never be
  accepted after the deadline even if a sweep is late.
- Public visibility: `SCHEDULED`, `ACTIVE`, `CLOSING`, `COMPLETED`, plus `CANCELLED` auctions
  that had been open for bidding. Public responses omit internal fields (creator, version,
  product status, cancel reason).

### Bidding

`POST /auctions/:id/bids` runs as one database transaction:

1. Take a per-(user, idempotency key) advisory lock and look for an earlier submission with that
   key. Same auction and amounts: return it (`Idempotent-Replayed: true`). Different: reject.
2. Row-lock the auction, then read the database clock. Bids are accepted only if the auction is
   `ACTIVE` and `closesAt` is still ahead; a `SCHEDULED` auction whose opening time has passed is
   opened on the spot. Time spent waiting for the lock counts against the deadline.
3. Validate every amount against min, max and step, the per-request and per-user limits, and the
   duplicate policy. Any failure rejects the whole request.
4. Debit `fee × count` from the wallet through the ledger (fails on insufficient funds or a
   frozen wallet), insert one `bid_submissions` row and one `bids` row per amount, and increase
   the auction's bid count.

Any failure rolls everything back, so money is never taken without bids and bids never exist
without payment. The fee, range, status and deadline always come from the locked auction row;
nothing but the amounts is read from the request. The auction row lock makes bids on one auction
take turns and makes the close of bidding wait for, or shut out, a bid in flight.

- Users can read only their own bids; public auction data carries only the bid count.
- Staff accounts (any back-office role) cannot bid, because staff can list every bid.
- **Refunds on cancellation:** after the cancellation commits, each paid bid request is credited
  back once (`REFUND` journal keyed `bid-refund:<submission id>`), in batches of 100, and
  `bid_fees_refunded_at` is set when none is left. The background job finishes any run that was
  interrupted, so a refund is neither lost nor paid twice. Bids themselves stay on record.

### Winner calculation

The background job finalizes every `CLOSING` auction right after the open/close sweep; an ADMIN
can also trigger it. Finalization is one database transaction:

1. Row-lock the auction. Placing a bid holds the same lock until it commits, so once the lock is
   held every accepted bid is committed and visible, and any later bid finds the auction closed.
2. If the auction is already `COMPLETED`, stop: a result is recorded once. The unique index on
   `auction_results.auction_id` backs this at the database level.
3. Refuse unless a supported no-unique-bid policy is set.
4. Count the bids per amount with one SQL aggregation and pass the counts to a pure function
   (`lowest-unique-bid.ts`): of the amounts bid exactly once, the smallest wins. The outcome is
   `WINNER_FOUND`, `NO_UNIQUE_BID` or `NO_BIDS`. It depends only on the counts, never on bid
   order, time or bidder, so the same bids always give the same result.
5. Check that the number of bids counted equals the auction's bid counter; a mismatch aborts.
6. Insert `auction_results` (counts per amount, SHA-256 of that input, algorithm version, last
   bid sequence), insert `winners` when there is one (`PENDING_VERIFICATION`), set the auction
   `COMPLETED` and write the audit record.

- **No unique bid:** `NO_WINNER` keeps the fees. `REFUND_BID_FEES` returns every fee after the
  result commits, through the same exactly-once refund path as cancellation. `NO_BIDS` and
  `WINNER_FOUND` never refund.
- **Re-check:** `GET /admin/auctions/:id/result/audit` recomputes the result from the bids on
  record and compares it with the recorded one.
- **Privacy:** the public result carries the outcome, winning amount and bid count. A signed-in
  user also sees how each of their own bids fared. The winner's identity and the per-amount
  counts are staff-only.

### Winners and prize delivery

- **Verification:** a winner starts `PENDING_VERIFICATION`. An ADMIN verifies or rejects (with a
  reason). Before verifying, the result is recomputed from the bids on record and must still
  name the same winning bid; staff cannot verify their own win. Rejecting changes nothing else:
  the result stays on record and no other winner is picked. A rejected winner can be verified
  later.
- **Publishing:** only a verified winner can be published, enforced by a `CHECK` constraint as
  well. The public recent-winners list shows published winners with the product, the winning
  amount and a masked phone number (`+2519******67`); no user ID or name.
- **Delivery:** verifying opens one `prize_deliveries` row. Status moves one step at a time,
  `PENDING` → `CONTACTED` → `VERIFIED` → `DISPATCHED` → `DELIVERED`; `DISPUTED` can be set from
  any status and left for any later step, both with a note. Dispatching and delivering need the
  recipient name, phone and address. Each change adds a `prize_delivery_events` row.
- **Delivery details:** the winner can send recipient and address while the delivery is
  `PENDING` or `CONTACTED`; after that only SUPPORT or ADMIN can change them.
- Every action row-locks the winner, and writes an audit record with before/after values.

### Notifications

- **Recording:** a notification is written inside the transaction of the event it reports (bid,
  wallet credit, result, cancellation, winner action, delivery step), so it exists exactly when
  the event does: a rolled-back or replayed request leaves none behind. The write runs in a
  savepoint; if it fails, only the notification is lost and the event still commits.
- **Events:** bid confirmation, low balance (the balance no longer covers one bid fee), wallet
  credit, closing reminder, auction result (won, lost, no unique bid, cancelled), winner
  verified or rejected, and each prize delivery step.
- **Closing reminder:** the lifecycle job reminds each bidder of an `ACTIVE` auction once,
  `AUCTION_CLOSING_REMINDER_MINUTES` before it closes. Auctions shorter than that get none.
  `auctions.closing_reminder_sent_at` is set in the same statement that selects the auction, so
  concurrent workers send one reminder.
- **Privacy:** a user reads and marks only their own in-app rows; another user's ID answers
  `404`. Text and `data` carry no bid amounts, no other bidder, no staff note and no rejection
  reason. Losing bidders get the winning amount, which is already public, not the winner.
- **Channels:** `IN_APP` rows are the inbox. SMS, email and push are `NotificationProvider`
  implementations registered under `NOTIFICATION_PROVIDERS`; each one chooses the types it
  accepts and gets its own `PENDING` row per notification. None is registered, so nothing is
  sent outside the system.
- **Dispatch:** a BullMQ job (`NOTIFICATION_DISPATCH_INTERVAL_SECONDS`) sends `PENDING` rows of
  external channels. Each row is locked with `FOR UPDATE SKIP LOCKED`, so concurrent workers do
  not send it twice. A failure is retried after 1, 5, 30 and 120 minutes and marked `FAILED`
  after 5 attempts. Delivery is at least once: a crash between sending and recording can repeat
  a message.

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

- **Payment callbacks** are stored raw in `payment_provider_events` with a unique provider
  event ID; a wallet is credited at most once per provider transaction.
- **Deposits and withdrawals** will carry an `Idempotency-Key` like bids do, so a retry returns
  the original result instead of moving money twice.

### Database connections inside a transaction

Code that runs inside a database transaction must read and write through that transaction's client,
never through the shared client. A second query through the pool needs a second connection while the
first is held; once as many requests are in that state as the pool has connections, all of them wait
for each other until they time out. The load test found three such places (currency lookup while
charging a bid fee, OTP verification, the result re-check during winner verification); all were
fixed. `npm run test:e2e:pool` runs the integration tests with a pool of one connection, where any
such query fails within seconds.

Where a write must survive a rollback (the OTP attempt counter), it is done before the transaction
starts, not on a second connection inside it.

A request that cannot get a connection or a transaction in time is answered `503 SERVICE_BUSY` with
`Retry-After`, not `500`.

## 7. Configuration and environments

All settings come from environment variables, validated at startup; the app refuses to start
on a bad configuration. In production it additionally refuses placeholder secrets, the
development OTP provider, and serves API docs only if `SWAGGER_ENABLED=true` is set explicitly.
See `.env.example` for the full list.

## 8. Testing

- Unit tests (`npm test`): environment validation, OTP sender selection, phone parsing, roles guard,
  money formatting, ledger posting validation.
- Integration tests (`npm run test:e2e`): boot the real application against PostgreSQL and
  Redis (database `lub_test`, Redis DB 1) and drive it over HTTP. Only SMS delivery is
  replaced, by a sender that captures messages so tests read the code the way a user would.
  The test setup refuses to run against a database whose name does not contain `test`.

  Wallet tests cover concurrent spending, idempotent retries, rollback, immutability triggers,
  reversal, freezing, reconciliation and role checks on every admin route.

  Product and auction tests cover validation, role checks on every admin route, each lifecycle
  transition and its refusals, concurrent activation, product protection while an auction is
  live, the open/close sweep (including concurrent sweeps) and the background job itself.

  Bidding tests cover single and multiple bids, all-or-nothing rejection, insufficient funds,
  frozen wallets, duplicate bids, limits, idempotent and concurrent retries, the deadline,
  simultaneous bidders, overdraft attempts, immutability, privacy and refunds on cancellation.

  Result tests cover the calculation (unit and end to end), each outcome and no-unique-bid
  policy, exactly-once refunds, concurrent finalization, bids racing the close, immutability of
  results, the re-check and role checks.

  Winner tests cover verification, rejection, the result re-check before verifying, publishing
  and the public list, every delivery step and its requirements, the winner's own delivery
  details, audit records and role checks.

  Notification tests cover every event and its wording, privacy between users and towards
  losing bidders, paging and read state, replayed and concurrent requests, closing reminders,
  events completing when the notification cannot be written, and a fake external provider for
  filtering by type, retries, giving up, concurrent dispatchers and the background job.

  Admin tests cover the user list, search and filters, each status change and its effect on
  sessions, privilege escalation (staff acting on staff, self-management, self-granted roles,
  two SUPER_ADMINs demoting each other at once), role assignment, the staff password reset and
  the forced change, where the temporary password is stored, audit and security-event filters,
  dashboard figures including refunds, auction statistics and role checks on every route.

  Hardening tests: `test/api-contract.e2e-spec.ts` reads the routes from the controllers and checks
  that each one rejects missing and invalid tokens (and ordinary users, for `/admin`), that the
  OpenAPI document describes exactly those routes, and the response headers, CORS and error shape.
  `load/bidding-load-test.mjs` drives a running API with hundreds of concurrent bidders and then
  compares bid counts, the winner, every wallet and the ledger with what the clients were told.
  Results are in `docs/DEPLOYMENT.md`.

## 9. Not built yet / decisions needed

- Payments (user deposits, provider callbacks) and withdrawals.
- SMS, email or push delivery of notifications: the abstraction exists, no provider does.
- What happens to the prize and the fees when a winner is rejected.
- The `EXTEND_AUCTION` no-unique-bid policy.
- Product image upload: images are external URLs for now.
- Real-money payments and public paid auctions must wait for legal and regulatory review.
