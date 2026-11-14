#!/usr/bin/env node
/**
 * Bidding load test. Drives a running API over HTTP only, then checks that what the server recorded is exactly
 * what the clients were told: bid counts, every wallet balance, the ledger and the winning amount.
 *
 * Run it against a disposable environment, never production: it registers users and credits their wallets.
 * The API must be started with THROTTLE_LIMIT and AUTH_THROTTLE_LIMIT raised, because all traffic comes from one IP.
 *
 *   BASE_URL=http://localhost:3000 ADMIN_PHONE=+2519... ADMIN_PASSWORD=... node load/bidding-load-test.mjs
 *
 * Optional: USERS (200), DURATION_SECONDS (60), AMOUNTS (400 distinct bid amounts), RUN_ID (phone-number block).
 */
import { randomUUID } from 'node:crypto';

const BASE = `${process.env.BASE_URL ?? 'http://localhost:3000'}/api/v1`;
const USERS = Number(process.env.USERS ?? 200);
const DURATION = Number(process.env.DURATION_SECONDS ?? 60);
const AMOUNTS = Number(process.env.AMOUNTS ?? 400);
const RUN_ID = Number(process.env.RUN_ID ?? Math.floor(Math.random() * 900));
const FEE = 500n;
const STEP = 100n;
const PASSWORD = `Load-${randomUUID()}`;
const { ADMIN_PHONE, ADMIN_PASSWORD } = process.env;
if (!ADMIN_PHONE || !ADMIN_PASSWORD) throw new Error('ADMIN_PHONE and ADMIN_PASSWORD (a SUPER_ADMIN) are required');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (n) => Math.floor(Math.random() * n);

/** One HTTP call. A network failure is retried with the same idempotency key, so every request has a known outcome. */
async function call(method, path, { token, body, key } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(key ? { 'idempotency-key': key } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text ? JSON.parse(text) : {},
        replayed: res.headers.get('idempotent-replayed'),
      };
    } catch (err) {
      if (attempt >= 5) throw err;
      networkRetries++;
      await sleep(200 * attempt);
    }
  }
}
async function ok(method, path, options) {
  const res = await call(method, path, options);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

let networkRetries = 0;
const failures = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures.push(name);
};

// ── Set-up ──────────────────────────────────────────────────────────────────────────────────────────────────
const admin = (await ok('POST', '/auth/login', { body: { phoneNumber: ADMIN_PHONE, password: ADMIN_PASSWORD } })).tokens
  .accessToken;

console.log(`Registering and funding ${USERS} users (run ${RUN_ID}) ...`);
const users = Array.from({ length: USERS }, (_, i) => ({
  phoneNumber: `+2519${String(10_000_000 + RUN_ID * 10_000 + i)}`,
  // Every tenth user can afford only a few bids, so "not enough money" is exercised under load too.
  initial: i % 10 === 0 ? FEE * 7n : FEE * 5000n,
  spent: 0n,
  used: new Set(),
  history: [],
}));
await pool(users, 8, async (user) => {
  const reg = await ok('POST', '/auth/register', { body: { phoneNumber: user.phoneNumber, password: PASSWORD } });
  user.id = reg.userId;
  user.token = reg.tokens.accessToken;
  await ok('POST', `/admin/wallets/${user.id}/adjustments`, {
    token: admin,
    key: randomUUID(),
    body: { direction: 'CREDIT', amountMinor: user.initial.toString(), reason: 'Load test funding' },
  });
});

const product = await ok('POST', '/admin/products', {
  token: admin,
  body: { name: `Load test prize ${RUN_ID}`, marketValueMinor: '5000000' },
});
const closesAt = new Date(Date.now() + DURATION * 1000);
const auction = await ok('POST', '/admin/auctions', {
  token: admin,
  body: {
    productId: product.id,
    title: `Load test ${RUN_ID}`,
    bidFeeMinor: FEE.toString(),
    minBidMinor: STEP.toString(),
    maxBidMinor: (STEP * BigInt(AMOUNTS)).toString(),
    bidStepMinor: STEP.toString(),
    opensAt: new Date().toISOString(),
    closesAt: closesAt.toISOString(),
    noUniqueBidPolicy: 'NO_WINNER',
  },
});
await ok('POST', `/admin/auctions/${auction.id}/activate`, { token: admin });
console.log(`Auction ${auction.id} is open for ${DURATION}s; ${USERS} users bidding at once ...`);

// ── Load ────────────────────────────────────────────────────────────────────────────────────────────────────
const accepted = new Map(); // amount in minor units -> how many bids the server confirmed
const outcomes = {};
const latencies = [];
const unexpected = [];
let acceptedBids = 0;
let acceptedAfterClose = 0;
let replayMismatches = 0;
const count = (name) => (outcomes[name] = (outcomes[name] ?? 0) + 1);

/** Low amounts are far more popular than high ones, as in a real lowest-unique-bid auction. */
const pickAmount = () =>
  BigInt(1 + Math.min(AMOUNTS - 1, Math.floor(-Math.log(1 - Math.random()) * (AMOUNTS / 6)))) * STEP;

async function bidder(user) {
  // Keep sending for a few seconds after the close to prove that late bids are refused.
  while (Date.now() < closesAt.getTime() + 3000) {
    const dice = Math.random();
    let amounts;
    let key = randomUUID();
    let expect = 'new';
    if (dice < 0.08 && user.history.length > 0) {
      // A client retry: same key and body as an earlier request. Must not charge or bid again.
      const earlier = user.history[rand(user.history.length)];
      ({ key, amounts } = earlier);
      expect = 'replay';
    } else if (dice < 0.14 && user.used.size > 0) {
      // An amount this user has already bid, under a new key. Must be refused as a duplicate.
      amounts = [[...user.used][rand(user.used.size)]];
      expect = 'duplicate';
    } else {
      const fresh = new Set();
      for (let i = 1 + rand(5); i > 0; i--) {
        const amount = pickAmount();
        if (!user.used.has(amount)) fresh.add(amount);
      }
      if (fresh.size === 0) continue;
      amounts = [...fresh];
    }

    const sentAt = Date.now();
    const started = performance.now();
    const res = await call('POST', `/auctions/${auction.id}/bids`, {
      token: user.token,
      key,
      body: { amountsMinor: amounts.map(String) },
    });
    latencies.push(performance.now() - started);

    if (res.status === 201 && res.replayed) {
      count('201 replayed (no new charge)');
      if (expect !== 'replay') replayMismatches++;
    } else if (res.status === 201) {
      count('201 accepted');
      if (expect !== 'new' || res.body.bidCount !== amounts.length) replayMismatches++;
      if (sentAt > closesAt.getTime()) acceptedAfterClose++;
      acceptedBids += amounts.length;
      user.spent += FEE * BigInt(amounts.length);
      user.history.push({ key, amounts });
      for (const amount of amounts) {
        user.used.add(amount);
        accepted.set(amount, (accepted.get(amount) ?? 0) + 1);
      }
    } else {
      count(`${res.status} ${res.body.error}`);
      const allowed =
        (res.status === 409 && res.body.error === 'DUPLICATE_BID' && expect === 'duplicate') ||
        // Refused for lack of money only when this user really cannot afford the request.
        (res.status === 422 &&
          res.body.error === 'INSUFFICIENT_FUNDS' &&
          expect === 'new' &&
          user.initial - user.spent < FEE * BigInt(amounts.length)) ||
        ['AUCTION_CLOSED', 'AUCTION_NOT_OPEN'].includes(res.body.error);
      if (!allowed && unexpected.length < 10) unexpected.push({ status: res.status, body: res.body, expect });
      if (!allowed) count('UNEXPECTED');
      if (res.body.error === 'INSUFFICIENT_FUNDS' || ['AUCTION_CLOSED', 'AUCTION_NOT_OPEN'].includes(res.body.error)) {
        await sleep(250);
      }
    }
  }
}

const loadStarted = Date.now();
await Promise.all(users.map(bidder));
const loadSeconds = (Date.now() - loadStarted) / 1000;

// ── Results ─────────────────────────────────────────────────────────────────────────────────────────────────
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))].toFixed(0);
console.log(`\nLoad: ${latencies.length} bid requests in ${loadSeconds.toFixed(1)}s from ${USERS} concurrent users`);
console.log(`  throughput ${(latencies.length / loadSeconds).toFixed(0)} requests/s, ${acceptedBids} bids accepted`);
console.log(`  latency ms: p50 ${pct(50)}, p95 ${pct(95)}, p99 ${pct(99)}, max ${latencies.at(-1).toFixed(0)}`);
console.log(`  network retries: ${networkRetries}`);
for (const [name, n] of Object.entries(outcomes).sort()) console.log(`  ${String(n).padStart(7)}  ${name}`);
if (unexpected.length) console.log('  unexpected responses:', JSON.stringify(unexpected, null, 2));

console.log('\nWaiting for the result ...');
let result;
for (let i = 0; i < 120; i++) {
  const res = await call('GET', `/auctions/${auction.id}/result`);
  if (res.status === 200 && res.body.outcome) {
    result = res.body;
    break;
  }
  await sleep(1000);
}

// The expected winner, worked out here from the confirmations alone.
const unique = [...accepted.entries()].filter(([, n]) => n === 1).map(([amount]) => amount);
const expectedWinner = unique.length ? unique.reduce((a, b) => (a < b ? a : b)) : null;

console.log('\nChecks');
const serverErrors = Object.entries(outcomes).filter(([name]) => name.startsWith('5'));
check('no server errors (5xx)', serverErrors.length === 0, JSON.stringify(Object.fromEntries(serverErrors)));
check('no unexpected refusals', !outcomes.UNEXPECTED, `${outcomes.UNEXPECTED ?? 0}`);
check('retries were replayed, new requests were not', replayMismatches === 0, `${replayMismatches} mismatches`);
check('no bid was accepted after the closing time', acceptedAfterClose === 0, `${acceptedAfterClose}`);
check('a result was computed', Boolean(result), result ? `${result.outcome}` : 'none after 120s');
if (result) {
  check(
    'bid count in the result equals confirmed bids',
    result.totalBids === acceptedBids,
    `${result.totalBids} vs ${acceptedBids}`,
  );
  check(
    'winning amount equals the lowest amount confirmed exactly once',
    (result.winningAmountMinor ?? null) === (expectedWinner === null ? null : expectedWinner.toString()),
    `server ${result.winningAmountMinor}, expected ${expectedWinner}`,
  );
  const audit = await ok('GET', `/admin/auctions/${auction.id}/result/audit`, { token: admin });
  check('stored result matches a recomputation from the stored bids', audit.matches === true);
}
const stats = await ok('GET', `/admin/auctions/${auction.id}/statistics`, { token: admin });
check(
  'auction statistics agree',
  stats.bidCount === acceptedBids && stats.feesChargedMinor === (FEE * BigInt(acceptedBids)).toString(),
  `${stats.bidCount} bids, fees ${stats.feesChargedMinor}`,
);

let wrongBalances = 0;
await pool(users, 16, async (user) => {
  const wallet = await ok('GET', '/wallet', { token: user.token });
  if (wallet.availableMinor !== (user.initial - user.spent).toString() || BigInt(wallet.availableMinor) < 0n)
    wrongBalances++;
});
check(
  `every wallet balance equals funding minus confirmed fees (${USERS} wallets)`,
  wrongBalances === 0,
  `${wrongBalances} wrong`,
);

const report = await ok('GET', '/admin/ledger/reconciliation', { token: admin });
check(
  'ledger reconciliation is clean',
  report.ok === true && report.issues.length === 0,
  `${report.transactions} transactions, ${report.entries} lines, ${report.issues.length} issues`,
);

console.log(failures.length ? `\nFAILED: ${failures.join('; ')}` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
