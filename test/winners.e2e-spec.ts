import { RoleName } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuctionLifecycleProcessor } from '../src/modules/auctions/auction-lifecycle.processor';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd';
const HOUR = 3_600_000;
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

describe('Winners and prize delivery', () => {
  let t: TestApp;
  let admin: Account;
  let support: Account;
  let finance: Account;
  let phoneCounter = 0;

  beforeAll(async () => {
    t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await account(0n, RoleName.ADMIN);
    support = await account(0n, RoleName.SUPPORT);
    finance = await account(0n, RoleName.FINANCE);
  });

  async function account(balanceMinor = 0n, ...roles: RoleName[]): Promise<Account> {
    const phoneNumber = `+2519${String(50000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    for (const name of roles) {
      const role = await t.prisma.role.findUniqueOrThrow({ where: { name } });
      await t.prisma.userRole.create({ data: { userId: res.body.userId, roleId: role.id } });
    }
    if (balanceMinor > 0n)
      await t.app.get(WalletService).deposit({ userId: res.body.userId, amountMinor: balanceMinor });
    return { id: res.body.userId, token: res.body.tokens.accessToken, phoneNumber };
  }

  /** Runs a whole auction that `winner` wins with a bid of 3.00; returns the winner record id. */
  async function wonAuction(winner: Account, title = 'Win a phone'): Promise<{ auctionId: string; winnerId: string }> {
    const product = await t.post(
      '/admin/products',
      { name: 'Galaxy A55', images: [{ url: 'https://cdn.example.com/a55.jpg' }] },
      admin.token,
    );
    const body = {
      productId: product.body.id,
      title,
      bidFeeMinor: '7500',
      minBidMinor: '100',
      maxBidMinor: '100000',
      bidStepMinor: '100',
      opensAt: inHours(1),
      closesAt: inHours(25),
      noUniqueBidPolicy: 'NO_WINNER',
    };
    const { id: auctionId } = (await t.post('/admin/auctions', body, admin.token).expect(201)).body;
    await t.post(`/admin/auctions/${auctionId}/activate`, {}, admin.token).expect(200);
    const other = await account(100000n);
    const place = (user: Account, amounts: string[]) =>
      t.post(`/auctions/${auctionId}/bids`, { amountsMinor: amounts }, user.token).set('Idempotency-Key', randomUUID());
    await place(winner, ['100', '300']).expect(201);
    await place(other, ['100', '500']).expect(201);
    await t.prisma.auction.update({
      where: { id: auctionId },
      data: { opensAt: new Date(Date.now() - 2 * HOUR), closesAt: new Date(Date.now() - 1000) },
    });
    await t.app.get(AuctionLifecycleProcessor).process();
    const record = await t.prisma.winner.findUniqueOrThrow({ where: { auctionId } });
    expect(record.userId).toBe(winner.id);
    return { auctionId, winnerId: record.id };
  }

  const act = (winnerId: string, action: string, body: object = {}, by: Account = admin) =>
    t.post(`/admin/winners/${winnerId}/${action}`, body, by.token);
  const move = (winnerId: string, status: string, note?: string, by: Account = support) =>
    act(winnerId, 'delivery/status', { status, note }, by);
  const audits = (action: string) => t.prisma.auditLog.findMany({ where: { action } });

  describe('verification', () => {
    it('starts as pending, with no delivery, and is not public', async () => {
      const user = await account(100000n);
      const { auctionId, winnerId } = await wonAuction(user);

      const detail = await t.get(`/admin/winners/${winnerId}`, admin.token).expect(200);
      expect(detail.body).toMatchObject({
        id: winnerId,
        auctionId,
        auctionTitle: 'Win a phone',
        productName: 'Galaxy A55',
        productImageUrl: 'https://cdn.example.com/a55.jpg',
        userId: user.id,
        phoneNumber: user.phoneNumber,
        amountMinor: '300',
        amount: '3.00',
        currency: 'ETB',
        verificationStatus: 'PENDING_VERIFICATION',
        verifiedAt: null,
        publishedAt: null,
        delivery: null,
      });
      expect((await t.get('/winners').expect(200)).body).toMatchObject({ items: [], total: 0 });
      const mine = await t.get('/winners/mine', user.token).expect(200);
      expect(mine.body.items).toHaveLength(1);
      expect(mine.body.items[0]).toMatchObject({
        id: winnerId,
        verificationStatus: 'PENDING_VERIFICATION',
        delivery: null,
        canEditDeliveryDetails: false,
      });
    });

    it('verifies a winner, opens the delivery and writes an audit record', async () => {
      const user = await account(100000n);
      const { winnerId } = await wonAuction(user);

      const res = await act(winnerId, 'verify', { note: 'ID checked by phone call' }).expect(200);

      expect(res.body).toMatchObject({
        verificationStatus: 'VERIFIED',
        verificationNote: 'ID checked by phone call',
        verifiedById: admin.id,
        verifiedAt: expect.any(String),
        delivery: {
          status: 'PENDING',
          recipientName: null,
          allowedNextStatuses: ['CONTACTED', 'DISPUTED'],
          events: [{ fromStatus: null, toStatus: 'PENDING', actorId: admin.id }],
        },
      });
      const [audit] = await audits('winner.verify');
      expect(audit).toMatchObject({
        actorId: admin.id,
        actorType: 'ADMIN',
        entityId: winnerId,
        before: { verificationStatus: 'PENDING_VERIFICATION' },
        after: { verificationStatus: 'VERIFIED' },
      });
      const again = await act(winnerId, 'verify');
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('WINNER_INVALID_STATE');
      expect(await t.prisma.prizeDelivery.count()).toBe(1);
    });

    it('rejects a winner with a reason, and allows verifying them afterwards', async () => {
      const { winnerId } = await wonAuction(await account(100000n));

      expect((await act(winnerId, 'reject', {})).status).toBe(400);
      const res = await act(winnerId, 'reject', { reason: 'Could not reach the winner' }).expect(200);
      expect(res.body).toMatchObject({
        verificationStatus: 'REJECTED',
        verificationNote: 'Could not reach the winner',
        delivery: null,
      });
      expect((await audits('winner.reject'))[0].metadata).toMatchObject({ reason: 'Could not reach the winner' });
      expect((await act(winnerId, 'reject', { reason: 'Again, twice' })).status).toBe(409);
      expect((await act(winnerId, 'publish')).body.error).toBe('WINNER_INVALID_STATE');
      // The auction result is untouched.
      expect(await t.prisma.auctionResult.count({ where: { outcome: 'WINNER_FOUND' } })).toBe(1);

      const verified = await act(winnerId, 'verify').expect(200);
      expect(verified.body).toMatchObject({ verificationStatus: 'VERIFIED', verificationNote: null });
    });

    it('refuses to verify when the recorded result no longer matches the bids on record', async () => {
      const { winnerId } = await wonAuction(await account(100000n));
      // Simulate a tampered winner record pointing at a bid that did not win.
      const losing = await t.prisma.bid.findFirstOrThrow({ where: { amountMinor: 500n } });
      await t.prisma.winner.update({ where: { id: winnerId }, data: { bidId: losing.id } });

      const res = await act(winnerId, 'verify');

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('RESULT_MISMATCH');
      expect((await t.prisma.winner.findUniqueOrThrow({ where: { id: winnerId } })).verificationStatus).toBe(
        'PENDING_VERIFICATION',
      );
      expect(await t.prisma.prizeDelivery.count()).toBe(0);
    });

    it('does not let an admin verify their own win', async () => {
      const user = await account(100000n);
      const { winnerId } = await wonAuction(user);
      const role = await t.prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMIN } });
      await t.prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      const login = await t.post('/auth/login', { phoneNumber: user.phoneNumber, password: PASSWORD }).expect(200);

      const res = await t.post(`/admin/winners/${winnerId}/verify`, {}, login.body.tokens.accessToken);

      expect(res.status).toBe(403);
      await act(winnerId, 'verify').expect(200);
    });
  });

  describe('publishing', () => {
    it('shows only verified, published winners in the public list, with the phone number masked', async () => {
      const first = await account(100000n);
      const second = await account(100000n);
      const a = await wonAuction(first, 'First auction');
      const b = await wonAuction(second, 'Second auction');
      const c = await wonAuction(await account(100000n), 'Third auction');

      const early = await act(a.winnerId, 'publish');
      expect(early.status).toBe(409);
      expect(early.body.error).toBe('WINNER_INVALID_STATE');

      await act(a.winnerId, 'verify').expect(200);
      await act(b.winnerId, 'verify').expect(200);
      await act(c.winnerId, 'verify').expect(200); // verified but never published
      await act(a.winnerId, 'publish').expect(200);
      const published = await act(b.winnerId, 'publish').expect(200);
      expect(published.body.publishedAt).toEqual(expect.any(String));
      const repeat = await act(b.winnerId, 'publish').expect(200);
      expect(repeat.body.publishedAt).toBe(published.body.publishedAt);
      expect(await audits('winner.publish')).toHaveLength(2);

      const list = await t.get('/winners').expect(200);
      expect(list.body.total).toBe(2);
      expect(list.body.items.map((w: { auctionTitle: string }) => w.auctionTitle)).toEqual([
        'Second auction',
        'First auction',
      ]);
      expect(list.body.items[0]).toEqual({
        id: b.winnerId,
        auctionId: b.auctionId,
        auctionTitle: 'Second auction',
        productName: 'Galaxy A55',
        productImageUrl: 'https://cdn.example.com/a55.jpg',
        amountMinor: '300',
        amount: '3.00',
        currency: 'ETB',
        winnerLabel: `${second.phoneNumber.slice(0, 5)}******${second.phoneNumber.slice(-2)}`,
        publishedAt: published.body.publishedAt,
      });
      expect(JSON.stringify(list.body)).not.toContain(second.phoneNumber);
      expect(JSON.stringify(list.body)).not.toContain(second.id);
      expect((await t.get('/winners?limit=1&page=2').expect(200)).body.items).toHaveLength(1);

      await act(b.winnerId, 'unpublish').expect(200);
      await act(b.winnerId, 'unpublish').expect(200);
      expect(await audits('winner.unpublish')).toHaveLength(1);
      expect((await t.get('/winners').expect(200)).body.total).toBe(1);
      expect((await t.get('/admin/winners?published=true', admin.token)).body.total).toBe(1);
      expect((await t.get('/admin/winners?published=false', admin.token)).body.total).toBe(2);
    });

    it('shows one published winner with the whole draw, and nothing that is not published', async () => {
      const person = await account(100000n);
      const { auctionId, winnerId } = await wonAuction(person);
      await t.get(`/winners/${winnerId}`).expect(404); // pending
      await act(winnerId, 'verify').expect(200);
      await t.get(`/winners/${winnerId}`).expect(404); // verified, not published
      await act(winnerId, 'publish').expect(200);

      const detail = await t.get(`/winners/${winnerId}`).expect(200);
      expect(detail.body).toMatchObject({
        id: winnerId,
        auctionId,
        amountMinor: '300',
        amount: '3.00',
        bidFeeMinor: '7500',
        bidFee: '75.00',
        totalBids: 4,
        distinctAmounts: 3,
        uniqueAmounts: 2,
        histogram: [
          { amountMinor: '100', amount: '1.00', count: 2 },
          { amountMinor: '300', amount: '3.00', count: 1 },
          { amountMinor: '500', amount: '5.00', count: 1 },
        ],
      });
      expect(JSON.stringify(detail.body)).not.toContain(person.phoneNumber);
      expect(JSON.stringify(detail.body)).not.toContain(person.id);

      await act(winnerId, 'unpublish').expect(200);
      await t.get(`/winners/${winnerId}`).expect(404);
      await t.get(`/winners/${randomUUID()}`).expect(404);
      await t.get('/winners/not-a-uuid').expect(400);
    });

    it('cannot publish an unverified winner even directly in the database', async () => {
      const { winnerId } = await wonAuction(await account(100000n));
      await expect(
        t.prisma.winner.update({ where: { id: winnerId }, data: { publishedAt: new Date() } }),
      ).rejects.toThrow();
    });
  });

  describe('prize delivery', () => {
    it('walks a delivery from pending to delivered and keeps the history', async () => {
      const user = await account(100000n);
      const { winnerId } = await wonAuction(user);
      const notYet = await move(winnerId, 'CONTACTED');
      expect(notYet.status).toBe(409);
      expect(notYet.body.error).toBe('WINNER_INVALID_STATE');
      await act(winnerId, 'verify').expect(200);

      await move(winnerId, 'CONTACTED', 'Called the winner').expect(200);
      const skipped = await move(winnerId, 'DISPATCHED');
      expect(skipped.status).toBe(409);
      expect(skipped.body.error).toBe('DELIVERY_INVALID_STATE');
      expect(skipped.body.details).toEqual({ status: 'CONTACTED', allowedNextStatuses: ['VERIFIED', 'DISPUTED'] });
      await move(winnerId, 'VERIFIED').expect(200);

      const noRecipient = await move(winnerId, 'DISPATCHED');
      expect(noRecipient.status).toBe(422);
      expect(noRecipient.body.error).toBe('DELIVERY_DETAILS_REQUIRED');
      expect(noRecipient.body.details).toEqual({ missing: ['recipientName', 'recipientPhone', 'address'] });

      const updated = await t
        .patch(
          `/admin/winners/${winnerId}/delivery`,
          { ...DETAILS, trackingInfo: 'EMS 123456', notes: 'Fragile' },
          support.token,
        )
        .expect(200);
      expect(updated.body.delivery).toMatchObject({ ...DETAILS, trackingInfo: 'EMS 123456', notes: 'Fragile' });
      await move(winnerId, 'DISPATCHED').expect(200);
      const done = await move(winnerId, 'DELIVERED', 'Handed over, ID shown', admin).expect(200);

      expect(done.body.delivery.status).toBe('DELIVERED');
      expect(done.body.delivery.allowedNextStatuses).toEqual(['DISPUTED']);
      expect(done.body.delivery.events.map((e: { toStatus: string }) => e.toStatus)).toEqual([
        'PENDING',
        'CONTACTED',
        'VERIFIED',
        'DISPATCHED',
        'DELIVERED',
      ]);
      expect(done.body.delivery.events.at(-1)).toMatchObject({
        fromStatus: 'DISPATCHED',
        note: 'Handed over, ID shown',
        actorId: admin.id,
      });
      expect(await audits('delivery.status')).toHaveLength(4);
      expect((await audits('delivery.update'))[0]).toMatchObject({ actorId: support.id, entityId: winnerId });

      // The winner sees the progress and tracking, but not the internal notes or history.
      const mine = (await t.get('/winners/mine', user.token).expect(200)).body.items[0];
      expect(mine.delivery).toMatchObject({
        status: 'DELIVERED',
        trackingInfo: 'EMS 123456',
        recipientName: 'Abebe Kebede',
      });
      expect(mine.delivery.notes).toBeUndefined();
      expect(mine.delivery.events).toBeUndefined();
      expect((await t.get('/admin/winners?deliveryStatus=DELIVERED', finance.token)).body.total).toBe(1);
      expect((await t.get('/admin/winners?deliveryStatus=PENDING', finance.token)).body.total).toBe(0);
    });

    it('requires a note to raise and to settle a dispute', async () => {
      const { winnerId } = await wonAuction(await account(100000n));
      await act(winnerId, 'verify').expect(200);
      await move(winnerId, 'CONTACTED').expect(200);

      const noNote = await move(winnerId, 'DISPUTED');
      expect(noNote.status).toBe(422);
      expect(noNote.body.details).toEqual({ missing: ['note'] });
      await move(winnerId, 'DISPUTED', 'Winner says the number is not theirs').expect(200);
      expect((await move(winnerId, 'VERIFIED')).status).toBe(422);
      expect((await move(winnerId, 'PENDING', 'Start over')).status).toBe(409);
      const settled = await move(winnerId, 'VERIFIED', 'Identity confirmed in person').expect(200);
      expect(settled.body.delivery.status).toBe('VERIFIED');
      expect((await move(winnerId, 'NOT_A_STATUS')).status).toBe(400);
    });

    it('lets the winner send delivery details until staff confirm them', async () => {
      const user = await account(100000n);
      const stranger = await account(100000n);
      const { winnerId } = await wonAuction(user);
      const send = (body: object, by: Account = user) =>
        t.put(`/winners/mine/${winnerId}/delivery-details`, body, by.token);

      const unverified = await send(DETAILS);
      expect(unverified.status).toBe(409);
      expect(unverified.body.error).toBe('WINNER_INVALID_STATE');
      await act(winnerId, 'verify').expect(200);

      expect((await t.put(`/winners/mine/${winnerId}/delivery-details`, DETAILS)).status).toBe(401);
      expect((await send(DETAILS, stranger)).status).toBe(404);
      expect((await send({ ...DETAILS, recipientPhone: 'call me' })).status).toBe(400);
      expect((await send({ ...DETAILS, address: { subCity: 'Bole' } })).status).toBe(400);
      expect((await send({ ...DETAILS, address: { ...DETAILS.address, extra: 'x' } })).status).toBe(400);

      const saved = await send(DETAILS).expect(200);
      expect(saved.body).toMatchObject({ canEditDeliveryDetails: true, delivery: { ...DETAILS, status: 'PENDING' } });
      expect((await audits('delivery.details-submitted'))[0]).toMatchObject({ actorId: user.id, actorType: 'USER' });
      await move(winnerId, 'CONTACTED').expect(200);
      await send({ ...DETAILS, recipientName: 'Almaz Kebede' }).expect(200);
      await move(winnerId, 'VERIFIED').expect(200);

      const late = await send({ ...DETAILS, recipientName: 'Someone Else' });
      expect(late.status).toBe(409);
      expect(late.body.error).toBe('DELIVERY_INVALID_STATE');
      const detail = await t.get(`/admin/winners/${winnerId}`, support.token).expect(200);
      expect(detail.body.delivery.recipientName).toBe('Almaz Kebede');
      expect((await t.get('/winners/mine', stranger.token).expect(200)).body.items).toEqual([]);
    });
  });

  describe('permissions', () => {
    it('limits each action to the roles that own it', async () => {
      const user = await account(100000n);
      const { winnerId } = await wonAuction(user);
      const missing = randomUUID();

      for (const path of ['/admin/winners', `/admin/winners/${winnerId}`]) {
        expect((await t.get(path)).status).toBe(401);
        expect((await t.get(path, user.token)).status).toBe(403);
        for (const staff of [support, finance, admin]) expect((await t.get(path, staff.token)).status).toBe(200);
      }
      for (const action of ['verify', 'reject', 'publish', 'unpublish']) {
        expect((await t.post(`/admin/winners/${winnerId}/${action}`, { reason: 'Not allowed' })).status).toBe(401);
        for (const who of [user, support, finance]) {
          expect((await act(winnerId, action, { reason: 'Not allowed' }, who)).status).toBe(403);
        }
        expect((await act(missing, action, action === 'reject' ? { reason: 'No such winner' } : {})).status).toBe(404);
      }
      await act(winnerId, 'verify').expect(200);
      for (const who of [user, finance]) {
        expect((await move(winnerId, 'CONTACTED', undefined, who)).status).toBe(403);
        expect((await t.patch(`/admin/winners/${winnerId}/delivery`, { notes: 'x' }, who.token)).status).toBe(403);
      }
      expect((await t.patch(`/admin/winners/${winnerId}/delivery`, { notes: 'x' })).status).toBe(401);
      expect((await t.patch(`/admin/winners/${missing}/delivery`, { notes: 'x' }, support.token)).status).toBe(404);
      await move(winnerId, 'CONTACTED', undefined, support).expect(200);
      expect(
        (await t.get(`/admin/winners?userId=${user.id}&verificationStatus=VERIFIED`, support.token)).body.total,
      ).toBe(1);
      expect((await t.get('/admin/winners?verificationStatus=REJECTED', support.token)).body.total).toBe(0);
      expect((await t.get('/admin/winners?published=maybe', support.token)).status).toBe(400);
    });
  });
});
