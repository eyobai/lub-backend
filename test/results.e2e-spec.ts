import { RoleName } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuctionLifecycleProcessor } from '../src/modules/auctions/auction-lifecycle.processor';
import { AuctionLifecycleService } from '../src/modules/auctions/auction-lifecycle.service';
import { ReconciliationService } from '../src/modules/ledger/reconciliation.service';
import { ResultsService } from '../src/modules/results/results.service';
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

describe('Auction results', () => {
  let t: TestApp;
  let results: ResultsService;
  let admin: Account;
  let phoneCounter = 0;

  beforeAll(async () => {
    t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' });
    results = t.app.get(ResultsService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await account(0n, RoleName.ADMIN);
  });

  async function account(balanceMinor = 0n, ...roles: RoleName[]): Promise<Account> {
    const phoneNumber = `+2519${String(40000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    for (const name of roles) {
      const role = await t.prisma.role.findUniqueOrThrow({ where: { name } });
      await t.prisma.userRole.create({ data: { userId: res.body.userId, roleId: role.id } });
    }
    if (balanceMinor > 0n)
      await t.app.get(WalletService).deposit({ userId: res.body.userId, amountMinor: balanceMinor });
    return { id: res.body.userId, token: res.body.tokens.accessToken };
  }
  const bidders = (count: number) => Promise.all(Array.from({ length: count }, () => account(1_000_000n)));

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
      duplicateBidPolicy: 'ALLOW_SAME_USER_SAME_AMOUNT',
      ...override,
    };
    const { id } = (await t.post('/admin/auctions', body, admin.token).expect(201)).body;
    await t.post(`/admin/auctions/${id}/activate`, {}, admin.token).expect(200);
    return id;
  }

  const bid = (auctionId: string, user: Account, ...amounts: number[]) =>
    t
      .post(`/auctions/${auctionId}/bids`, { amountsMinor: amounts.map(String) }, user.token)
      .set('Idempotency-Key', randomUUID());
  /** Moves the closing time into the past, as if the auction had run its course. */
  const passDeadline = (id: string) =>
    t.prisma.auction.update({
      where: { id },
      data: { opensAt: new Date(Date.now() - 2 * HOUR), closesAt: new Date(Date.now() - 1000) },
    });
  /** What the background job does on each run. */
  const runJob = () => t.app.get(AuctionLifecycleProcessor).process();
  const close = async (id: string) => {
    await passDeadline(id);
    await runJob();
  };
  const auctionRow = (id: string) => t.prisma.auction.findUniqueOrThrow({ where: { id } });
  const balance = async (user: Account): Promise<string> =>
    (await t.get('/wallet', user.token).expect(200)).body.availableMinor;

  describe('winner calculation', () => {
    it('picks the lowest amount bid exactly once (ETB 1×5, 2×3, 3×2, 4×1, 5×1 → ETB 4 wins)', async () => {
      const auctionId = await liveAuction();
      const users = await bidders(6);
      for (const u of users.slice(0, 5)) await bid(auctionId, u, 100).expect(201);
      for (const u of users.slice(0, 3)) await bid(auctionId, u, 200).expect(201);
      for (const u of users.slice(0, 2)) await bid(auctionId, u, 300).expect(201);
      const winner = users[5];
      await bid(auctionId, users[4], 500).expect(201); // placed before the winning bid: order must not matter
      await bid(auctionId, winner, 400).expect(201);

      await close(auctionId);

      const auction = await auctionRow(auctionId);
      expect(auction.status).toBe('COMPLETED');
      expect(auction.completedAt).toBeInstanceOf(Date);
      expect(auction.closedAt).toBeInstanceOf(Date);

      const publicResult = await t.get(`/auctions/${auctionId}/result`).expect(200);
      expect(publicResult.body).toEqual({
        auctionId,
        outcome: 'WINNER_FOUND',
        currency: 'ETB',
        minorUnits: 2,
        winningAmountMinor: '400',
        winningAmount: '4.00',
        totalBids: 12,
        appliedNoUniquePolicy: null,
        bidFeesRefundedAt: null,
        computedAt: expect.any(String),
      });

      const full = await t.get(`/admin/auctions/${auctionId}/result`, admin.token).expect(200);
      expect(full.body).toMatchObject({
        distinctAmounts: 5,
        uniqueAmounts: 2,
        algorithmVersion: 'lub-1',
        inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        lastBidSequence: expect.any(String),
        histogram: [
          { amountMinor: '100', amount: '1.00', count: 5 },
          { amountMinor: '200', amount: '2.00', count: 3 },
          { amountMinor: '300', amount: '3.00', count: 2 },
          { amountMinor: '400', amount: '4.00', count: 1 },
          { amountMinor: '500', amount: '5.00', count: 1 },
        ],
        winner: { userId: winner.id, verificationStatus: 'PENDING_VERIFICATION', phoneNumber: expect.any(String) },
      });

      const record = await t.prisma.winner.findUniqueOrThrow({ where: { auctionId } });
      expect(record).toMatchObject({ userId: winner.id, amountMinor: 400n, currency: 'ETB', publishedAt: null });
      expect(record.bidId).toBe(full.body.winner.bidId);
      const winningBid = await t.prisma.bid.findUniqueOrThrow({ where: { id: record.bidId } });
      expect(winningBid).toMatchObject({ userId: winner.id, amountMinor: 400n, auctionId });

      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'auction.finalize', entityId: auctionId },
      });
      expect(audit).toMatchObject({
        actorType: 'SYSTEM',
        metadata: { outcome: 'WINNER_FOUND', winningAmountMinor: '400', totalBids: 12, inputHash: full.body.inputHash },
      });
    });

    it('tells each bidder how their own bids fared, and nothing about anyone else', async () => {
      const auctionId = await liveAuction();
      const [winner, loser, bystander] = await bidders(3);
      await bid(auctionId, winner, 100, 300).expect(201);
      await bid(auctionId, loser, 100, 700).expect(201);
      await close(auctionId);

      const won = await t.get(`/auctions/${auctionId}/result/mine`, winner.token).expect(200);
      expect(won.body).toMatchObject({ outcome: 'WINNER_FOUND', won: true, winningAmountMinor: '300' });
      expect(won.body.bids.map((b: { amountMinor: string; outcome: string }) => [b.amountMinor, b.outcome])).toEqual([
        ['100', 'NOT_UNIQUE'],
        ['300', 'WINNING'],
      ]);

      const lost = await t.get(`/auctions/${auctionId}/result/mine`, loser.token).expect(200);
      expect(lost.body.won).toBe(false);
      expect(lost.body.bids.map((b: { amountMinor: string; outcome: string }) => [b.amountMinor, b.outcome])).toEqual([
        ['100', 'NOT_UNIQUE'],
        ['700', 'UNIQUE_NOT_LOWEST'],
      ]);

      const none = await t.get(`/auctions/${auctionId}/result/mine`, bystander.token).expect(200);
      expect(none.body).toMatchObject({ won: false, bids: [] });
      expect((await t.get(`/auctions/${auctionId}/result/mine`)).status).toBe(401);

      // Neither view names the winner or carries the bid counts.
      for (const body of [lost.body, (await t.get(`/auctions/${auctionId}/result`)).body]) {
        expect(JSON.stringify(body)).not.toMatch(/histogram|userId|phoneNumber|winner"/);
      }
    });

    it('lets a single bid win', async () => {
      const auctionId = await liveAuction();
      const [only] = await bidders(1);
      await bid(auctionId, only, 99900).expect(201);
      await close(auctionId);
      const result = await t.get(`/auctions/${auctionId}/result`).expect(200);
      expect(result.body).toMatchObject({ outcome: 'WINNER_FOUND', winningAmountMinor: '99900', totalBids: 1 });
      expect((await t.prisma.winner.findUniqueOrThrow({ where: { auctionId } })).userId).toBe(only.id);
    });

    it('treats the same amount bid twice by one user as not unique', async () => {
      const auctionId = await liveAuction();
      const [repeater, other] = await bidders(2);
      await bid(auctionId, repeater, 100).expect(201);
      await bid(auctionId, repeater, 100).expect(201);
      await bid(auctionId, other, 200).expect(201);
      await close(auctionId);
      expect((await t.prisma.winner.findUniqueOrThrow({ where: { auctionId } })).userId).toBe(other.id);
    });
  });

  describe('no winner', () => {
    it('completes an auction nobody bid on as NO_BIDS', async () => {
      const auctionId = await liveAuction({ noUniqueBidPolicy: 'REFUND_BID_FEES' });
      await close(auctionId);

      const result = await t.get(`/admin/auctions/${auctionId}/result`, admin.token).expect(200);
      expect(result.body).toMatchObject({
        outcome: 'NO_BIDS',
        winningAmountMinor: null,
        winningAmount: null,
        totalBids: 0,
        appliedNoUniquePolicy: null,
        lastBidSequence: null,
        histogram: [],
        winner: null,
      });
      expect((await auctionRow(auctionId)).status).toBe('COMPLETED');
      expect(await t.prisma.winner.count()).toBe(0);
    });

    it('keeps the fees when there is no unique bid and the policy is NO_WINNER', async () => {
      const auctionId = await liveAuction({ noUniqueBidPolicy: 'NO_WINNER' });
      const [a, b] = await bidders(2);
      await bid(auctionId, a, 100, 200).expect(201);
      await bid(auctionId, b, 100, 200).expect(201);
      await close(auctionId);

      const result = await t.get(`/auctions/${auctionId}/result`).expect(200);
      expect(result.body).toMatchObject({
        outcome: 'NO_UNIQUE_BID',
        winningAmountMinor: null,
        totalBids: 4,
        appliedNoUniquePolicy: 'NO_WINNER',
        bidFeesRefundedAt: null,
      });
      expect(await t.prisma.winner.count()).toBe(0);
      expect(await t.prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(0);
      expect(await balance(a)).toBe((1_000_000n - FEE * 2n).toString());
      await runJob();
      expect(await balance(a)).toBe((1_000_000n - FEE * 2n).toString());
      const mine = await t.get(`/auctions/${auctionId}/result/mine`, a.token).expect(200);
      expect(mine.body.bids.map((x: { outcome: string }) => x.outcome)).toEqual(['NOT_UNIQUE', 'NOT_UNIQUE']);
    });

    it('refunds every fee exactly once when there is no unique bid and the policy is REFUND_BID_FEES', async () => {
      const auctionId = await liveAuction({ noUniqueBidPolicy: 'REFUND_BID_FEES' });
      const [a, b] = await bidders(2);
      await bid(auctionId, a, 100, 200).expect(201);
      await bid(auctionId, b, 100).expect(201);
      await bid(auctionId, b, 200).expect(201);
      await close(auctionId);

      const result = await t.get(`/auctions/${auctionId}/result`).expect(200);
      expect(result.body).toMatchObject({
        outcome: 'NO_UNIQUE_BID',
        appliedNoUniquePolicy: 'REFUND_BID_FEES',
        bidFeesRefundedAt: expect.any(String),
      });
      expect(await balance(a)).toBe('1000000');
      expect(await balance(b)).toBe('1000000');
      await runJob();
      await runJob();
      expect(await t.prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(3);
      expect(await balance(a)).toBe('1000000');
      const history = await t.get('/wallet/transactions?type=REFUND', a.token).expect(200);
      expect(history.body.items[0].description).toContain('ended without a unique bid');
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'auction.bid-fees-refunded' } });
      expect(audit.metadata).toMatchObject({ reason: 'NO_UNIQUE_BID', submissions: 3, totalFeeMinor: '30000' });
      expect((await t.app.get(ReconciliationService).reconcile()).issues).toEqual([]);
    });

    it('does not refund when a winner was found, whatever the policy', async () => {
      const auctionId = await liveAuction({ noUniqueBidPolicy: 'REFUND_BID_FEES' });
      const [a, b] = await bidders(2);
      await bid(auctionId, a, 100, 200).expect(201);
      await bid(auctionId, b, 100).expect(201);
      await close(auctionId);
      await runJob();

      expect((await t.get(`/auctions/${auctionId}/result`)).body).toMatchObject({
        outcome: 'WINNER_FOUND',
        winningAmountMinor: '200',
        appliedNoUniquePolicy: null,
        bidFeesRefundedAt: null,
      });
      expect(await t.prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(0);
      expect(await balance(a)).toBe((1_000_000n - FEE * 2n).toString());
    });

    it('will not finalize an auction that has no usable no-unique-bid policy', async () => {
      const auctionId = await liveAuction();
      const [a] = await bidders(1);
      await bid(auctionId, a, 100).expect(201);
      // Not reachable through the API (publishing requires a policy); set directly to prove the guard.
      for (const policy of [null, 'EXTEND_AUCTION'] as const) {
        await t.prisma.auction.update({ where: { id: auctionId }, data: { noUniqueBidPolicy: policy } });
        await close(auctionId);
        expect((await auctionRow(auctionId)).status).toBe('CLOSING');
        const res = await t.post(`/admin/auctions/${auctionId}/finalize`, {}, admin.token);
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('AUCTION_NOT_READY');
      }
      expect(await t.prisma.auctionResult.count()).toBe(0);

      await t.prisma.auction.update({ where: { id: auctionId }, data: { noUniqueBidPolicy: 'NO_WINNER' } });
      await runJob();
      expect((await auctionRow(auctionId)).status).toBe('COMPLETED');
    });
  });

  describe('finalizing once', () => {
    it('records one result when finalization is triggered many times at once', async () => {
      const auctionId = await liveAuction();
      const [a, b] = await bidders(2);
      await bid(auctionId, a, 100, 300).expect(201);
      await bid(auctionId, b, 100).expect(201);
      await passDeadline(auctionId);
      await t.app.get(AuctionLifecycleService).syncDue();

      const outcomes = await Promise.all([
        ...Array.from({ length: 4 }, () => results.finalize(auctionId)),
        ...Array.from({ length: 3 }, () => runJob().then(() => false)),
        t.post(`/admin/auctions/${auctionId}/finalize`, {}, admin.token).then((res) => res.status),
      ]);

      expect(outcomes.filter((o) => o === true).length).toBeLessThanOrEqual(1);
      expect(outcomes.at(-1)).toBe(200);
      expect(await t.prisma.auctionResult.count({ where: { auctionId } })).toBe(1);
      expect(await t.prisma.winner.count({ where: { auctionId } })).toBe(1);
      expect(await t.prisma.auditLog.count({ where: { action: 'auction.finalize', entityId: auctionId } })).toBe(1);
      expect(await results.finalize(auctionId)).toBe(false);
    });

    it('counts every accepted bid and no late one when bids race the close', async () => {
      const auctionId = await liveAuction();
      const users = await bidders(10);
      // Bidding closes in a moment, while bids are still arriving.
      await t.prisma.auction.update({ where: { id: auctionId }, data: { closesAt: new Date(Date.now() + 300) } });

      const responses: { status: number; body: { error?: string } }[] = [];
      const bidding = (async () => {
        for (let round = 0; round < 8; round++) {
          const batch = await Promise.all(users.map((u, i) => bid(auctionId, u, (round * 10 + i + 1) * 100)));
          responses.push(...batch);
        }
      })();
      const finalizing = (async () => {
        while ((await auctionRow(auctionId)).status !== 'COMPLETED') await runJob();
      })();
      await Promise.all([bidding, finalizing]);

      const accepted = responses.filter((r) => r.status === 201).length;
      const refused = responses.filter((r) => r.status !== 201);
      expect(refused.every((r) => r.body.error === 'AUCTION_CLOSED')).toBe(true);
      expect(refused.length).toBeGreaterThan(0);
      expect(accepted).toBeGreaterThan(0);
      const result = await t.prisma.auctionResult.findUniqueOrThrow({ where: { auctionId } });
      expect(result.totalBids).toBe(accepted);
      expect(await t.prisma.bid.count({ where: { auctionId } })).toBe(accepted);
      expect((await auctionRow(auctionId)).totalBidCount).toBe(accepted);
      const audit = await t.get(`/admin/auctions/${auctionId}/result/audit`, admin.token).expect(200);
      expect(audit.body.matches).toBe(true);
      expect((await t.app.get(ReconciliationService).reconcile()).issues).toEqual([]);
    });

    it('cannot be changed or deleted once recorded, and a finished auction cannot be cancelled', async () => {
      const auctionId = await liveAuction();
      const [a] = await bidders(1);
      await bid(auctionId, a, 100).expect(201);
      await close(auctionId);

      await expect(
        t.prisma.auctionResult.update({ where: { auctionId }, data: { outcome: 'NO_BIDS' } }),
      ).rejects.toThrow();
      await expect(t.prisma.auctionResult.delete({ where: { auctionId } })).rejects.toThrow();
      const cancel = await t.post(`/admin/auctions/${auctionId}/cancel`, { reason: 'Too late' }, admin.token);
      expect(cancel.status).toBe(409);
      expect((await bid(auctionId, a, 200)).body.error).toBe('AUCTION_CLOSED');
      expect(await balance(a)).toBe((1_000_000n - FEE).toString());
    });
  });

  describe('result endpoints', () => {
    it('has no result until the auction is finished, and none for a cancelled one', async () => {
      const auctionId = await liveAuction();
      const [a] = await bidders(1);
      await bid(auctionId, a, 100).expect(201);

      for (const path of [`/auctions/${auctionId}/result`, `/auctions/${auctionId}/result/mine`]) {
        const res = await t.get(path, a.token);
        expect([path, res.status, res.body.error]).toEqual([path, 409, 'RESULT_NOT_AVAILABLE']);
      }
      expect((await t.get(`/admin/auctions/${auctionId}/result`, admin.token)).status).toBe(409);
      expect((await t.get(`/admin/auctions/${auctionId}/result/audit`, admin.token)).status).toBe(409);
      expect((await t.get(`/auctions/${randomUUID()}/result`)).status).toBe(404);

      await t.post(`/admin/auctions/${auctionId}/cancel`, { reason: 'Supplier fell through' }, admin.token).expect(200);
      const cancelled = await t.get(`/auctions/${auctionId}/result`);
      expect(cancelled.status).toBe(409);
      expect(cancelled.body.details).toEqual({ status: 'CANCELLED' });
      await runJob();
      expect(await t.prisma.auctionResult.count()).toBe(0);
    });

    it('lets an admin finalize by hand only once bidding has closed', async () => {
      const auctionId = await liveAuction();
      const [a] = await bidders(1);
      await bid(auctionId, a, 100).expect(201);

      const early = await t.post(`/admin/auctions/${auctionId}/finalize`, {}, admin.token);
      expect(early.status).toBe(409);
      expect(early.body.error).toBe('AUCTION_INVALID_STATE');
      expect((await auctionRow(auctionId)).status).toBe('ACTIVE');

      // The closing time has passed but the background job has not run: the admin can still finalize.
      await passDeadline(auctionId);
      const done = await t.post(`/admin/auctions/${auctionId}/finalize`, {}, admin.token).expect(200);
      expect(done.body).toMatchObject({ outcome: 'WINNER_FOUND', winningAmountMinor: '100', winner: { userId: a.id } });
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'auction.finalize' } });
      expect(audit).toMatchObject({ actorType: 'ADMIN', actorId: admin.id });

      const again = await t.post(`/admin/auctions/${auctionId}/finalize`, {}, admin.token).expect(200);
      expect(again.body.computedAt).toBe(done.body.computedAt);
      expect(await t.prisma.auditLog.count({ where: { action: 'auction.finalize' } })).toBe(1);

      const draftProduct = await t.post('/admin/products', { name: 'Other' }, admin.token);
      const draft = await t.post(
        '/admin/auctions',
        {
          productId: draftProduct.body.id,
          title: 'Draft',
          bidFeeMinor: '7500',
          minBidMinor: '100',
          maxBidMinor: '1000',
          opensAt: inHours(1),
          closesAt: inHours(2),
        },
        admin.token,
      );
      expect((await t.post(`/admin/auctions/${draft.body.id}/finalize`, {}, admin.token)).status).toBe(409);
    });

    it('restricts the full result, the re-check and manual finalizing to staff', async () => {
      const auctionId = await liveAuction();
      const [a] = await bidders(1);
      await bid(auctionId, a, 100).expect(201);
      await close(auctionId);
      const support = await account(0n, RoleName.SUPPORT);
      const finance = await account(0n, RoleName.FINANCE);

      for (const path of [`/admin/auctions/${auctionId}/result`, `/admin/auctions/${auctionId}/result/audit`]) {
        expect((await t.get(path)).status).toBe(401);
        expect((await t.get(path, a.token)).status).toBe(403);
        expect((await t.get(path, support.token)).status).toBe(200);
        expect((await t.get(path, finance.token)).status).toBe(200);
      }
      expect((await t.post(`/admin/auctions/${auctionId}/finalize`, {})).status).toBe(401);
      for (const account of [a, support, finance]) {
        expect((await t.post(`/admin/auctions/${auctionId}/finalize`, {}, account.token)).status).toBe(403);
      }
    });

    it('re-checks a result against the bids on record', async () => {
      const auctionId = await liveAuction();
      const [a, b] = await bidders(2);
      await bid(auctionId, a, 100, 300).expect(201);
      await bid(auctionId, b, 100, 500).expect(201);
      await close(auctionId);

      const audit = await t.get(`/admin/auctions/${auctionId}/result/audit`, admin.token).expect(200);

      expect(audit.body).toMatchObject({ auctionId, matches: true, checkedAt: expect.any(String) });
      expect(audit.body.recomputed).toEqual(audit.body.recorded);
      expect(audit.body.recorded).toMatchObject({ outcome: 'WINNER_FOUND', winningAmountMinor: '300', totalBids: 4 });
    });
  });
});
