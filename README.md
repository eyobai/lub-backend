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

| Command              | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `npm run start:dev`  | Start with reload                                            |
| `npm run build`      | Compile to `dist/`                                           |
| `npm run lint`       | ESLint                                                       |
| `npm run typecheck`  | TypeScript check                                             |
| `npm test`           | Unit tests                                                   |
| `npm run test:e2e`   | Integration tests (needs `docker compose up -d`)             |
| `npm run db:migrate` | Create and apply a migration in development                  |
| `npm run db:deploy`  | Apply pending migrations                                     |
| `npm run seed`       | Create the first SUPER_ADMIN from `SEED_ADMIN_PHONE` / `SEED_ADMIN_PASSWORD` |

## Authentication endpoints

All under `/api/v1/auth`.

| Method | Path                   | Auth   | Purpose                                             |
| ------ | ---------------------- | ------ | --------------------------------------------------- |
| POST   | `/register`            | Public | Create account and sign in                          |
| POST   | `/verify-phone`        | Public | Confirm SMS code, sign in (SMS mode only)           |
| POST   | `/resend-verification` | Public | Send a new verification code (SMS mode only)        |
| POST   | `/login`               | Public | Phone + password sign-in                            |
| POST   | `/refresh`             | Public | Rotate refresh token, get a new pair                |
| POST   | `/logout`              | Public | Revoke the session of the given refresh token       |
| POST   | `/logout-all`          | Bearer | Revoke all sessions                                 |
| POST   | `/forgot-password`     | Public | Send a password-reset code (SMS mode only)          |
| POST   | `/reset-password`      | Public | Set a new password with the code (SMS mode only)    |
| POST   | `/change-password`     | Bearer | Change password, replace all sessions               |
| GET    | `/me`                  | Bearer | Current user                                        |

"SMS mode only" endpoints answer `403 SMS_VERIFICATION_DISABLED` while
`PHONE_VERIFICATION_REQUIRED=false`.

## Wallet endpoints

All amounts are integer minor units (santim) sent as strings, with a formatted copy for display.

| Method | Path                                          | Auth                    | Purpose                                   |
| ------ | --------------------------------------------- | ----------------------- | ----------------------------------------- |
| GET    | `/wallet`                                     | Bearer                  | My balance (wallet created on first use)  |
| GET    | `/wallet/transactions`                        | Bearer                  | My history, newest first, cursor paging   |
| GET    | `/wallet/transactions/:id`                    | Bearer                  | One of my transactions                    |
| GET    | `/admin/wallets/:userId`                      | SUPPORT, FINANCE, ADMIN | A user's balance                          |
| GET    | `/admin/wallets/:userId/transactions`         | SUPPORT, FINANCE, ADMIN | A user's history                          |
| POST   | `/admin/wallets/:userId/adjustments`          | FINANCE                 | Manual credit/debit (`Idempotency-Key`)   |
| POST   | `/admin/wallet-transactions/:id/reverse`      | FINANCE                 | Reverse an adjustment (`Idempotency-Key`) |
| POST   | `/admin/wallets/:userId/freeze`, `/unfreeze`  | FINANCE                 | Block / allow spending                    |
| GET    | `/admin/ledger/reconciliation`                | FINANCE                 | Prove cached balances from ledger lines   |

`SUPER_ADMIN` passes every role check. There is no user-facing deposit endpoint yet: deposits
arrive with the payments module. Until then a FINANCE user funds test wallets with an adjustment.

## Product and auction endpoints

| Method | Path                                       | Auth                    | Purpose                                        |
| ------ | ------------------------------------------ | ----------------------- | ---------------------------------------------- |
| GET    | `/auctions`                                | none                    | Upcoming, running and finished auctions        |
| GET    | `/auctions/:id`                            | none                    | One public auction, with its product           |
| GET    | `/admin/products`, `/admin/products/:id`   | SUPPORT, FINANCE, ADMIN | Product catalogue                              |
| POST   | `/admin/products`                          | ADMIN                   | Create a product (images are URLs)             |
| PATCH  | `/admin/products/:id`                      | ADMIN                   | Edit a product, change its status              |
| GET    | `/admin/auctions`, `/admin/auctions/:id`   | SUPPORT, FINANCE, ADMIN | Auctions in any status                         |
| POST   | `/admin/auctions`                          | ADMIN                   | Create an auction as a `DRAFT`                 |
| PATCH  | `/admin/auctions/:id`                      | ADMIN                   | Edit (everything until bidding opens)          |
| POST   | `/admin/auctions/:id/schedule`             | ADMIN                   | `DRAFT` → `SCHEDULED`; opens itself at opensAt |
| POST   | `/admin/auctions/:id/unschedule`           | ADMIN                   | `SCHEDULED` → `DRAFT`                          |
| POST   | `/admin/auctions/:id/activate`             | ADMIN                   | Open for bidding now                           |
| POST   | `/admin/auctions/:id/cancel`               | ADMIN                   | Cancel with a reason (not once it has bids)    |

Auctions open and close by the database clock. A background job (every
`AUCTION_SWEEP_INTERVAL_SECONDS`, default 5) moves `SCHEDULED` → `ACTIVE` at `opensAt` and
`ACTIVE` → `CLOSING` at `closesAt`. `CLOSING` → `COMPLETED` arrives with winner calculation.
Dates must carry a time zone, e.g. `2027-01-31T09:00:00+03:00`.
