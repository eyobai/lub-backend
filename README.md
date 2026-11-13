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

With `OTP_PROVIDER=console`, verification codes are written to the application log. This
provider is rejected when `NODE_ENV=production`.

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
| POST   | `/register`            | Public | Create account, send verification code              |
| POST   | `/verify-phone`        | Public | Confirm code, sign in                               |
| POST   | `/resend-verification` | Public | Send a new verification code                        |
| POST   | `/login`               | Public | Phone + password sign-in                            |
| POST   | `/refresh`             | Public | Rotate refresh token, get a new pair                |
| POST   | `/logout`              | Public | Revoke the session of the given refresh token       |
| POST   | `/logout-all`          | Bearer | Revoke all sessions                                 |
| POST   | `/forgot-password`     | Public | Send a password-reset code                          |
| POST   | `/reset-password`      | Public | Set a new password with the code                    |
| POST   | `/change-password`     | Bearer | Change password, replace all sessions               |
| GET    | `/me`                  | Bearer | Current user                                        |
