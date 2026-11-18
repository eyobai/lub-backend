import { RoleName } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { BidRefundService } from '../src/modules/bidding/bid-refund.service';
import { ReconciliationService } from '../src/modules/ledger/reconciliation.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd';
const HOUR = 3_600_000;
const FEE = 7500n;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

interface Account {
  id: string;
  token: string;
}

describe('Bidding', () => {
  let t: TestApp;
  let wallets: WalletService;
  let admin: Account;
  let phoneCounter = 0;

  beforeAll(async () => {
    t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' });
    wallets = t.app.get(WalletService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await account(0n, RoleName.ADMIN);
  });

  async function account(balanceMinor = 0n, ...roles: RoleName[]): Promise<Account> {
    const phoneNumber = `+2519${String(30000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    for (const name of roles) {
      const role = await t.prisma.role.findUniqueOrThrow({ where: { name } });
      await t.prisma.userRole.create({ data: { userId: res.body.userId, roleId: role.id } });
    }
    if (balanceMinor > 0n) await wallets.deposit({ userId: res.body.userId, amountMinor: balanceMinor });
    return { id: res.body.userId, token: res.body.tokens.accessToken };
  }

  /** An auction open for bidding: fee 75.00, amounts 1.00 … 1000.00 in steps of 1.00. */
  async function liveAuction(override: object = {}): Promise<string> {
    const product = await t.post('/admin/products', { name: 'Prize' }, admin.token);
    const body = {
      productId: product.body.id,
      title: 'Win a phone',
      bidFeeMinor: FEE.toString(),
      minBidMinor: '100',
      maxBidMinor: '100000',
      bidStepMinor: '100',
      opensAt: inHours(1),
      closesAt: inHours(25),
      noUniqueBidPolicy: 'NO_WINNER',
      ...override,
    };
    const { id } = (await t.post('/admin/auctions', body, admin.token).expect(201)).body;
    await t.post(`/admin/auctions/${id}/activate`, {}, admin.token).expect(200);
    return id;
  }

  const bid = (auctionId: string, user: Account, amountsMinor: unknown, key: string = randomUUID()) =>
    t.post(`/auctions/${auctionId}/bids`, { amountsMinor }, user.token).set('Idempotency-Key', key);
  const balance = async (user: Account): Promise<string> =>
    (await t.get('/wallet', user.token).expect(200)).body.availableMinor;
  const bidCount = (auctionId: string) => t.prisma.bid.count({ where: { auctionId } });
  const totalBidCount = async (auctionId: string) =>
    (await t.prisma.auction.findUniqueOrThrow({ where: { id: auctionId } })).totalBidCount;
  const expectLedgerConsistent = async () => {
    const report = await t.app.get(ReconciliationService).reconcile();
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  };
  /** Nothing was recorded and nothing was charged. */
  const expectUntouched = async (auctionId: string, user: Account, expectedBalance: bigint) => {
    expect(await bidCount(auctionId)).toBe(0);
    expect(await totalBidCount(auctionId)).toBe(0);
    expect(await t.prisma.bidSubmission.count()).toBe(0);
    expect(await balance(user)).toBe(expectedBalance.toString());
  };

  describe('placing bids', () => {
    it('records a single bid and charges one fee', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);

      const res = await bid(auctionId, user, ['500']).expect(201);

      expect(res.body).toMatchObject({
        auctionId,
        currency: 'ETB',
        bidCount: 1,
        bidFeeMinor: '7500',
        bidFee: '75.00',
        totalFeeMinor: '7500',
        totalFee: '75.00',
        walletAvailableMinor: '92500',
        walletAvailable: '925.00',
      });
      expect(res.body.bids).toEqual([
        { id: expect.any(String), amountMinor: '500', amount: '5.00', createdAt: expect.any(String) },
      ]);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(await balance(user)).toBe('92500');
      expect(await totalBidCount(auctionId)).toBe(1);
      const history = await t.get('/wallet/transactions', user.token).expect(200);
      expect(history.body.items[0]).toMatchObject({
        id: res.body.transactionId,
        reference: res.body.transactionReference,
        type: 'BID_FEE',
        direction: 'DEBIT',
        amountMinor: '7500',
        balanceAfterMinor: '92500',
      });
      expect((await t.get(`/auctions/${auctionId}`).expect(200)).body.totalBidCount).toBe(1);
      await expectLedgerConsistent();
    });

    it('records several amounts in one request and charges the fee for each (4 × 75.00 = 300.00)', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);

      const res = await bid(auctionId, user, ['500', '1000', '1500', '2000']).expect(201);

      expect(res.body).toMatchObject({ bidCount: 4, totalFeeMinor: '30000', totalFee: '300.00' });
      expect(res.body.bids.map((b: { amountMinor: string }) => b.amountMinor)).toEqual(['500', '1000', '1500', '2000']);
      expect(await balance(user)).toBe('70000');
      expect(await totalBidCount(auctionId)).toBe(4);
      const rows = await t.prisma.bid.findMany({ where: { auctionId }, orderBy: { sequence: 'asc' } });
      expect(rows.map((b) => b.amountMinor)).toEqual([500n, 1000n, 1500n, 2000n]);
      expect(new Set(rows.map((b) => b.submissionId)).size).toBe(1);
      // One wallet transaction for the whole request.
      expect(await t.prisma.walletTransaction.count({ where: { type: 'BID_FEE' } })).toBe(1);
      await expectLedgerConsistent();
    });

    it.each([
      ['an empty list', []],
      ['the same amount twice', ['500', '500']],
      ['numbers instead of strings', [500]],
      ['a decimal amount', ['5.00']],
      ['a zero amount', ['0']],
      ['a negative amount', ['-500']],
      ['more than 100 amounts', Array.from({ length: 101 }, (_, i) => String((i + 1) * 100))],
      ['something that is not a list', '500'],
    ])('rejects %s without charging', async (_name, amounts) => {
      const auctionId = await liveAuction();
      const user = await account(1000000n);

      const res = await bid(auctionId, user, amounts);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_FAILED');
      await expectUntouched(auctionId, user, 1000000n);
    });

    it('ignores any fee or total sent by the client', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);
      const res = await t
        .post(
          `/auctions/${auctionId}/bids`,
          { amountsMinor: ['500'], bidFeeMinor: '1', totalFeeMinor: '1' },
          user.token,
        )
        .set('Idempotency-Key', randomUUID());
      expect(res.status).toBe(400);
      await expectUntouched(auctionId, user, 100000n);
    });

    it('rejects the whole request when one amount is outside the range or off the step', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);

      const res = await bid(auctionId, user, ['500', '50', '100100', '550']);

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('BID_AMOUNT_INVALID');
      expect(res.body.details).toEqual({
        invalidAmountsMinor: ['50', '100100', '550'],
        minBidMinor: '100',
        maxBidMinor: '100000',
        bidStepMinor: '100',
      });
      await expectUntouched(auctionId, user, 100000n);
      // The boundaries themselves are valid.
      await bid(auctionId, user, ['100', '100000']).expect(201);
    });

    it('never deducts money when the balance does not cover every bid', async () => {
      const auctionId = await liveAuction();
      const user = await account(FEE * 2n);

      const res = await bid(auctionId, user, ['500', '600', '700']);

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INSUFFICIENT_FUNDS');
      expect(res.body.details).toMatchObject({ requiredMinor: '22500', availableMinor: '15000' });
      await expectUntouched(auctionId, user, FEE * 2n);
      await bid(auctionId, user, ['500', '600']).expect(201);
      expect(await balance(user)).toBe('0');
    });

    it('rejects bids from a frozen wallet', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);
      const finance = await account(0n, RoleName.FINANCE);
      await t.post(`/admin/wallets/${user.id}/freeze`, { reason: 'Under review' }, finance.token).expect(200);

      const res = await bid(auctionId, user, ['500']);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('WALLET_FROZEN');
      await expectUntouched(auctionId, user, 100000n);
    });

    it('requires sign-in and an idempotency key, and keeps staff out', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);

      expect((await t.post(`/auctions/${auctionId}/bids`, { amountsMinor: ['500'] })).status).toBe(401);
      const noKey = await t.post(`/auctions/${auctionId}/bids`, { amountsMinor: ['500'] }, user.token);
      expect(noKey.status).toBe(400);
      expect(noKey.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
      for (const role of [RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN, RoleName.SUPER_ADMIN]) {
        const staff = await account(100000n, role);
        const res = await bid(auctionId, staff, ['500']);
        expect([role, res.status, res.body.error]).toEqual([role, 403, 'FORBIDDEN']);
      }
      await expectUntouched(auctionId, user, 100000n);
    });
  });

  describe('duplicate bids and limits', () => {
    it('stops a user from bidding the same amount twice, but lets different users share an amount', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);
      const other = await account(100000n);
      await bid(auctionId, user, ['500', '700']).expect(201);

      const res = await bid(auctionId, user, ['300', '700', '500']);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('DUPLICATE_BID');
      expect(res.body.details.amountsMinor).toEqual(['500', '700']);
      expect(await balance(user)).toBe('85000');
      expect(await bidCount(auctionId)).toBe(2);

      await bid(auctionId, other, ['500']).expect(201);
      await bid(auctionId, user, ['300']).expect(201);
      expect(await totalBidCount(auctionId)).toBe(4);
    });

    it('allows a repeated amount when the auction policy permits it', async () => {
      const auctionId = await liveAuction({ duplicateBidPolicy: 'ALLOW_SAME_USER_SAME_AMOUNT' });
      const user = await account(100000n);
      await bid(auctionId, user, ['500']).expect(201);
      await bid(auctionId, user, ['500']).expect(201);
      expect(await bidCount(auctionId)).toBe(2);
      expect(await balance(user)).toBe('85000');
    });

    it('enforces the per-request and per-user bid limits', async () => {
      const auctionId = await liveAuction({ maxBidsPerRequest: 3, maxBidsPerUser: 4 });
      const user = await account(1000000n);

      const tooMany = await bid(auctionId, user, ['100', '200', '300', '400']);
      expect(tooMany.status).toBe(422);
      expect(tooMany.body.error).toBe('BID_LIMIT_EXCEEDED');
      expect(tooMany.body.details).toEqual({ maxBidsPerRequest: 3 });

      await bid(auctionId, user, ['100', '200', '300']).expect(201);
      const overUserLimit = await bid(auctionId, user, ['400', '500']);
      expect(overUserLimit.status).toBe(422);
      expect(overUserLimit.body.details).toEqual({ maxBidsPerUser: 4, placed: 3, remaining: 1 });
      await bid(auctionId, user, ['400']).expect(201);
      expect((await bid(auctionId, user, ['500'])).status).toBe(422);
      expect(await bidCount(auctionId)).toBe(4);
      expect(await balance(user)).toBe((1000000n - FEE * 4n).toString());
    });
  });

  describe('retries', () => {
    it('returns the original result for a repeated request and charges once', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);
      const key = randomUUID();

      const first = await bid(auctionId, user, ['500', '600'], key).expect(201);
      const second = await bid(auctionId, user, ['500', '600'], key).expect(201);

      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(await bidCount(auctionId)).toBe(2);
      expect(await balance(user)).toBe('85000');

      const different = await bid(auctionId, user, ['900'], key);
      expect(different.status).toBe(422);
      expect(different.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
      // Another user may use the same key value.
      await bid(auctionId, await account(100000n), ['500', '600'], key).expect(201);
    });

    it('charges once when the same request arrives several times at once', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);
      const key = randomUUID();

      const results = await Promise.all(Array.from({ length: 6 }, () => bid(auctionId, user, ['500'], key)));

      expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(5);
      expect(await bidCount(auctionId)).toBe(1);
      expect(await balance(user)).toBe('92500');
    });
  });

  describe('auction state and deadline', () => {
    const shiftWindow = (id: string, opensInHours: number, closesInHours: number) =>
      t.prisma.auction.update({
        where: { id },
        data: {
          opensAt: new Date(Date.now() + opensInHours * HOUR),
          closesAt: new Date(Date.now() + closesInHours * HOUR),
        },
      });

    it('accepts bids only while the auction is open', async () => {
      const user = await account(100000n);
      const product = await t.post('/admin/products', { name: 'Prize' }, admin.token);
      const body = {
        productId: product.body.id,
        title: 'Not open yet',
        bidFeeMinor: '7500',
        minBidMinor: '100',
        maxBidMinor: '100000',
        bidStepMinor: '100',
        opensAt: inHours(1),
        closesAt: inHours(25),
        noUniqueBidPolicy: 'NO_WINNER',
      };
      const { id } = (await t.post('/admin/auctions', body, admin.token).expect(201)).body;

      expect((await bid(id, user, ['500'])).status).toBe(404); // draft: not public
      expect((await bid(randomUUID(), user, ['500'])).status).toBe(404);

      await t.post(`/admin/auctions/${id}/schedule`, {}, admin.token).expect(200);
      const early = await bid(id, user, ['500']);
      expect(early.status).toBe(409);
      expect(early.body.error).toBe('AUCTION_NOT_OPEN');
      await expectUntouched(id, user, 100000n);

      // The opening time passes before the background job runs: the first bid opens the auction.
      await shiftWindow(id, -0.01, 24);
      await bid(id, user, ['500']).expect(201);
      const opened = await t.prisma.auction.findUniqueOrThrow({ where: { id } });
      expect(opened.status).toBe('ACTIVE');
      expect(opened.activatedAt).toBeInstanceOf(Date);
    });

    it('rejects bids after the closing time, even before the status has changed', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);
      await shiftWindow(auctionId, -5, -0.0001);

      const late = await bid(auctionId, user, ['500']);

      expect(late.status).toBe(409);
      expect(late.body.error).toBe('AUCTION_CLOSED');
      await expectUntouched(auctionId, user, 100000n);

      await t.prisma.auction.update({ where: { id: auctionId }, data: { status: 'CLOSING' } });
      expect((await bid(auctionId, user, ['500'])).body.error).toBe('AUCTION_CLOSED');
      await expectUntouched(auctionId, user, 100000n);
    });

    it('rejects bids on a cancelled auction', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);
      await t.post(`/admin/auctions/${auctionId}/cancel`, { reason: 'Supplier fell through' }, admin.token).expect(200);
      const res = await bid(auctionId, user, ['500']);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('AUCTION_CLOSED');
      await expectUntouched(auctionId, user, 100000n);
    });
  });

  describe('concurrency', () => {
    it('accepts simultaneous bids from many users and counts every one', async () => {
      const auctionId = await liveAuction();
      const users = await Promise.all(Array.from({ length: 12 }, () => account(100000n)));

      const results = await Promise.all(users.map((u, i) => bid(auctionId, u, ['500', String((i + 2) * 1000)])));

      expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
      expect(await bidCount(auctionId)).toBe(24);
      expect(await totalBidCount(auctionId)).toBe(24);
      for (const u of users) expect(await balance(u)).toBe('85000');
      const sequences = (await t.prisma.bid.findMany({ where: { auctionId } })).map((b) => b.sequence);
      expect(new Set(sequences).size).toBe(24);
      await expectLedgerConsistent();
    });

    it('never overdraws a wallet when one user sends many bids at once', async () => {
      const auctionId = await liveAuction();
      const user = await account(FEE * 3n);

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => bid(auctionId, user, [String((i + 1) * 100)])),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      const refused = results.filter((r) => r.status !== 201);
      expect(refused.map((r) => r.body.error)).toEqual(Array(5).fill('INSUFFICIENT_FUNDS'));
      expect(await balance(user)).toBe('0');
      expect(await bidCount(auctionId)).toBe(3);
      expect(await totalBidCount(auctionId)).toBe(3);
      await expectLedgerConsistent();
    });

    it('accepts only one of several simultaneous bids of the same amount by the same user', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);

      const results = await Promise.all(Array.from({ length: 6 }, () => bid(auctionId, user, ['500'])));

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.body.error === 'DUPLICATE_BID')).toHaveLength(5);
      expect(await bidCount(auctionId)).toBe(1);
      expect(await balance(user)).toBe('92500');
    });
  });

  describe('bid records', () => {
    it('cannot be changed or deleted, even directly in the database', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);
      const { body } = await bid(auctionId, user, ['500']).expect(201);
      const id = body.bids[0].id;

      await expect(t.prisma.bid.update({ where: { id }, data: { amountMinor: 100n } })).rejects.toThrow();
      await expect(t.prisma.bid.delete({ where: { id } })).rejects.toThrow();
      await expect(t.prisma.bidSubmission.update({ where: { id: body.id }, data: { bidCount: 9 } })).rejects.toThrow();
      expect((await t.prisma.bid.findUniqueOrThrow({ where: { id } })).amountMinor).toBe(500n);
    });

    it('shows users only their own bids', async () => {
      const first = await liveAuction({ title: 'First auction' });
      const second = await liveAuction({ title: 'Second auction' });
      const user = await account(100000n);
      const other = await account(100000n);
      await bid(first, user, ['500', '600']).expect(201);
      await bid(second, user, ['900']).expect(201);
      await bid(first, other, ['700']).expect(201);

      const mine = await t.get('/bids/mine', user.token).expect(200);
      expect(mine.body).toMatchObject({ total: 3, page: 1 });
      expect(mine.body.items.map((b: { amountMinor: string }) => b.amountMinor)).toEqual(['900', '600', '500']);
      expect(mine.body.items[0]).toMatchObject({
        auctionId: second,
        auctionTitle: 'Second auction',
        auctionStatus: 'ACTIVE',
        amount: '9.00',
        bidFee: '75.00',
      });
      const inFirst = await t.get(`/bids/mine?auctionId=${first}&limit=1`, user.token).expect(200);
      expect(inFirst.body).toMatchObject({ total: 2, limit: 1 });
      expect(
        (await t.get('/bids/mine', other.token)).body.items.map((b: { amountMinor: string }) => b.amountMinor),
      ).toEqual(['700']);
      expect((await t.get('/bids/mine')).status).toBe(401);

      // The public auction shows how many bids there are, never what they are.
      const publicView = await t.get(`/auctions/${first}`).expect(200);
      expect(publicView.body.totalBidCount).toBe(3);
      expect(JSON.stringify(publicView.body)).not.toMatch(/"bids"|amountMinor/);
    });

    it('lets back-office staff, and nobody else, list the bids of an auction', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);
      const other = await account(100000n);
      await bid(auctionId, user, ['500', '600']).expect(201);
      await bid(auctionId, other, ['500']).expect(201);

      expect((await t.get(`/admin/auctions/${auctionId}/bids`)).status).toBe(401);
      expect((await t.get(`/admin/auctions/${auctionId}/bids`, user.token)).status).toBe(403);
      const support = await account(0n, RoleName.SUPPORT);
      const all = await t.get(`/admin/auctions/${auctionId}/bids`, support.token).expect(200);
      expect(all.body.total).toBe(3);
      expect(all.body.items.map((b: { amountMinor: string; userId: string }) => [b.amountMinor, b.userId])).toEqual([
        ['500', user.id],
        ['600', user.id],
        ['500', other.id],
      ]);
      expect(all.body.items[0]).toMatchObject({
        phoneNumber: expect.stringMatching(/^\+2519/),
        sequence: expect.any(String),
      });
      expect((await t.get(`/admin/auctions/${auctionId}/bids?amountMinor=500`, admin.token)).body.total).toBe(2);
      expect((await t.get(`/admin/auctions/${auctionId}/bids?userId=${other.id}`, admin.token)).body.total).toBe(1);
      expect((await t.get(`/admin/auctions/${randomUUID()}/bids`, admin.token)).status).toBe(404);
    });
  });

  describe('cancelling an auction that has bids', () => {
    it('refunds every bid fee exactly once', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);
      const other = await account(50000n);
      await bid(auctionId, user, ['500', '600']).expect(201);
      await bid(auctionId, user, ['700']).expect(201);
      await bid(auctionId, other, ['500']).expect(201);

      const res = await t
        .post(`/admin/auctions/${auctionId}/cancel`, { reason: 'Supplier fell through' }, admin.token)
        .expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.bidFeesRefundedAt).toEqual(expect.any(String));
      expect(await balance(user)).toBe('100000');
      expect(await balance(other)).toBe('50000');
      const refunds = await t.prisma.walletTransaction.findMany({ where: { type: 'REFUND' } });
      expect(refunds.map((r) => r.amountMinor).sort()).toEqual([15000n, 7500n, 7500n].sort());
      const history = await t.get('/wallet/transactions?type=REFUND', user.token).expect(200);
      expect(history.body.items).toHaveLength(2);
      expect(history.body.items[0]).toMatchObject({
        direction: 'CREDIT',
        description: expect.stringContaining('cancelled'),
      });
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'auction.bid-fees-refunded' } });
      expect(audit).toMatchObject({ entityId: auctionId, metadata: { submissions: 3, totalFeeMinor: '30000' } });

      // Running the refund again changes nothing.
      expect(await t.app.get(BidRefundService).refundAuction(auctionId)).toEqual({ refunded: 0, complete: true });
      await t.app.get(BidRefundService).refundPending();
      expect(await t.prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(3);
      expect(await balance(user)).toBe('100000');
      // The bids stay on record.
      expect(await bidCount(auctionId)).toBe(4);
      await expectLedgerConsistent();
    });

    it('finishes an interrupted refund in the background, and refuses to refund a live auction', async () => {
      const auctionId = await liveAuction();
      const user = await account(100000n);
      await bid(auctionId, user, ['500']).expect(201);
      const refundsService = t.app.get(BidRefundService);
      await expect(refundsService.refundAuction(auctionId)).rejects.toThrow(/not due for a refund/);
      expect(await balance(user)).toBe('92500');

      // Cancelled, but the server stopped before any refund was made.
      await t.prisma.auction.update({
        where: { id: auctionId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await Promise.all([refundsService.refundPending(), refundsService.refundPending()]);
      await refundsService.refundPending();

      expect(await balance(user)).toBe('100000');
      expect(await t.prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(1);
      const auction = await t.prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
      expect(auction.bidFeesRefundedAt).toBeInstanceOf(Date);
    });
  });
});
