import { RoleName, WalletTransactionType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ReconciliationService } from '../src/modules/ledger/reconciliation.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { FakeChapa } from './helpers/fake-chapa';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

interface Account {
  id: string;
  token: string;
}

/** Top-up bonus: 100% of a wallet top-up, at most ETB 10,000, for 7 days, spent on bid fees before cash. */
describe('Top-up bonus', () => {
  const chapa = new FakeChapa();
  let t: TestApp;
  let wallets: WalletService;
  let admin: Account;
  let phoneCounter = 0;

  beforeAll(async () => {
    await chapa.start();
    t = await createTestApp({
      PHONE_VERIFICATION_REQUIRED: 'false',
      OTP_PROVIDER: 'none',
      PAYMENT_PROVIDER: 'chapa',
      CHAPA_SECRET_KEY: 'CHASECK_TEST-e2e-not-a-real-key',
      CHAPA_WEBHOOK_SECRET: 'e2e-webhook-secret-0001',
      CHAPA_BASE_URL: chapa.baseUrl,
      WEB_APP_URL: 'http://localhost:5173',
    });
    wallets = t.app.get(WalletService);
  });
  afterAll(async () => {
    await t.close();
    await chapa.stop();
  });
  beforeEach(async () => {
    await t.reset();
    chapa.reset();
    admin = await account(RoleName.ADMIN);
  });

  async function account(...roles: RoleName[]): Promise<Account> {
    const phoneNumber = `+2519${String(50000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    for (const name of roles) {
      const role = await t.prisma.role.findUniqueOrThrow({ where: { name } });
      await t.prisma.userRole.create({ data: { userId: res.body.userId, roleId: role.id } });
    }
    return { id: res.body.userId, token: res.body.tokens.accessToken };
  }

  /** Tops up through Chapa (paid on the phone) and returns the confirmed deposit. */
  async function topUp(user: Account, amountMinor: string) {
    const res = await t
      .post('/wallet/deposits', { amountMinor, charge: { method: 'telebirr' } }, user.token)
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    chapa.pay(res.body.reference);
    return (await t.get(`/wallet/deposits/${res.body.id}`, user.token).expect(200)).body;
  }

  /** Fee 75.00, amounts 1.00 … 1000.00. */
  async function liveAuction(): Promise<string> {
    const product = await t.post('/admin/products', { name: 'Prize', marketValueMinor: '6500000' }, admin.token);
    const body = {
      productId: product.body.id,
      title: 'Win a phone',
      bidFeeMinor: '7500',
      minBidMinor: '100',
      maxBidMinor: '100000',
      bidStepMinor: '100',
      opensAt: inHours(1),
      closesAt: inHours(25),
      noUniqueBidPolicy: 'NO_WINNER',
    };
    const { id } = (await t.post('/admin/auctions', body, admin.token).expect(201)).body;
    await t.post(`/admin/auctions/${id}/activate`, {}, admin.token).expect(200);
    return id;
  }

  const bid = (user: Account, auctionId: string, amountsMinor: string[]) =>
    t.post(`/auctions/${auctionId}/bids`, { amountsMinor }, user.token).set('Idempotency-Key', randomUUID());
  const wallet = async (user: Account) => (await t.get('/wallet', user.token).expect(200)).body;
  const expectBooksToBalance = async () => {
    const report = await t.app.get(ReconciliationService).reconcile();
    expect(report.issues).toEqual([]);
  };

  it('promises the bonus when the top-up opens and gives it once the payment is confirmed', async () => {
    const user = await account();
    const res = await t
      .post('/wallet/deposits', { amountMinor: '50000', charge: { method: 'telebirr' } }, user.token)
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    expect(res.body).toMatchObject({ bonusMinor: '50000', bonus: '500.00' });
    expect((await wallet(user)).bonusMinor).toBe('0');

    chapa.pay(res.body.reference);
    await t.get(`/wallet/deposits/${res.body.id}`, user.token).expect(200);
    // Asked again: the bonus is given once.
    await t.prisma.paymentTransaction.updateMany({ data: { lastCheckedAt: null } });
    await t.get(`/wallet/deposits/${res.body.id}`, user.token).expect(200);

    const w = await wallet(user);
    expect(w).toMatchObject({
      availableMinor: '50000',
      bonusMinor: '50000',
      bonus: '500.00',
      spendableMinor: '100000',
      spendable: '1000.00',
    });
    const expires = new Date(w.bonusExpiresAt).getTime();
    expect(Math.abs(expires - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
    expect(await t.prisma.walletBonusGrant.count()).toBe(1);
    await expectBooksToBalance();
  });

  it('gives at most ETB 10,000 for one top-up', async () => {
    const user = await account();
    const paid = await topUp(user, '2500000');
    expect(paid.bonusMinor).toBe('1000000');
    expect((await wallet(user)).bonusMinor).toBe('1000000');
  });

  it('gives no bonus for a payment that pays for bids', async () => {
    const auctionId = await liveAuction();
    const user = await account();
    const res = await t
      .post('/wallet/deposits', { amountMinor: '7500', bid: { auctionId, amountsMinor: ['500'] } }, user.token)
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    expect(res.body.bonusMinor).toBe('0');
    chapa.pay(res.body.reference);
    await t.get(`/wallet/deposits/${res.body.id}`, user.token).expect(200);
    expect((await wallet(user)).bonusMinor).toBe('0');
    expect(await t.prisma.walletBonusGrant.count()).toBe(0);
  });

  it('spends the bonus before cash, then cash, on bid fees', async () => {
    const auctionId = await liveAuction();
    const user = await account();
    await topUp(user, '10000'); // ETB 100 cash + ETB 100 bonus

    const first = await bid(user, auctionId, ['500']).expect(201);
    expect(first.body).toMatchObject({
      paidWithBonusMinor: '7500',
      walletAvailableMinor: '10000',
      walletBonusMinor: '2500',
    });
    // ETB 75 again: 25 of bonus is left, the other 50 comes from cash.
    const second = await bid(user, auctionId, ['600']).expect(201);
    expect(second.body).toMatchObject({
      paidWithBonusMinor: '2500',
      walletAvailableMinor: '5000',
      walletBonusMinor: '0',
    });

    const history = (await t.get('/wallet/transactions', user.token).expect(200)).body.items;
    const fee = history.filter((i: { type: string }) => i.type === 'BID_FEE');
    expect(fee.map((i: { balance: string; amountMinor: string }) => [i.balance, i.amountMinor])).toEqual([
      ['CASH', '5000'],
      ['BONUS', '2500'],
      ['BONUS', '7500'],
    ]);
    await expectBooksToBalance();
  });

  it('counts the bonus as money the bidder has', async () => {
    const auctionId = await liveAuction();
    const user = await account();
    await topUp(user, '3000'); // ETB 30 + ETB 30: not enough for ETB 75

    const res = await bid(user, auctionId, ['500']);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'INSUFFICIENT_FUNDS',
      details: { requiredMinor: '7500', availableMinor: '6000' },
    });
    expect((await wallet(user)).spendableMinor).toBe('6000');
  });

  it('gives refunded fees back to the bonus and the cash they came from', async () => {
    const auctionId = await liveAuction();
    const user = await account();
    await topUp(user, '5000'); // ETB 50 + ETB 50
    await bid(user, auctionId, ['500']).expect(201); // 50 bonus + 25 cash
    expect(await wallet(user)).toMatchObject({ availableMinor: '2500', bonusMinor: '0' });

    await t.post(`/admin/auctions/${auctionId}/cancel`, { reason: 'Supplier fell through' }, admin.token).expect(200);

    expect(await wallet(user)).toMatchObject({ availableMinor: '5000', bonusMinor: '5000' });
    await expectBooksToBalance();
  });

  it('takes back what is left of a bonus when it expires, and nothing that was spent', async () => {
    const auctionId = await liveAuction();
    const user = await account();
    const other = await account();
    await topUp(user, '10000');
    await topUp(other, '5000');
    await bid(user, auctionId, ['500']).expect(201); // user: 25 of 100 bonus left
    await bid(other, auctionId, ['500']).expect(201); // other: all 50 bonus spent
    await t.prisma.walletBonusGrant.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await wallet(user)).bonusMinor).toBe('0'); // expired bonus is not spendable, even before the sweep
    expect(await wallets.expireBonuses()).toBe(1);
    expect(await wallets.expireBonuses()).toBe(0);

    const expiries = await t.prisma.walletTransaction.findMany({ where: { type: WalletTransactionType.BONUS_EXPIRY } });
    expect(expiries.map((e) => e.amountMinor)).toEqual([2500n]);
    const bonusAccounts = await t.prisma.ledgerAccount.findMany({ where: { type: 'USER_WALLET_BONUS' } });
    expect(bonusAccounts.every((a) => a.balanceMinor === 0n)).toBe(true);
    expect((await wallet(user)).availableMinor).toBe('10000');
    await expectBooksToBalance();
  });

  it('sends a refund of expired bonus back to the platform, not to the wallet', async () => {
    const auctionId = await liveAuction();
    const user = await account();
    await topUp(user, '5000');
    await bid(user, auctionId, ['500']).expect(201);
    await t.prisma.walletBonusGrant.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await wallets.expireBonuses();

    await t.post(`/admin/auctions/${auctionId}/cancel`, { reason: 'Supplier fell through' }, admin.token).expect(200);

    expect(await wallet(user)).toMatchObject({ availableMinor: '5000', bonusMinor: '0' });
    await expectBooksToBalance();
  });

  it('cannot be spent from a frozen wallet', async () => {
    const auctionId = await liveAuction();
    const user = await account();
    await topUp(user, '10000');
    await t.prisma.wallet.updateMany({ where: { userId: user.id }, data: { isFrozen: true } });
    const res = await bid(user, auctionId, ['500']);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('WALLET_FROZEN');
  });
});

describe('Top-up bonus switched off', () => {
  const chapa = new FakeChapa();
  let t: TestApp;

  beforeAll(async () => {
    await chapa.start();
    t = await createTestApp({
      PHONE_VERIFICATION_REQUIRED: 'false',
      OTP_PROVIDER: 'none',
      PAYMENT_PROVIDER: 'chapa',
      CHAPA_SECRET_KEY: 'CHASECK_TEST-e2e-not-a-real-key',
      CHAPA_BASE_URL: chapa.baseUrl,
      WEB_APP_URL: 'http://localhost:5173',
      TOPUP_BONUS_PERCENT: '0',
    });
  });
  afterAll(async () => {
    await t.close();
    await chapa.stop();
  });

  it('promises and gives nothing', async () => {
    await t.reset();
    const res = await t.post('/auth/register', { phoneNumber: '+251959999999', password: PASSWORD }).expect(201);
    const token = res.body.tokens.accessToken;
    expect((await t.get('/wallet/deposit-options', token).expect(200)).body.bonusPercent).toBe(0);
    const deposit = await t
      .post('/wallet/deposits', { amountMinor: '50000' }, token)
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    expect(deposit.body.bonusMinor).toBe('0');
    chapa.pay(deposit.body.reference);
    await t.get(`/wallet/deposits/${deposit.body.id}`, token).expect(200);
    expect((await t.get('/wallet', token).expect(200)).body).toMatchObject({
      availableMinor: '50000',
      bonusMinor: '0',
    });
  });
});
