# LUB Auction Backend

Backend API for a Lowest Unique Bid auction platform (Ethiopia first, ETB). NestJS, TypeScript,
PostgreSQL (Prisma), Redis, BullMQ.

Design and security decisions are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run locally

Needs Node.js 22 and Docker.

```bash
cp .env.example .env
docker compose up -d            # PostgreSQL 16 + Redis 7
npm install
npx prisma generate             # build the database client
npm run db:deploy               # apply migrations
npm run start:dev
```

- API: http://localhost:3000/api/v1
- Swagger UI: http://localhost:3000/docs (OpenAPI JSON at `/docs/openapi.json`)
- Health: `GET /health`, `GET /health/ready`

By default (`PHONE_VERIFICATION_REQUIRED=false`) users register with a phone number and password
only: no SMS is sent and no SMS provider is needed. Setting it to `true` turns on SMS codes for
registration and password reset and needs an `OTP_PROVIDER`; the `console` provider (codes written
to the log) is for development and is rejected when `NODE_ENV=production`.

To run the API in Docker as well: `docker compose --profile app up -d --build`.

## Commands

| Command                 | Purpose                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `npm run start:dev`     | Start with reload                                                                      |
| `npm run build`         | Compile to `dist/`                                                                     |
| `npm run lint`          | ESLint                                                                                 |
| `npm run typecheck`     | TypeScript check                                                                       |
| `npm test`              | Unit tests                                                                             |
| `npm run test:e2e`      | Integration tests (needs `docker compose up -d`)                                       |
| `npm run test:e2e:pool` | The same tests with one database connection; fails if a transaction needs a second one |
| `npm run test:load`     | Bidding load test against a running API (see `docs/DEPLOYMENT.md`)                     |
| `npm run openapi`       | Write the API description to `docs/openapi.json`                                       |
| `npm run db:migrate`    | Create and apply a migration in development                                            |
| `npm run db:deploy`     | Apply pending migrations                                                               |
| `npm run seed`          | Create the first SUPER_ADMIN from `SEED_ADMIN_PHONE` / `SEED_ADMIN_PASSWORD`           |

Production deployment, measured capacity and the security review are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Authentication endpoints

All under `/api/v1/auth`.

| Method | Path                   | Auth   | Purpose                                          |
| ------ | ---------------------- | ------ | ------------------------------------------------ |
| POST   | `/register`            | Public | Create account and sign in                       |
| POST   | `/verify-phone`        | Public | Confirm SMS code, sign in (SMS mode only)        |
| POST   | `/resend-verification` | Public | Send a new verification code (SMS mode only)     |
| POST   | `/login`               | Public | Phone + password sign-in                         |
| POST   | `/refresh`             | Public | Rotate refresh token, get a new pair             |
| POST   | `/logout`              | Public | Revoke the session of the given refresh token    |
| POST   | `/logout-all`          | Bearer | Revoke all sessions                              |
| POST   | `/forgot-password`     | Public | Send a password-reset code (SMS mode only)       |
| POST   | `/reset-password`      | Public | Set a new password with the code (SMS mode only) |
| POST   | `/change-password`     | Bearer | Change password, replace all sessions            |
| GET    | `/me`                  | Bearer | Current user                                     |

"SMS mode only" endpoints answer `403 SMS_VERIFICATION_DISABLED` while
`PHONE_VERIFICATION_REQUIRED=false`.

After staff reset a password, the account answers `403 PASSWORD_CHANGE_REQUIRED` on everything
except `/me`, `/change-password` and `/logout-all` until its owner chooses a new password.

## Wallet endpoints

All amounts are integer minor units (santim) sent as strings, with a formatted copy for display.

| Method | Path                                         | Auth                    | Purpose                                   |
| ------ | -------------------------------------------- | ----------------------- | ----------------------------------------- |
| GET    | `/wallet`                                    | Bearer                  | My balance (wallet created on first use)  |
| GET    | `/wallet/transactions`                       | Bearer                  | My history, newest first, cursor paging   |
| GET    | `/wallet/transactions/:id`                   | Bearer                  | One of my transactions                    |
| GET    | `/admin/wallets/:userId`                     | SUPPORT, FINANCE, ADMIN | A user's balance                          |
| GET    | `/admin/wallets/:userId/transactions`        | SUPPORT, FINANCE, ADMIN | A user's history                          |
| POST   | `/admin/wallets/:userId/adjustments`         | FINANCE                 | Manual credit/debit (`Idempotency-Key`)   |
| POST   | `/admin/wallet-transactions/:id/reverse`     | FINANCE                 | Reverse an adjustment (`Idempotency-Key`) |
| POST   | `/admin/wallets/:userId/freeze`, `/unfreeze` | FINANCE                 | Block / allow spending                    |
| GET    | `/admin/ledger/reconciliation`               | FINANCE                 | Prove cached balances from ledger lines   |

`SUPER_ADMIN` passes every role check. A FINANCE user can still fund a test wallet with an
adjustment; real deposits go through the payment endpoints below.

## Deposit endpoints (Chapa)

Off unless `PAYMENT_PROVIDER=chapa`. A deposit never adds money by itself: the wallet is credited
only after this API has asked Chapa to verify the payment and the amount, currency, reference and
mode (test or live) all match.

| Method | Path                                 | Auth                    | Purpose                                                         |
| ------ | ------------------------------------ | ----------------------- | --------------------------------------------------------------- |
| GET    | `/wallet/deposit-options`            | Bearer                  | Whether deposits are on, the limits, and test or live mode      |
| POST   | `/wallet/deposits`                   | Bearer                  | Start a deposit (`Idempotency-Key`); answers with `checkoutUrl` |
| GET    | `/wallet/deposits`                   | Bearer                  | My deposits, newest first, a page at a time                      |
| GET    | `/wallet/deposits/:id`               | Bearer                  | One of my deposits; checks with Chapa while it is unconfirmed   |
| POST   | `/payments/chapa/webhook`            | Chapa signature         | Chapa's event notifications                                     |
| GET    | `/payments/chapa/callback`           | Public                  | Chapa's call after checkout; only triggers a verification       |
| GET    | `/admin/deposits`                    | SUPPORT, FINANCE, ADMIN | All deposits; filter by status, user, reference, needs review   |
| GET    | `/admin/deposits/:id`                | SUPPORT, FINANCE, ADMIN | One deposit with provider details                               |
| POST   | `/admin/deposits/:id/recheck`        | FINANCE                 | Ask Chapa again; credits the wallet if Chapa says it was paid   |
| POST   | `/admin/deposits/:id/resolve-review` | FINANCE                 | Clear the review flag with a note                               |

The flow for a client: `POST /wallet/deposits` with `{ "amountMinor": "50000" }`, send the user to
`checkoutUrl`, and when they come back to `<WEB_APP_URL>/wallet/deposits/<id>` read
`GET /wallet/deposits/:id` until `status` is no longer `PENDING`.

To try it locally in Chapa's test mode, set in `.env`:

```
PAYMENT_PROVIDER=chapa
CHAPA_SECRET_KEY=<your CHASECK_TEST-... key>
CHAPA_WEBHOOK_SECRET=<any 16+ random characters>
WEB_APP_URL=http://localhost:5173
```

Chapa cannot reach a laptop, so leave `PUBLIC_API_URL` empty; the deposit is then confirmed when the
user returns from checkout, and by the background check once a minute. Withdrawals are not built.

## Product and auction endpoints

| Method | Path                                     | Auth                    | Purpose                                        |
| ------ | ---------------------------------------- | ----------------------- | ---------------------------------------------- |
| GET    | `/auctions`                              | none                    | Upcoming, running and finished auctions        |
| GET    | `/auctions/:id`                          | none                    | One public auction, with its product           |
| GET    | `/admin/products`, `/admin/products/:id` | SUPPORT, FINANCE, ADMIN | Product catalogue                              |
| POST   | `/admin/products`                        | ADMIN                   | Create a product (images are URLs)             |
| PATCH  | `/admin/products/:id`                    | ADMIN                   | Edit a product, change its status              |
| GET    | `/admin/auctions`, `/admin/auctions/:id` | SUPPORT, FINANCE, ADMIN | Auctions in any status                         |
| POST   | `/admin/auctions`                        | ADMIN                   | Create an auction as a `DRAFT`                 |
| PATCH  | `/admin/auctions/:id`                    | ADMIN                   | Edit (everything until bidding opens)          |
| POST   | `/admin/auctions/:id/schedule`           | ADMIN                   | `DRAFT` → `SCHEDULED`; opens itself at opensAt |
| POST   | `/admin/auctions/:id/unschedule`         | ADMIN                   | `SCHEDULED` → `DRAFT`                          |
| POST   | `/admin/auctions/:id/activate`           | ADMIN                   | Open for bidding now                           |
| POST   | `/admin/auctions/:id/cancel`             | ADMIN                   | Cancel with a reason; refunds bid fees         |

Auctions open and close by the database clock. A background job (every
`AUCTION_SWEEP_INTERVAL_SECONDS`, default 5) moves `SCHEDULED` → `ACTIVE` at `opensAt` and
`ACTIVE` → `CLOSING` at `closesAt`, then computes the result and moves `CLOSING` → `COMPLETED`.
Dates must carry a time zone, e.g. `2027-01-31T09:00:00+03:00`.

## Bidding endpoints

| Method | Path                       | Auth                    | Purpose                                              |
| ------ | -------------------------- | ----------------------- | ---------------------------------------------------- |
| POST   | `/auctions/:id/bids`       | Bearer                  | Place one or several bids (`Idempotency-Key` header) |
| GET    | `/bids/mine`               | Bearer                  | My bids, newest first; `?auctionId=` narrows it      |
| GET    | `/admin/auctions/:id/bids` | SUPPORT, FINANCE, ADMIN | Every bid of an auction                              |

`POST /auctions/:id/bids` takes `{ "amountsMinor": ["500", "1000"] }`. One fee is charged per amount,
all or nothing. Staff accounts cannot bid. Cancelling an auction refunds every bid fee paid in it.

## Result endpoints

| Method | Path                               | Auth                    | Purpose                                            |
| ------ | ---------------------------------- | ----------------------- | -------------------------------------------------- |
| GET    | `/auctions/:id/result`             | Public                  | Outcome, winning amount and bid count              |
| GET    | `/auctions/:id/result/mine`        | Bearer                  | The result plus how each of my bids fared          |
| GET    | `/admin/auctions/:id/result`       | SUPPORT, FINANCE, ADMIN | Full result: winner, counts per amount, input hash |
| GET    | `/admin/auctions/:id/result/audit` | SUPPORT, FINANCE, ADMIN | Recompute from the bids and compare                |
| POST   | `/admin/auctions/:id/finalize`     | ADMIN                   | Compute the result now (normally automatic)        |

The winner is the lowest amount that was bid exactly once. If no amount is unique, the auction's
`noUniqueBidPolicy` applies: `NO_WINNER` keeps the fees, `REFUND_BID_FEES` returns them.

## Winner and delivery endpoints

| Method | Path                                 | Auth                    | Purpose                                       |
| ------ | ------------------------------------ | ----------------------- | --------------------------------------------- |
| GET    | `/winners`                           | Public                  | Recent winners (verified and published)       |
| GET    | `/winners/mine`                      | Bearer                  | My wins, verification and delivery progress   |
| PUT    | `/winners/mine/:id/delivery-details` | Bearer                  | Send who receives my prize and where          |
| GET    | `/admin/winners`, `/:id`             | SUPPORT, FINANCE, ADMIN | List and view winners with delivery history   |
| POST   | `/admin/winners/:id/verify`          | ADMIN                   | Verify a winner; opens the prize delivery     |
| POST   | `/admin/winners/:id/reject`          | ADMIN                   | Reject a winner with a reason                 |
| POST   | `/admin/winners/:id/publish`         | ADMIN                   | Show a verified winner in the public list     |
| POST   | `/admin/winners/:id/unpublish`       | ADMIN                   | Remove a winner from the public list          |
| PATCH  | `/admin/winners/:id/delivery`        | SUPPORT, ADMIN          | Update recipient, address, tracking and notes |
| POST   | `/admin/winners/:id/delivery/status` | SUPPORT, ADMIN          | Move the delivery to its next status          |

Delivery statuses: `PENDING` → `CONTACTED` → `VERIFIED` → `DISPATCHED` → `DELIVERED`, plus
`DISPUTED`, which can be set from any status.

## Notification endpoints

| Method | Path                          | Auth   | Purpose                                               |
| ------ | ----------------------------- | ------ | ----------------------------------------------------- |
| GET    | `/notifications`              | Bearer | My notifications, newest first (`unreadOnly`, `type`) |
| GET    | `/notifications/unread-count` | Bearer | How many I have not read                              |
| POST   | `/notifications/:id/read`     | Bearer | Mark one as read                                      |
| POST   | `/notifications/read-all`     | Bearer | Mark all as read                                      |

Notifications are written for bid confirmations, low balance, wallet credits, closing reminders
(`AUCTION_CLOSING_REMINDER_MINUTES`, default 60, `0` turns them off), auction results and
cancellations, winner verification and prize delivery steps. They are stored in-app only: no SMS,
email or push provider is registered, so nothing leaves the system.

## Admin management endpoints

| Method | Path                               | Roles                   | Purpose                                                                 |
| ------ | ---------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| GET    | `/admin/users`                     | SUPPORT, FINANCE, ADMIN | List users (`search`, `status`, `role`, paging)                         |
| GET    | `/admin/users/:id`                 | SUPPORT, FINANCE, ADMIN | One user with session, bid and win counts                               |
| POST   | `/admin/users/:id/suspend`         | ADMIN                   | Suspend and sign out (reason required)                                  |
| POST   | `/admin/users/:id/block`           | ADMIN                   | Block and sign out (reason required)                                    |
| POST   | `/admin/users/:id/reactivate`      | ADMIN                   | Make the account active again                                           |
| PUT    | `/admin/users/:id/roles`           | SUPER_ADMIN             | Replace the account's back-office roles                                 |
| POST   | `/admin/users/:id/reset-password`  | SUPPORT, ADMIN          | Set a temporary password, shown once; signs the user out                |
| POST   | `/admin/users/:id/revoke-sessions` | SUPPORT, ADMIN          | Sign the user out of every device                                       |
| GET    | `/admin/audit-logs`                | ADMIN                   | Audit log (`actorId`, `action`, `entityType`, `entityId`, `from`, `to`) |
| GET    | `/admin/audit-logs/:id`            | ADMIN                   | One audit record with before/after values                               |
| GET    | `/admin/security-events`           | ADMIN                   | Sign-in activity (`type`, `userId`, `phoneNumber`, `from`, `to`)        |
| GET    | `/admin/dashboard`                 | FINANCE, ADMIN          | Users, auctions, bids, winners, deliveries and money                    |
| GET    | `/admin/auctions/:id/statistics`   | SUPPORT, FINANCE, ADMIN | Bidding figures of one auction                                          |

`SUPER_ADMIN` passes every role check. Nobody can act on their own account, and only a
`SUPER_ADMIN` can suspend, block, reset, sign out or change the roles of a staff account.
