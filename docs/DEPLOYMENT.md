# Deployment notes

How to run the backend in production, and what was verified before hand-off (Phase 11).
Payments, withdrawals and SMS delivery are not built; do not take real money with this version.

## What you need

| Component  | Version | Notes                                                                        |
| ---------- | ------- | ---------------------------------------------------------------------------- |
| API image  | Node 22 | Built from `Dockerfile`; runs as the non-root `node` user, listens on 3000   |
| PostgreSQL | 16      | One database. Take backups: the ledger is the record of every user's money   |
| Redis      | 7       | Sessions, rate limits, login lockout and background jobs. Enable persistence |
| TLS proxy  | any     | The API speaks plain HTTP; terminate HTTPS in front of it                    |

## Configuration

All settings are environment variables; `.env.example` lists every one. The API refuses to start if a
value is missing or invalid. With `NODE_ENV=production` it also refuses placeholder secrets and the
development OTP provider.

Set at least:

| Variable                                                     | Value                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `NODE_ENV`                                                   | `production`                                                   |
| `DATABASE_URL`                                               | PostgreSQL URL; see "Database connections" below               |
| `REDIS_URL`                                                  | Redis URL                                                      |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OTP_HMAC_SECRET` | Three different values from `openssl rand -base64 48`          |
| `CORS_ORIGINS`                                               | Comma-separated origins of the web front ends                  |
| `TRUST_PROXY`                                                | `true` when the API is behind a reverse proxy or load balancer |
| `PHONE_VERIFICATION_REQUIRED`, `OTP_PROVIDER`                | `false` and `none` (no SMS)                                    |

Keep secrets in the platform's secret store, not in the image or the repository. Changing a JWT secret
signs every user out.

`TRUST_PROXY` matters for rate limiting. Limits are counted per client IP address. Behind a proxy with
`TRUST_PROXY=false` every user appears to come from the proxy and they share one limit; with
`TRUST_PROXY=true` and no proxy, a client can fake its address with an `X-Forwarded-For` header. The
proxy must overwrite that header, not append to a client-supplied one.

API documentation (`/docs`) is off in production unless `SWAGGER_ENABLED=true`. The same document is in
the repository as `docs/openapi.json` (`npm run openapi` regenerates it).

## Release steps

```bash
docker build -t lub-auction-backend:<version> .

# 1. Apply database migrations (once per release, before starting the new version)
docker run --rm --env-file prod.env lub-auction-backend:<version> npx prisma migrate deploy

# 2. First release only: create the first SUPER_ADMIN (SEED_ADMIN_PHONE, SEED_ADMIN_PASSWORD)
docker run --rm --env-file prod.env lub-auction-backend:<version> node dist/scripts/seed-admin.js

# 3. Start the API
docker run -d --env-file prod.env -p 3000:3000 lub-auction-backend:<version>
```

Migrations are never applied on start-up, so several API instances can start at once. Remove
`SEED_ADMIN_PASSWORD` from the environment after the first release; the script never changes the
password of an account that already exists. If the number already belongs to an account, that account is
promoted to SUPER_ADMIN, so run the script only with a number you control.

Health checks: `GET /health` (process is up) and `GET /health/ready` (database and Redis reachable;
returns 503 otherwise). Point the load balancer at `/health/ready`.

Several API instances can run side by side: sessions, rate limits and job scheduling live in Redis, and
every money or bidding operation is serialized in PostgreSQL. Each instance also runs the background
jobs (opening and closing auctions, computing results, refunds, reminders); they are safe to run
concurrently.

## Database connections

Each API instance keeps a pool of database connections. The default size is `CPU cores × 2 + 1`. Set it
explicitly with `?connection_limit=N` at the end of `DATABASE_URL`, and keep
`instances × N` below PostgreSQL's `max_connections` (default 100).

When a request cannot get a database connection in time (2 to 10 seconds, depending on the operation), it gets `503 SERVICE_BUSY` with `Retry-After: 2`.
Nothing is recorded for such a request, and bids are safe to retry with the same `Idempotency-Key`.

## Capacity measured

Load test: `load/bidding-load-test.mjs` against the production image, one API instance, PostgreSQL and
Redis on the same 8-core machine.

| Simultaneous bidders | Bid requests  | Accepted bids | Accepted requests/s | Median | 95th percentile | Server errors |
| -------------------- | ------------- | ------------- | ------------------- | ------ | --------------- | ------------- |
| 20                   | 729 in 13 s   | 979           | about 45            | 0.37 s | 0.52 s          | 0             |
| 200                  | 3,751 in 64 s | 5,899         | about 42            | 3.8 s  | 5.2 s           | 0             |

After each run the test compared the server with what the clients were told: the bid count, the winning
amount (worked out independently), all wallet balances and the ledger reconciliation. All matched, no
bid was accepted after the closing time, and retried requests were never charged twice.

What this means:

- Throughput is 40 to 45 accepted bid requests per second in total (roughly 100 bids per second, as a
  request can carry several amounts). Bids are processed one at a time, because each one updates the
  auction and the platform revenue account. More API instances do not raise this figure.
- Waiting time grows with the number of people bidding at the same instant: about 0.4 s with 20, about
  4 s with 200. Expect the slowest responses in the last seconds before an auction closes.
- Raising this limit needs a design change (for example, not updating the revenue balance on every bid).
  Measure real traffic first.

To repeat the test, start the API with `THROTTLE_LIMIT` and `AUTH_THROTTLE_LIMIT` raised (all test
traffic comes from one address) against a disposable database, then:

```bash
BASE_URL=http://localhost:3000 ADMIN_PHONE=+2519... ADMIN_PASSWORD=... USERS=200 DURATION_SECONDS=60 npm run test:load
```

## Security review

| Check                      | Result                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route authorization        | Automated (`test/api-contract.e2e-spec.ts`): every route except 14 public ones rejects a missing or invalid token; every `/admin` route rejects an ordinary user                                                  |
| API documentation          | Automated: the documented routes are exactly the routes served; each has a summary, auth and errors                                                                                                               |
| Rate limits                | 120 requests/minute per IP, 10/minute on sign-in and registration routes; a faked `X-Forwarded-For` does not bypass them                                                                                          |
| Sign-in lockout            | 5 wrong passwords lock the number for 15 minutes                                                                                                                                                                  |
| Response headers           | Helmet defaults (HSTS, no-sniff, frame and content-security policy); `X-Powered-By` removed                                                                                                                       |
| CORS                       | Only origins in `CORS_ORIGINS` are allowed                                                                                                                                                                        |
| Logs                       | Requests are logged as method, path, IP, status and duration. No headers, bodies, passwords, tokens or secrets: checked in the logs of the load-test run                                                          |
| Errors                     | One JSON shape; unexpected errors return a generic message and a `requestId` to look up in the logs                                                                                                               |
| Request size               | Bodies over the 100 kB limit get `413 PAYLOAD_TOO_LARGE`                                                                                                                                                          |
| SQL                        | No string-built SQL; all raw queries are parameterized                                                                                                                                                            |
| Dependencies (`npm audit`) | 3 high-severity reports, all one issue in `deepmerge-ts`, used only by the Prisma command-line tool when it reads its own configuration. Not reachable from a request. The fix needs Prisma 7, a breaking upgrade |

## Known limits

- Rate limits are per IP address. Many mobile users in Ethiopia share an address through their
  carrier, so a busy auction can hit the general limit for honest users. Raise `THROTTLE_LIMIT`, or
  ask for per-user limits to be added.
- A forgotten password is reset by staff (`POST /admin/users/:id/reset-password`); there is no SMS.
- Wallets are funded by a FINANCE user only; there is no deposit or withdrawal.
- Notifications are in-app only.
- Audit logs, security events and notifications are never deleted. Plan archiving as they grow.
