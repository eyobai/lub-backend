import { NotificationChannel, NotificationStatus, NotificationType, RoleName } from '@prisma/client';
import type { Notification } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../src/config/configuration';
import type { AppConfig } from '../src/config/configuration';
import { AuctionLifecycleProcessor } from '../src/modules/auctions/auction-lifecycle.processor';
import { ReconciliationService } from '../src/modules/ledger/reconciliation.service';
import { MAX_ATTEMPTS, NotificationDispatcher } from '../src/modules/notifications/notification-dispatcher.service';
import type { NotificationProvider, OutboundNotification } from '../src/modules/notifications/notification.types';
import { NotificationsProcessor } from '../src/modules/notifications/notifications.processor';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd';
const HOUR = 3_600_000;
const FEE = 7500n;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
const DETAILS = {
  recipientName: 'Abebe Kebede',
  recipientPhone: '+251911234567',
  address: { city: 'Addis Ababa', subCity: 'Bole', woreda: '03', landmark: 'Behind Edna Mall' },
};

interface Account {
  id: string;
  token: string;
  phoneNumber: string;
}

/** Stands in for an SMS gateway: carries only win announcements, and can be told to fail. */
class FakeSmsProvider implements NotificationProvider {
  readonly channel = NotificationChannel.SMS;
  readonly sent: OutboundNotification[] = [];
  failing = false;
  rejectsEverything = false;

  accepts(type: NotificationType): boolean {
    if (this.rejectsEverything) throw new Error('simulated provider bug');
    return type === NotificationType.WINNER_ANNOUNCEMENT;
  }

  send(notification: OutboundNotification): Promise<void> {
    if (this.failing) return Promise.reject(new Error('simulated SMS gateway outage'));
    this.sent.push(notification);
    return Promise.resolve();
  }
}

/** Everything the suites below need to drive the platform over HTTP. */
function harness(getApp: () => TestApp) {
  let phoneCounter = 0;
  let admin: Account;
  let support: Account;
  let finance: Account;

  async function account(balanceMinor = 0n, ...roles: RoleName[]): Promise<Account> {
    const t = getApp();
    const phoneNumber = `+2519${String(60000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    for (const name of roles) {
      const role = await t.prisma.role.findUniqueOrThrow({ where: { name } });
      await t.prisma.userRole.create({ data: { userId: res.body.userId, roleId: role.id } });
    }
    if (balanceMinor > 0n)
      await t.app.get(WalletService).deposit({ userId: res.body.userId, amountMinor: balanceMinor });
    return { id: res.body.userId, token: res.body.tokens.accessToken, phoneNumber };
  }

  return {
    account,
    get admin() {
      return admin;
    },
    get support() {
      return support;
    },
    get finance() {
      return finance;
    },
    async reset(): Promise<void> {
      await getApp().reset();
      admin = await account(0n, RoleName.ADMIN);
      support = await account(0n, RoleName.SUPPORT);
      finance = await account(0n, RoleName.FINANCE);
    },

    /** An auction open for bidding: fee 75.00, amounts 1.00 … 1000.00 in steps of 1.00. */
    async liveAuction(override: object = {}): Promise<string> {
      const t = getApp();
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
    },

    bid: (auctionId: string, user: Account, amounts: number[], key: string = randomUUID()) =>
      getApp()
        .post(`/auctions/${auctionId}/bids`, { amountsMinor: amounts.map(String) }, user.token)
        .set('Idempotency-Key', key),

    /** Moves the closing time into the past and runs the background job, as if the auction had run its course. */
    async finish(auctionId: string): Promise<void> {
      const t = getApp();
      await t.prisma.auction.update({
        where: { id: auctionId },
        data: { opensAt: new Date(Date.now() - 2 * HOUR), closesAt: new Date(Date.now() - 1000) },
      });
      await t.app.get(AuctionLifecycleProcessor).process();
    },

    /** The user's notifications of the given types, oldest first, straight from the database. */
    stored: (user: Account, ...types: NotificationType[]): Promise<Notification[]> =>
      getApp().prisma.notification.findMany({
        where: { userId: user.id, type: types.length > 0 ? { in: types } : undefined },
        orderBy: [{ createdAt: 'asc' }, { channel: 'asc' }],
      }),
  };
}

describe('Notifications', () => {
  let t: TestApp;
  const h = harness(() => t);

  beforeAll(async () => {
    t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => h.reset());

  const inbox = async (user: Account, query = '') =>
    (await t.get(`/notifications${query}`, user.token).expect(200)).body as {
      items: { id: string; type: string; title: string; body: string; data: Record<string, unknown>; read: boolean }[];
      total: number;
      unread: number;
      page: number;
      limit: number;
    };
  const unread = async (user: Account): Promise<number> =>
    (await t.get('/notifications/unread-count', user.token).expect(200)).body.unread;

  describe('wallet', () => {
    it('tells the user when money arrives, with the amount and the new balance', async () => {
      const user = await h.account();
      await t.app.get(WalletService).deposit({ userId: user.id, amountMinor: 100000n, idempotencyKey: 'pay:1' });
      await t.app.get(WalletService).deposit({ userId: user.id, amountMinor: 2550n, idempotencyKey: 'pay:2' });

      const notes = await h.stored(user);
      expect(notes.map((n) => n.body)).toEqual([
        'ETB 1000.00 was added to your wallet. Your balance is now ETB 1000.00.',
        'ETB 25.50 was added to your wallet. Your balance is now ETB 1025.50.',
      ]);
      expect(notes[0]).toMatchObject({
        type: 'DEPOSIT_SUCCEEDED',
        channel: 'IN_APP',
        status: 'SENT',
        title: 'Wallet credited',
        readAt: null,
        data: { amountMinor: '100000', currency: 'ETB', transactionId: expect.any(String) },
      });
    });

    it('notifies once when the same deposit is delivered twice', async () => {
      const user = await h.account();
      const deposit = () =>
        t.app.get(WalletService).deposit({ userId: user.id, amountMinor: 5000n, idempotencyKey: 'pay:dup' });
      await deposit();
      await deposit();
      await Promise.all([deposit(), deposit(), deposit()]);

      expect(await h.stored(user)).toHaveLength(1);
      expect((await t.get('/wallet', user.token)).body.availableMinor).toBe('5000');
    });

    it('notifies for a manual credit, not for a debit, and once per idempotency key', async () => {
      const user = await h.account();
      const adjust = (direction: string, amountMinor: string, key: string = randomUUID()) =>
        t
          .post(
            `/admin/wallets/${user.id}/adjustments`,
            { direction, amountMinor, reason: 'Correction for support ticket 1001' },
            h.finance.token,
          )
          .set('Idempotency-Key', key);

      const key = randomUUID();
      await adjust('CREDIT', '9000', key).expect(201);
      expect((await adjust('CREDIT', '9000', key).expect(201)).headers['idempotent-replayed']).toBe('true');
      const debit = await adjust('DEBIT', '4000').expect(201);

      const notes = await h.stored(user);
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toBe('ETB 90.00 was added to your wallet. Your balance is now ETB 90.00.');
      // The internal reason given by staff is not shown to the user.
      expect(JSON.stringify(notes[0])).not.toContain('support ticket');

      // Reversing the debit returns the money, which the user is told about.
      await t
        .post(`/admin/wallet-transactions/${debit.body.id}/reverse`, { reason: 'Debited by mistake' }, h.finance.token)
        .set('Idempotency-Key', randomUUID())
        .expect(201);
      const after = await h.stored(user);
      expect(after).toHaveLength(2);
      expect(after[1].body).toBe('ETB 40.00 was added to your wallet. Your balance is now ETB 90.00.');
    });
  });

  describe('bidding', () => {
    it('confirms a bid submission with the count and the fee, without the amounts', async () => {
      const user = await h.account(100000n);
      const auctionId = await h.liveAuction();

      const res = await h.bid(auctionId, user, [100, 300, 500]).expect(201);

      const [note, ...rest] = await h.stored(user, 'BID_SUBMITTED');
      expect(rest).toEqual([]);
      expect(note).toMatchObject({
        channel: 'IN_APP',
        status: 'SENT',
        title: 'Bids placed',
        body: 'Your 3 bids in "Win a phone" were placed. ETB 225.00 was charged to your wallet.',
        data: { auctionId, bidSubmissionId: res.body.id, bidCount: 3, totalFeeMinor: '22500' },
      });
      expect(await h.stored(user, 'LOW_BALANCE')).toEqual([]);
    });

    it('does not notify again when a request is retried', async () => {
      const user = await h.account(100000n);
      const auctionId = await h.liveAuction();
      const key = randomUUID();

      await h.bid(auctionId, user, [100], key).expect(201);
      expect((await h.bid(auctionId, user, [100], key).expect(201)).headers['idempotent-replayed']).toBe('true');
      await Promise.all([h.bid(auctionId, user, [100], key), h.bid(auctionId, user, [100], key)]);

      expect(await h.stored(user, 'BID_SUBMITTED')).toHaveLength(1);
    });

    it('leaves no notification behind when a bid is refused', async () => {
      const poor = await h.account(FEE - 1n);
      const user = await h.account(100000n);
      const auctionId = await h.liveAuction();

      expect((await h.bid(auctionId, poor, [100])).body.error).toBe('INSUFFICIENT_FUNDS');
      expect((await h.bid(auctionId, user, [150])).body.error).toBe('BID_AMOUNT_INVALID');
      await h.bid(auctionId, user, [100]).expect(201);
      expect((await h.bid(auctionId, user, [100, 200])).body.error).toBe('DUPLICATE_BID');

      expect(await h.stored(poor, 'BID_SUBMITTED', 'LOW_BALANCE')).toEqual([]);
      expect(await h.stored(user, 'BID_SUBMITTED')).toHaveLength(1);
    });

    it('warns when the balance left cannot pay for another bid', async () => {
      const user = await h.account(FEE * 3n - 1n);
      const auctionId = await h.liveAuction();

      await h.bid(auctionId, user, [100]).expect(201);
      expect(await h.stored(user, 'LOW_BALANCE')).toEqual([]);

      await h.bid(auctionId, user, [200]).expect(201);
      const [warning, ...rest] = await h.stored(user, 'LOW_BALANCE');
      expect(rest).toEqual([]);
      expect(warning).toMatchObject({
        title: 'Low wallet balance',
        body: 'Your wallet balance is ETB 74.99, which is less than one bid fee (ETB 75.00). Add funds to keep bidding.',
        data: { availableMinor: '7499', currency: 'ETB' },
      });
    });

    it('gives each of many simultaneous bidders exactly one confirmation', async () => {
      const users = await Promise.all(Array.from({ length: 8 }, () => h.account(100000n)));
      const auctionId = await h.liveAuction();

      const results = await Promise.all(users.map((user, i) => h.bid(auctionId, user, [100 * (i + 1), 5000])));

      expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
      for (const user of users) expect(await h.stored(user, 'BID_SUBMITTED')).toHaveLength(1);
      expect(await t.prisma.notification.count({ where: { type: 'BID_SUBMITTED' } })).toBe(8);
    });
  });

  describe('auction results', () => {
    it('tells the winner they won and the others only the winning amount', async () => {
      const [winner, loser, other] = await Promise.all([h.account(100000n), h.account(100000n), h.account(100000n)]);
      const auctionId = await h.liveAuction();
      await h.bid(auctionId, winner, [100, 300]).expect(201);
      await h.bid(auctionId, loser, [100, 500]).expect(201);
      await h.bid(auctionId, loser, [700]).expect(201);
      await h.bid(auctionId, other, [900]).expect(201);

      await h.finish(auctionId);

      const record = await t.prisma.winner.findUniqueOrThrow({ where: { auctionId } });
      const won = await h.stored(winner, 'WINNER_ANNOUNCEMENT', 'AUCTION_RESULT');
      expect(won).toHaveLength(1);
      expect(won[0]).toMatchObject({
        type: 'WINNER_ANNOUNCEMENT',
        title: 'You won!',
        body: 'Your bid of ETB 3.00 was the lowest unique bid in "Win a phone". We will confirm the result and contact you about your prize.',
        data: { auctionId, winnerId: record.id, amountMinor: '300' },
      });

      for (const user of [loser, other]) {
        // One message per bidder, however many times they bid.
        const lost = await h.stored(user, 'WINNER_ANNOUNCEMENT', 'AUCTION_RESULT');
        expect(lost).toHaveLength(1);
        expect(lost[0]).toMatchObject({
          type: 'AUCTION_RESULT',
          title: 'Auction ended',
          body: '"Win a phone" has ended. The lowest unique bid was ETB 3.00. Your bids did not win this time.',
          data: { auctionId, outcome: 'WINNER_FOUND', winningAmountMinor: '300' },
        });
        // Nothing identifies the winner or anyone else's bids.
        const text = JSON.stringify(lost[0]);
        expect(text).not.toContain(winner.id);
        expect(text).not.toContain(winner.phoneNumber);
        expect(text).not.toContain(record.id);
        expect(text).not.toContain(record.bidId);
      }
    });

    it('says the fees are kept or refunded when no bid is unique', async () => {
      const [a, b] = await Promise.all([h.account(100000n), h.account(100000n)]);
      const kept = await h.liveAuction({ noUniqueBidPolicy: 'NO_WINNER', title: 'Fees kept' });
      const refunded = await h.liveAuction({ noUniqueBidPolicy: 'REFUND_BID_FEES', title: 'Fees refunded' });
      for (const auctionId of [kept, refunded]) {
        await h.bid(auctionId, a, [100]).expect(201);
        await h.bid(auctionId, b, [100]).expect(201);
        await h.finish(auctionId);
      }

      for (const user of [a, b]) {
        const notes = await h.stored(user, 'AUCTION_RESULT');
        expect(notes.map((n) => n.body).sort()).toEqual([
          '"Fees kept" has ended and no bid was unique, so there is no winner. Bid fees are not refunded for this auction.',
          '"Fees refunded" has ended and no bid was unique, so there is no winner. Your bid fees are being returned to your wallet.',
        ]);
        expect(notes.every((n) => n.title === 'Auction ended without a winner')).toBe(true);
        // Refunds are announced by that one message, not once per refunded request.
        expect(await h.stored(user, 'DEPOSIT_SUCCEEDED')).toHaveLength(1);
        expect(await h.stored(user, 'WINNER_ANNOUNCEMENT')).toEqual([]);
      }
      expect((await t.get('/wallet', a.token)).body.availableMinor).toBe((100000n - FEE).toString());
    });

    it('notifies nobody when an auction ends without bids', async () => {
      await h.account(100000n);
      const auctionId = await h.liveAuction();
      await h.finish(auctionId);

      expect((await t.prisma.auctionResult.findUniqueOrThrow({ where: { auctionId } })).outcome).toBe('NO_BIDS');
      expect(
        await t.prisma.notification.count({ where: { type: { in: ['AUCTION_RESULT', 'WINNER_ANNOUNCEMENT'] } } }),
      ).toBe(0);
    });

    it('notifies once when finalization is triggered many times at once', async () => {
      const [winner, loser] = await Promise.all([h.account(100000n), h.account(100000n)]);
      const auctionId = await h.liveAuction();
      await h.bid(auctionId, winner, [100, 300]).expect(201);
      await h.bid(auctionId, loser, [100]).expect(201);
      await t.prisma.auction.update({
        where: { id: auctionId },
        data: { opensAt: new Date(Date.now() - 2 * HOUR), closesAt: new Date(Date.now() - 1000) },
      });

      const calls = await Promise.all(
        Array.from({ length: 6 }, () => t.post(`/admin/auctions/${auctionId}/finalize`, {}, h.admin.token)),
      );
      await t.app.get(AuctionLifecycleProcessor).process();

      expect(calls.every((res) => res.status === 200)).toBe(true);
      expect(await h.stored(winner, 'WINNER_ANNOUNCEMENT', 'AUCTION_RESULT')).toHaveLength(1);
      expect(await h.stored(loser, 'WINNER_ANNOUNCEMENT', 'AUCTION_RESULT')).toHaveLength(1);
    });

    it('tells every bidder once when an auction is cancelled', async () => {
      const [a, b, bystander] = await Promise.all([h.account(100000n), h.account(100000n), h.account(100000n)]);
      const auctionId = await h.liveAuction();
      await h.bid(auctionId, a, [100]).expect(201);
      await h.bid(auctionId, a, [200, 300]).expect(201);
      await h.bid(auctionId, b, [100]).expect(201);

      await t
        .post(`/admin/auctions/${auctionId}/cancel`, { reason: 'Supplier withdrew the prize' }, h.admin.token)
        .expect(200);

      for (const user of [a, b]) {
        const [note, ...rest] = await h.stored(user, 'AUCTION_RESULT');
        expect(rest).toEqual([]);
        expect(note).toMatchObject({
          title: 'Auction cancelled',
          body: '"Win a phone" was cancelled. Your bid fees are being returned to your wallet.',
          data: { auctionId, outcome: 'CANCELLED' },
        });
        expect(note.body).not.toContain('Supplier');
        expect((await t.get('/wallet', user.token)).body.availableMinor).toBe('100000');
      }
      expect(await h.stored(bystander, 'AUCTION_RESULT')).toEqual([]);
    });

    it('notifies nobody when an auction without bids is cancelled', async () => {
      const auctionId = await h.liveAuction();
      await t
        .post(`/admin/auctions/${auctionId}/cancel`, { reason: 'Supplier withdrew the prize' }, h.admin.token)
        .expect(200);
      expect(await t.prisma.notification.count({ where: { type: 'AUCTION_RESULT' } })).toBe(0);
    });
  });

  describe('closing reminder', () => {
    const reminders = () => t.app.get(AuctionLifecycleProcessor).process();
    /** Makes the auction look as if it opened two hours ago and closes in `minutes`. */
    const closingIn = (auctionId: string, minutes: number, openedHoursAgo = 2) =>
      t.prisma.auction.update({
        where: { id: auctionId },
        data: {
          opensAt: new Date(Date.now() - openedHoursAgo * HOUR),
          activatedAt: new Date(Date.now() - openedHoursAgo * HOUR),
          closesAt: new Date(Date.now() + minutes * 60_000),
        },
      });

    it('reminds the bidders of an auction once, an hour before it closes', async () => {
      const [a, b, bystander] = await Promise.all([h.account(100000n), h.account(100000n), h.account(100000n)]);
      const auctionId = await h.liveAuction();
      await h.bid(auctionId, a, [100]).expect(201);
      await h.bid(auctionId, a, [200]).expect(201);
      await h.bid(auctionId, b, [100]).expect(201);

      await reminders();
      expect(await t.prisma.notification.count({ where: { type: 'AUCTION_CLOSING_REMINDER' } })).toBe(0);

      const { closesAt } = await closingIn(auctionId, 30);
      await reminders();
      await reminders();
      await Promise.all([reminders(), reminders()]);

      for (const user of [a, b]) {
        const [note, ...rest] = await h.stored(user, 'AUCTION_CLOSING_REMINDER');
        expect(rest).toEqual([]);
        expect(note).toMatchObject({
          title: 'Auction closing soon',
          body: '"Win a phone" closes in less than 1 hour. You can still place bids until then.',
          data: { auctionId, closesAt: closesAt.toISOString() },
        });
      }
      expect(await h.stored(bystander, 'AUCTION_CLOSING_REMINDER')).toEqual([]);
      const auction = await t.prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
      expect(auction.closingReminderSentAt).toBeInstanceOf(Date);
      expect(auction.status).toBe('ACTIVE');
    });

    it('sends no reminder for an auction shorter than the reminder time, or one that is not running', async () => {
      const user = await h.account(100000n);
      const short = await h.liveAuction({ title: 'Short' });
      const cancelled = await h.liveAuction({ title: 'Cancelled' });
      await h.bid(short, user, [100]).expect(201);
      await h.bid(cancelled, user, [100]).expect(201);
      await closingIn(short, 30, 0.25);
      await closingIn(cancelled, 30);
      await t
        .post(`/admin/auctions/${cancelled}/cancel`, { reason: 'Supplier withdrew the prize' }, h.admin.token)
        .expect(200);

      await reminders();

      expect(await h.stored(user, 'AUCTION_CLOSING_REMINDER')).toEqual([]);
    });

    it('can be switched off', async () => {
      const user = await h.account(100000n);
      const auctionId = await h.liveAuction();
      await h.bid(auctionId, user, [100]).expect(201);
      await closingIn(auctionId, 30);
      const config = t.app.get<AppConfig>(APP_CONFIG);
      const previous = config.auctions.closingReminderMinutes;
      config.auctions.closingReminderMinutes = 0;
      try {
        await reminders();
        expect(await h.stored(user, 'AUCTION_CLOSING_REMINDER')).toEqual([]);
      } finally {
        config.auctions.closingReminderMinutes = previous;
      }
      await reminders();
      expect(await h.stored(user, 'AUCTION_CLOSING_REMINDER')).toHaveLength(1);
    });
  });

  describe('winner verification and prize delivery', () => {
    async function wonAuction(winner: Account): Promise<string> {
      const other = await h.account(100000n);
      const auctionId = await h.liveAuction();
      await h.bid(auctionId, winner, [100, 300]).expect(201);
      await h.bid(auctionId, other, [100, 500]).expect(201);
      await h.finish(auctionId);
      return (await t.prisma.winner.findUniqueOrThrow({ where: { auctionId } })).id;
    }
    const act = (winnerId: string, action: string, body: object = {}, by: Account = h.admin) =>
      t.post(`/admin/winners/${winnerId}/${action}`, body, by.token);
    const move = (winnerId: string, status: string, note?: string) =>
      act(winnerId, 'delivery/status', { status, note }, h.support);
    const updates = async (user: Account) =>
      (await h.stored(user, 'WINNER_ANNOUNCEMENT', 'PRIZE_DELIVERY_UPDATE')).slice(1).map((n) => n.body);

    it('tells the winner when the win is confirmed', async () => {
      const user = await h.account(100000n);
      const winnerId = await wonAuction(user);

      await act(winnerId, 'verify', { note: 'ID checked by phone call' }).expect(200);

      const notes = await h.stored(user, 'WINNER_ANNOUNCEMENT');
      expect(notes).toHaveLength(2);
      expect(notes[1]).toMatchObject({
        title: 'Your win is confirmed',
        body: 'Your win in "Win a phone" has been confirmed. Please send your delivery details so we can get the prize to you.',
        data: { winnerId, verificationStatus: 'VERIFIED' },
      });
      expect(JSON.stringify(notes[1])).not.toContain('ID checked');
    });

    it('tells the winner when the win is rejected, without the internal reason', async () => {
      const user = await h.account(100000n);
      const winnerId = await wonAuction(user);

      await act(winnerId, 'reject', { reason: 'Suspected duplicate account, see case 77' }).expect(200);

      const notes = await h.stored(user, 'WINNER_ANNOUNCEMENT');
      expect(notes).toHaveLength(2);
      expect(notes[1]).toMatchObject({
        title: 'Your win could not be confirmed',
        data: { winnerId, verificationStatus: 'REJECTED' },
      });
      expect(JSON.stringify(notes[1])).not.toMatch(/duplicate account|case 77/);
    });

    it('does not notify when a staff action is refused', async () => {
      const user = await h.account(100000n);
      const winnerId = await wonAuction(user);

      await act(winnerId, 'verify', {}, h.support).expect(403);
      await act(winnerId, 'publish').expect(409);
      await move(winnerId, 'CONTACTED').expect(409);
      await act(winnerId, 'verify').expect(200);
      await move(winnerId, 'DELIVERED').expect(409);
      await move(winnerId, 'CONTACTED').expect(200);
      await move(winnerId, 'VERIFIED').expect(200);
      await move(winnerId, 'DISPATCHED').expect(422);

      expect(await updates(user)).toEqual([
        'Your win in "Win a phone" has been confirmed. Please send your delivery details so we can get the prize to you.',
        'Your prize from "Win a phone" is being arranged; our team has tried to reach you.',
        'Your prize from "Win a phone" has its delivery details confirmed.',
      ]);
    });

    it('reports each delivery step, with tracking once dispatched and without staff notes', async () => {
      const user = await h.account(100000n);
      const winnerId = await wonAuction(user);
      await act(winnerId, 'verify').expect(200);
      await t.put(`/winners/mine/${winnerId}/delivery-details`, DETAILS, user.token).expect(200);
      await t
        .patch(
          `/admin/winners/${winnerId}/delivery`,
          { trackingInfo: 'EMS EE123456789ET', notes: 'Customer prefers afternoon calls' },
          h.support.token,
        )
        .expect(200);

      await move(winnerId, 'CONTACTED', 'Called, will confirm address').expect(200);
      await move(winnerId, 'VERIFIED').expect(200);
      await move(winnerId, 'DISPATCHED').expect(200);
      await move(winnerId, 'DISPUTED', 'Courier reports wrong address').expect(200);
      await move(winnerId, 'DISPATCHED', 'Address corrected with the courier').expect(200);
      await move(winnerId, 'DELIVERED').expect(200);

      const notes = await h.stored(user, 'PRIZE_DELIVERY_UPDATE');
      expect(notes.map((n) => n.body)).toEqual([
        'Your prize from "Win a phone" is being arranged; our team has tried to reach you.',
        'Your prize from "Win a phone" has its delivery details confirmed.',
        'Your prize from "Win a phone" is on its way. Tracking: EMS EE123456789ET',
        'Your prize from "Win a phone" is on hold while an issue is looked into; our team will contact you.',
        'Your prize from "Win a phone" is on its way. Tracking: EMS EE123456789ET',
        'Your prize from "Win a phone" has been delivered. Enjoy!',
      ]);
      expect(notes.map((n) => (n.data as { deliveryStatus: string }).deliveryStatus)).toEqual([
        'CONTACTED',
        'VERIFIED',
        'DISPATCHED',
        'DISPUTED',
        'DISPATCHED',
        'DELIVERED',
      ]);
      expect(JSON.stringify(notes)).not.toMatch(/afternoon calls|wrong address|will confirm address|Courier/);
      // Only the winner hears about it.
      expect(
        await t.prisma.notification.count({ where: { type: 'PRIZE_DELIVERY_UPDATE', userId: { not: user.id } } }),
      ).toBe(0);
    });
  });

  describe('my notifications', () => {
    const notifications = () => t.app.get(NotificationsService);
    /** Writes `count` notifications for the user, one millisecond apart, and returns their titles oldest first. */
    async function seed(user: Account, count: number, type: NotificationType = 'AUCTION_RESULT'): Promise<string[]> {
      const titles: string[] = [];
      for (let i = 1; i <= count; i += 1) {
        titles.push(`${type} ${i}`);
        await t.prisma.$transaction((tx) =>
          notifications().notify(tx, user.id, { type, title: `${type} ${i}`, body: 'Body', data: { n: i } }),
        );
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return titles;
    }

    it('requires authentication on every route', async () => {
      const routes: ['get' | 'post', string][] = [
        ['get', '/notifications'],
        ['get', '/notifications/unread-count'],
        ['post', '/notifications/read-all'],
        ['post', `/notifications/${randomUUID()}/read`],
      ];
      for (const [method, path] of routes) {
        const res = await t[method](path);
        expect([path, res.status, res.body.error]).toEqual([path, 401, 'UNAUTHORIZED']);
      }
    });

    it('lists my notifications newest first, a page at a time', async () => {
      const user = await h.account();
      const titles = await seed(user, 5);

      const first = await inbox(user, '?limit=2');
      expect(first).toMatchObject({ total: 5, unread: 5, page: 1, limit: 2 });
      expect(first.items.map((n) => n.title)).toEqual([titles[4], titles[3]]);
      expect(first.items[0]).toEqual({
        id: expect.any(String),
        type: 'AUCTION_RESULT',
        title: titles[4],
        body: 'Body',
        data: { n: 5 },
        read: false,
        readAt: null,
        createdAt: expect.any(String),
      });

      const third = await inbox(user, '?limit=2&page=3');
      expect(third.items.map((n) => n.title)).toEqual([titles[0]]);
      expect((await inbox(user, '?limit=2&page=4')).items).toEqual([]);
      expect((await inbox(user)).items).toHaveLength(5);
    });

    it('starts empty for a new user', async () => {
      const user = await h.account();
      expect(await inbox(user)).toEqual({ items: [], total: 0, unread: 0, page: 1, limit: expect.any(Number) });
      expect(await unread(user)).toBe(0);
    });

    it('filters by type and by unread', async () => {
      const user = await h.account();
      await seed(user, 3, 'AUCTION_RESULT');
      await seed(user, 2, 'BID_SUBMITTED');
      const newestResult = (await inbox(user, '?type=AUCTION_RESULT')).items[0];
      await t.post(`/notifications/${newestResult.id}/read`, {}, user.token).expect(200);

      expect(await inbox(user, '?type=BID_SUBMITTED')).toMatchObject({ total: 2, unread: 4 });
      expect(await inbox(user, '?type=AUCTION_RESULT&unreadOnly=true')).toMatchObject({ total: 2, unread: 4 });
      expect(await inbox(user, '?unreadOnly=true')).toMatchObject({ total: 4, unread: 4 });
      expect(await inbox(user, '?unreadOnly=false')).toMatchObject({ total: 5, unread: 4 });
    });

    it('rejects invalid filters and identifiers', async () => {
      const user = await h.account();
      for (const query of ['?type=NOPE', '?unreadOnly=maybe', '?limit=0', '?limit=1000', '?page=0', '?page=abc']) {
        const res = await t.get(`/notifications${query}`, user.token);
        expect([query, res.status, res.body.error]).toEqual([query, 400, 'VALIDATION_FAILED']);
      }
      expect((await t.post('/notifications/not-a-uuid/read', {}, user.token)).status).toBe(400);
    });

    it('marks one notification as read, once', async () => {
      const user = await h.account();
      await seed(user, 3);
      const [newest] = (await inbox(user)).items;

      const read = await t.post(`/notifications/${newest.id}/read`, {}, user.token).expect(200);
      expect(read.body).toMatchObject({ id: newest.id, read: true, readAt: expect.any(String) });
      expect(await unread(user)).toBe(2);

      // Reading it again keeps the original time.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const again = await t.post(`/notifications/${newest.id}/read`, {}, user.token).expect(200);
      expect(again.body.readAt).toBe(read.body.readAt);
      expect(await unread(user)).toBe(2);

      const stored = await t.prisma.notification.findUniqueOrThrow({ where: { id: newest.id } });
      expect(stored.status).toBe(NotificationStatus.READ);
      const list = await inbox(user);
      expect(list.items.map((n) => n.read)).toEqual([true, false, false]);
      expect(list).toMatchObject({ total: 3, unread: 2 });
    });

    it('marks all my notifications as read and leaves other users alone', async () => {
      const [me, someoneElse] = await Promise.all([h.account(), h.account()]);
      await seed(me, 4);
      await seed(someoneElse, 2);
      const [first] = (await inbox(me)).items;
      await t.post(`/notifications/${first.id}/read`, {}, me.token).expect(200);

      expect((await t.post('/notifications/read-all', {}, me.token).expect(200)).body).toEqual({ updated: 3 });
      expect((await t.post('/notifications/read-all', {}, me.token).expect(200)).body).toEqual({ updated: 0 });

      expect(await unread(me)).toBe(0);
      expect((await inbox(me)).items.every((n) => n.read)).toBe(true);
      expect(await unread(someoneElse)).toBe(2);
      expect((await inbox(someoneElse)).items.every((n) => !n.read)).toBe(true);
    });

    it("never shows or changes another user's notifications", async () => {
      const [me, someoneElse, staff] = [await h.account(), await h.account(), h.admin];
      await seed(me, 2);
      await seed(someoneElse, 3);
      const theirs = (await inbox(someoneElse)).items;

      const mine = await inbox(me);
      expect(mine).toMatchObject({ total: 2, unread: 2 });
      expect(mine.items.map((n) => n.id).filter((id) => theirs.some((n) => n.id === id))).toEqual([]);

      // Not even a staff account can read or mark a notification that is not its own.
      for (const intruder of [me, staff]) {
        const res = await t.post(`/notifications/${theirs[0].id}/read`, {}, intruder.token);
        expect([res.status, res.body.error]).toEqual([404, 'NOT_FOUND']);
        expect(await inbox(intruder, '?limit=100')).not.toMatchObject({
          items: expect.arrayContaining([expect.objectContaining({ id: theirs[0].id })]),
        });
      }
      const missing = await t.post(`/notifications/${randomUUID()}/read`, {}, me.token);
      expect([missing.status, missing.body.error]).toEqual([404, 'NOT_FOUND']);

      expect(await unread(someoneElse)).toBe(3);
      expect((await t.prisma.notification.findUniqueOrThrow({ where: { id: theirs[0].id } })).readAt).toBeNull();
    });

    it('does not expose delivery internals or the owner in the response', async () => {
      const user = await h.account();
      await seed(user, 1);
      const [item] = (await inbox(user)).items;
      expect(Object.keys(item).sort()).toEqual(['body', 'createdAt', 'data', 'id', 'read', 'readAt', 'title', 'type']);
    });

    it('is removed with the user', async () => {
      const user = await h.account();
      await seed(user, 2);
      await t.prisma.user.delete({ where: { id: user.id } });
      expect(await t.prisma.notification.count({ where: { userId: user.id } })).toBe(0);
    });
  });

  describe('failure isolation', () => {
    /** Makes every insert into the notifications table fail, as a broken table or a full disk would. */
    const breakNotifications = async () => {
      await t.prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_reject_notifications() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'simulated notifications outage'; END $$ LANGUAGE plpgsql`);
      await t.prisma.$executeRawUnsafe(`
        CREATE TRIGGER test_reject_notifications BEFORE INSERT ON notifications
        FOR EACH ROW EXECUTE FUNCTION test_reject_notifications()`);
    };
    const repairNotifications = async () => {
      await t.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_reject_notifications ON notifications');
      await t.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_reject_notifications()');
    };
    afterEach(repairNotifications);

    it('completes every operation even though no notification can be written', async () => {
      const [winner, loser] = await Promise.all([h.account(100000n), h.account(100000n)]);
      const auctionId = await h.liveAuction();
      const cancelledId = await h.liveAuction({ title: 'To be cancelled' });
      await t.prisma.notification.deleteMany();
      await breakNotifications();

      // Money in.
      await t.app.get(WalletService).deposit({ userId: winner.id, amountMinor: 5000n });
      await t
        .post(
          `/admin/wallets/${loser.id}/adjustments`,
          { direction: 'CREDIT', amountMinor: '5000', reason: 'Correction for support ticket 1001' },
          h.finance.token,
        )
        .set('Idempotency-Key', randomUUID())
        .expect(201);

      // Bids, charged exactly as usual.
      const placed = await h.bid(auctionId, winner, [100, 300]).expect(201);
      expect(placed.body.bids).toHaveLength(2);
      await h.bid(auctionId, loser, [100]).expect(201);
      await h.bid(cancelledId, loser, [100]).expect(201);
      expect((await t.get('/wallet', winner.token)).body.availableMinor).toBe((105000n - 2n * FEE).toString());

      // Cancellation with refunds.
      await t
        .post(`/admin/auctions/${cancelledId}/cancel`, { reason: 'Supplier withdrew the prize' }, h.admin.token)
        .expect(200);
      expect((await t.get('/wallet', loser.token)).body.availableMinor).toBe((105000n - FEE).toString());

      // Result, verification and delivery.
      await h.finish(auctionId);
      const result = await t.get(`/auctions/${auctionId}/result`).expect(200);
      expect(result.body).toMatchObject({ outcome: 'WINNER_FOUND', winningAmountMinor: '300' });
      const record = await t.prisma.winner.findUniqueOrThrow({ where: { auctionId } });
      expect(record.userId).toBe(winner.id);
      await t.post(`/admin/winners/${record.id}/verify`, {}, h.admin.token).expect(200);
      const moved = await t
        .post(`/admin/winners/${record.id}/delivery/status`, { status: 'CONTACTED' }, h.support.token)
        .expect(200);
      expect(moved.body.delivery.status).toBe('CONTACTED');

      // Nothing was written, nothing else was lost, and the books still balance.
      expect(await t.prisma.notification.count()).toBe(0);
      expect(
        await t.prisma.auditLog.count({
          where: { action: { in: ['auction.finalize', 'winner.verify', 'delivery.status', 'auction.cancel'] } },
        }),
      ).toBe(4);
      const report = await t.app.get(ReconciliationService).reconcile();
      expect(report.issues).toEqual([]);

      // Once the fault is gone, notifications flow again.
      await repairNotifications();
      await h.bid(auctionId === cancelledId ? auctionId : await h.liveAuction(), winner, [100]).expect(201);
      expect(await h.stored(winner, 'BID_SUBMITTED')).toHaveLength(1);
    });

    it('keeps the notification out when the operation itself is rolled back', async () => {
      const user = await h.account();
      await expect(
        t.prisma.$transaction(async (tx) => {
          await t.app.get(WalletService).deposit({ userId: user.id, amountMinor: 5000n }, tx);
          throw new Error('the surrounding operation failed');
        }),
      ).rejects.toThrow('the surrounding operation failed');

      expect(await h.stored(user)).toEqual([]);
      expect((await t.get('/wallet', user.token)).body.availableMinor).toBe('0');
    });
  });

  describe('with no provider registered', () => {
    it('stores only in-app notifications and sends nothing', async () => {
      const [winner, loser] = await Promise.all([h.account(100000n), h.account(100000n)]);
      const auctionId = await h.liveAuction();
      await h.bid(auctionId, winner, [100, 300]).expect(201);
      await h.bid(auctionId, loser, [100]).expect(201);
      await h.finish(auctionId);

      const channels = await t.prisma.notification.groupBy({ by: ['channel', 'status'], _count: true });
      expect(channels).toEqual([{ channel: 'IN_APP', status: 'SENT', _count: expect.any(Number) }]);
      expect(t.app.get(NotificationDispatcher).enabled).toBe(false);
      expect(await t.app.get(NotificationDispatcher).dispatchPending()).toEqual({ sent: 0, failed: 0 });
      expect(t.sms.messages).toEqual([]);
    });
  });
});

describe('Notifications with an external provider', () => {
  let t: TestApp;
  const sms = new FakeSmsProvider();
  const h = harness(() => t);
  const dispatcher = () => t.app.get(NotificationDispatcher);

  beforeAll(async () => {
    t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' }, [sms]);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    sms.sent.length = 0;
    sms.failing = false;
    sms.rejectsEverything = false;
    await h.reset();
  });

  /** Runs an auction that `winner` wins against one other bidder. */
  async function runAuction(winner: Account): Promise<{ auctionId: string; loser: Account }> {
    const loser = await h.account(100000n);
    const auctionId = await h.liveAuction();
    await h.bid(auctionId, winner, [100, 300]).expect(201);
    await h.bid(auctionId, loser, [100]).expect(201);
    await h.finish(auctionId);
    return { auctionId, loser };
  }
  const smsRows = () => t.prisma.notification.findMany({ where: { channel: 'SMS' }, orderBy: { createdAt: 'asc' } });
  /** Makes every waiting retry due now. */
  const skipWaiting = () =>
    t.prisma.notification.updateMany({ where: { nextAttemptAt: { not: null } }, data: { nextAttemptAt: new Date(0) } });

  it('queues a copy only for the types the provider accepts, and sends it to the right phone', async () => {
    const winner = await h.account(100000n);
    const { loser } = await runAuction(winner);

    const queued = await smsRows();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      userId: winner.id,
      type: 'WINNER_ANNOUNCEMENT',
      status: 'PENDING',
      attempts: 0,
      sentAt: null,
    });
    expect(sms.sent).toEqual([]);

    expect(await dispatcher().dispatchPending()).toEqual({ sent: 1, failed: 0 });

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]).toMatchObject({
      id: queued[0].id,
      type: 'WINNER_ANNOUNCEMENT',
      title: 'You won!',
      recipient: { userId: winner.id, phoneNumber: winner.phoneNumber, locale: expect.any(String) },
    });
    expect(sms.sent[0].body).toContain('ETB 3.00');
    const [row] = await smsRows();
    expect(row).toMatchObject({ status: 'SENT', attempts: 1, lastError: null, nextAttemptAt: null });
    expect(row.sentAt).toBeInstanceOf(Date);

    // Sent once: later runs find nothing to do.
    expect(await dispatcher().dispatchPending()).toEqual({ sent: 0, failed: 0 });
    expect(sms.sent).toHaveLength(1);
    // Nothing went to anyone else's phone.
    expect(sms.sent.some((n) => n.recipient.userId === loser.id)).toBe(false);
  });

  it('shows the user one notification, not one per channel', async () => {
    const winner = await h.account(100000n);
    await runAuction(winner);
    await dispatcher().dispatchPending();

    const list = (await t.get('/notifications?type=WINNER_ANNOUNCEMENT', winner.token).expect(200)).body;
    expect(list.items).toHaveLength(1);
    expect(list.total).toBe(1);
    const all = (await t.get('/notifications', winner.token).expect(200)).body;
    expect((await t.get('/notifications/unread-count', winner.token)).body.unread).toBe(all.total);

    // The SMS copy cannot be marked as read through the inbox, and reading all leaves it untouched.
    const [smsCopy] = await smsRows();
    await t.post(`/notifications/${smsCopy.id}/read`, {}, winner.token).expect(404);
    await t.post('/notifications/read-all', {}, winner.token).expect(200);
    expect((await smsRows())[0]).toMatchObject({ status: 'SENT', readAt: null });
  });

  it('sends each notification once when several dispatchers run at the same time', async () => {
    const winners = await Promise.all(Array.from({ length: 4 }, () => h.account(100000n)));
    for (const winner of winners) await runAuction(winner);

    const runs = await Promise.all(Array.from({ length: 5 }, () => dispatcher().dispatchPending()));

    expect(runs.reduce((sum, run) => sum + run.sent, 0)).toBe(4);
    expect(sms.sent).toHaveLength(4);
    expect(new Set(sms.sent.map((n) => n.id)).size).toBe(4);
  });

  it('retries a failed delivery later, and the event itself is unaffected', async () => {
    const winner = await h.account(100000n);
    sms.failing = true;
    const { auctionId } = await runAuction(winner);

    expect(await dispatcher().dispatchPending()).toEqual({ sent: 0, failed: 1 });

    // The auction result, the winner and the in-app notification are all in place.
    expect((await t.get(`/auctions/${auctionId}/result`).expect(200)).body.outcome).toBe('WINNER_FOUND');
    const inApp = await t.get('/notifications?type=WINNER_ANNOUNCEMENT', winner.token).expect(200);
    expect(inApp.body.items).toHaveLength(1);
    const [failed] = await smsRows();
    expect(failed).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'simulated SMS gateway outage',
      sentAt: null,
    });
    const wait = failed.nextAttemptAt!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThanOrEqual(60_000);

    // Not retried before its time, even though the gateway is back.
    sms.failing = false;
    expect(await dispatcher().dispatchPending()).toEqual({ sent: 0, failed: 0 });
    expect(sms.sent).toEqual([]);

    await skipWaiting();
    expect(await dispatcher().dispatchPending()).toEqual({ sent: 1, failed: 0 });
    expect(sms.sent).toHaveLength(1);
    expect((await smsRows())[0]).toMatchObject({ status: 'SENT', attempts: 2, lastError: null, nextAttemptAt: null });
  });

  it('gives up after the maximum number of attempts', async () => {
    const winner = await h.account(100000n);
    sms.failing = true;
    await runAuction(winner);

    const waits: number[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      expect(await dispatcher().dispatchPending()).toEqual({ sent: 0, failed: 1 });
      const [row] = await smsRows();
      expect(row.attempts).toBe(attempt);
      if (row.nextAttemptAt) waits.push(Math.round((row.nextAttemptAt.getTime() - Date.now()) / 60_000));
      await skipWaiting();
    }

    expect(waits).toEqual([1, 5, 30, 120]);
    expect((await smsRows())[0]).toMatchObject({
      status: 'FAILED',
      attempts: MAX_ATTEMPTS,
      nextAttemptAt: null,
      sentAt: null,
    });
    sms.failing = false;
    expect(await dispatcher().dispatchPending()).toEqual({ sent: 0, failed: 0 });
    expect(sms.sent).toEqual([]);
  });

  it('does not let one failing notification hold up the others', async () => {
    const [first, second] = await Promise.all([h.account(100000n), h.account(100000n)]);
    await runAuction(first);
    await runAuction(second);
    const send = sms.send.bind(sms);
    jest
      .spyOn(sms, 'send')
      .mockImplementation((n) =>
        n.recipient.userId === first.id ? Promise.reject(new Error('number unreachable')) : send(n),
      );
    try {
      expect(await dispatcher().dispatchPending()).toEqual({ sent: 1, failed: 1 });
    } finally {
      jest.restoreAllMocks();
    }
    expect(sms.sent.map((n) => n.recipient.userId)).toEqual([second.id]);
  });

  it('completes the event when the provider itself misbehaves while the notification is recorded', async () => {
    const user = await h.account(100000n);
    const auctionId = await h.liveAuction();
    await t.prisma.notification.deleteMany();
    sms.rejectsEverything = true;

    const placed = await h.bid(auctionId, user, [100]).expect(201);

    expect(placed.body.bids).toHaveLength(1);
    expect((await t.get('/wallet', user.token)).body.availableMinor).toBe((100000n - FEE).toString());
    expect(await t.prisma.notification.count()).toBe(0);
  });
});

describe('Notifications background job', () => {
  let t: TestApp;
  const sms = new FakeSmsProvider();
  const h = harness(() => t);

  beforeAll(async () => {
    t = await createTestApp(
      { PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none', NOTIFICATION_DISPATCH_INTERVAL_SECONDS: '1' },
      [sms],
    );
  });
  afterAll(async () => {
    await t.close();
  });

  it('sends pending notifications on its own', async () => {
    await h.reset();
    // Resetting flushed Redis, and the schedule with it; register it again as a fresh start would.
    await t.app.get(NotificationsProcessor).onApplicationBootstrap();
    const winner = await h.account(100000n);
    const loser = await h.account(100000n);
    const auctionId = await h.liveAuction();
    await h.bid(auctionId, winner, [100, 300]).expect(201);
    await h.bid(auctionId, loser, [100]).expect(201);
    await h.finish(auctionId);

    const deadline = Date.now() + 10_000;
    while (sms.sent.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sms.sent.map((n) => n.recipient.phoneNumber)).toEqual([winner.phoneNumber]);
    const row = await t.prisma.notification.findFirstOrThrow({ where: { channel: 'SMS' } });
    expect(row).toMatchObject({ status: 'SENT', attempts: 1 });
  });
});
