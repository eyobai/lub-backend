import { PaymentStatus, RoleName } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ReconciliationService } from '../src/modules/ledger/reconciliation.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { FakeChapa } from './helpers/fake-chapa';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd';
const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

interface Account {
  id: string;
  token: string;
}

/** Pay and bid: a Chapa payment for bids, which are placed from the wallet once the payment is confirmed. */
describe('Pay and bid through Chapa', () => {
  const chapa = new FakeChapa();
  let t: TestApp;
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
  });
  afterAll(async () => {
    await t.close();
    await chapa.stop();
  });
  beforeEach(async () => {
    await t.reset();
    chapa.reset();
    admin = await account(0n, RoleName.ADMIN);
  });

  async function account(balanceMinor = 0n, ...roles: RoleName[]): Promise<Account> {
    const phoneNumber = `+2519${String(40000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    for (const name of roles) {
      const role = await t.prisma.role.findUniqueOrThrow({ where: { name } });
      await t.prisma.userRole.create({ data: { userId: res.body.userId, roleId: role.id } });
    }
    if (balanceMinor > 0n) {
      await t.app.get(WalletService).deposit({ userId: res.body.userId, amountMinor: balanceMinor });
    }
    return { id: res.body.userId, token: res.body.tokens.accessToken };
  }

  /** Open for bidding: fee 7.50 (below the smallest ordinary deposit of 10.00), amounts 1.00 … 1000.00. */
  async function liveAuction(): Promise<string> {
    const product = await t.post('/admin/products', { name: 'Prize' }, admin.token);
    const body = {
      productId: product.body.id,
      title: 'Win a phone',
      bidFeeMinor: '750',
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

  const payAndBid = (user: Account, auctionId: string, amountsMinor: string[], amountMinor: string) =>
    t
      .post('/wallet/deposits', { amountMinor, bid: { auctionId, amountsMinor } }, user.token)
      .set('Idempotency-Key', randomUUID());
  const read = async (user: Account, id: string) =>
    (await t.get(`/wallet/deposits/${id}`, user.token).expect(200)).body;
  const balance = async (user: Account): Promise<string> =>
    (await t.get('/wallet', user.token).expect(200)).body.availableMinor;
  const myBids = (user: Account, auctionId: string) =>
    t.prisma.bid.findMany({ where: { userId: user.id, auctionId }, orderBy: { amountMinor: 'asc' } });
  const expectBooksToBalance = async () => {
    const report = await t.app.get(ReconciliationService).reconcile();
    expect(report.issues).toEqual([]);
  };

  it('opens a payment for exactly the fees, then places the bids once Chapa confirms it', async () => {
    const auctionId = await liveAuction();
    const user = await account();

    const res = await payAndBid(user, auctionId, ['500', '700'], '1500').expect(201);
    expect(res.body).toMatchObject({
      status: 'PENDING',
      amountMinor: '1500',
      bid: { auctionId, amountsMinor: ['500', '700'], amounts: ['5.00', '7.00'], state: 'WAITING', error: null },
    });
    expect(chapa.last().request).toMatchObject({ amount: '15.00', customization: { description: 'Bid fees' } });
    expect(await myBids(user, auctionId)).toEqual([]);

    chapa.pay(res.body.reference);
    const after = await read(user, res.body.id);

    expect(after.status).toBe(PaymentStatus.SUCCEEDED);
    expect(after.bid).toMatchObject({ state: 'PLACED', submissionId: expect.any(String), error: null });
    expect((await myBids(user, auctionId)).map((b) => b.amountMinor)).toEqual([500n, 700n]);
    // In through the payment, out through the fees.
    expect(await balance(user)).toBe('0');
    expect((await read(user, res.body.id)).bid.submissionId).toBe(after.bid.submissionId);
    expect(await t.prisma.bidSubmission.count()).toBe(1);
    await expectBooksToBalance();
  });

  it('places the bids when Chapa confirms through the background sweep', async () => {
    const auctionId = await liveAuction();
    const user = await account();
    const res = await payAndBid(user, auctionId, ['500'], '750').expect(201);

    chapa.pay(res.body.reference);
    await t.app.get(PaymentsService).sweep();

    expect((await myBids(user, auctionId)).map((b) => b.amountMinor)).toEqual([500n]);
    expect((await read(user, res.body.id)).bid.state).toBe('PLACED');
  });

  it('refuses before any payment opens when the amount is not what the bids cost', async () => {
    const auctionId = await liveAuction();
    const user = await account();

    const res = await payAndBid(user, auctionId, ['500', '700'], '750');

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('DEPOSIT_AMOUNT_INVALID');
    expect(res.body.details).toEqual({ expectedAmountMinor: '1500' });
    expect(chapa.initializeCalls).toBe(0);
  });

  it('refuses before any payment opens when the bids themselves would be refused', async () => {
    const auctionId = await liveAuction();
    const user = await account(750n);
    await t
      .post(`/auctions/${auctionId}/bids`, { amountsMinor: ['500'] }, user.token)
      .set('Idempotency-Key', randomUUID())
      .expect(201);

    const repeated = await payAndBid(user, auctionId, ['500'], '750');
    expect(repeated.status).toBe(409);
    expect(repeated.body.error).toBe('DUPLICATE_BID');

    const outOfRange = await payAndBid(user, auctionId, ['150'], '750');
    expect(outOfRange.status).toBe(422);
    expect(outOfRange.body.error).toBe('BID_AMOUNT_INVALID');
    expect(chapa.initializeCalls).toBe(0);
  });

  it('keeps the money in the wallet and says why when the bids are refused after payment', async () => {
    const auctionId = await liveAuction();
    const user = await account();
    const res = await payAndBid(user, auctionId, ['500'], '750').expect(201);
    // Bidding closed while the payer was at Chapa.
    await t.prisma.auction.update({ where: { id: auctionId }, data: { status: 'CLOSING' } });

    chapa.pay(res.body.reference);
    const after = await read(user, res.body.id);

    expect(after.status).toBe(PaymentStatus.SUCCEEDED);
    expect(after.bid).toMatchObject({ state: 'REFUSED', submissionId: null, error: expect.any(String) });
    expect(await myBids(user, auctionId)).toEqual([]);
    expect(await balance(user)).toBe('750');
    await expectBooksToBalance();
  });

  it('places nothing and takes nothing when the payment fails', async () => {
    const auctionId = await liveAuction();
    const user = await account();
    const res = await payAndBid(user, auctionId, ['500'], '750').expect(201);

    chapa.fail(res.body.reference);
    const after = await read(user, res.body.id);

    expect(after.status).toBe(PaymentStatus.FAILED);
    expect(after.bid.state).toBe('WAITING');
    expect(await myBids(user, auctionId)).toEqual([]);
    expect(await balance(user)).toBe('0');
  });

  it('answers a retry with the same payment, and refuses the key for different bids', async () => {
    const auctionId = await liveAuction();
    const user = await account();
    const key = randomUUID();
    const send = (amountsMinor: string[]) =>
      t
        .post('/wallet/deposits', { amountMinor: '750', bid: { auctionId, amountsMinor } }, user.token)
        .set('Idempotency-Key', key);

    const first = await send(['500']).expect(201);
    const again = await send(['500']).expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(again.headers['idempotent-replayed']).toBe('true');

    const other = await send(['600']);
    expect(other.status).toBe(422);
    expect(other.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(chapa.initializeCalls).toBe(1);
  });

  describe('without leaving the site (direct charge)', () => {
    const charge = (user: Account, auctionId: string, charge: object, amountsMinor = ['500']) =>
      t
        .post('/wallet/deposits', { amountMinor: '750', bid: { auctionId, amountsMinor }, charge }, user.token)
        .set('Idempotency-Key', randomUUID());

    it('sends the request to the phone instead of opening the checkout page, then places the bids', async () => {
      const auctionId = await liveAuction();
      const user = await account();

      const res = await charge(user, auctionId, { method: 'telebirr', phoneNumber: '+251 911-22-33-44' }).expect(201);

      expect(res.body).toMatchObject({ status: 'PENDING', checkoutUrl: null, chargeMethod: 'telebirr' });
      expect(chapa.chargeCalls).toBe(1);
      expect(chapa.initializeCalls).toBe(0);
      expect(chapa.chargeType).toBe('telebirr');
      expect(chapa.last().request).toMatchObject({
        amount: '7.50',
        currency: 'ETB',
        tx_ref: res.body.reference,
        mobile: '0911223344',
      });

      chapa.pay(res.body.reference);
      const after = await read(user, res.body.id);
      expect(after.status).toBe(PaymentStatus.SUCCEEDED);
      expect(after.bid.state).toBe('PLACED');
      expect((await myBids(user, auctionId)).map((b) => b.amountMinor)).toEqual([500n]);
      await expectBooksToBalance();
    });

    it("uses the account's own number when none is given", async () => {
      const auctionId = await liveAuction();
      const user = await account();
      await charge(user, auctionId, { method: 'mpesa' }).expect(201);
      const own = (await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).phoneNumber;
      expect(chapa.last().request.mobile).toBe(`0${own.slice(4)}`);
      expect(chapa.chargeType).toBe('mpesa');
    });

    it('refuses a wallet that is not offered, or a number that is not a mobile number, before asking Chapa', async () => {
      const auctionId = await liveAuction();
      const user = await account();
      const unknown = await charge(user, auctionId, { method: 'paypal' });
      expect(unknown.status).toBe(422);
      expect(unknown.body.details).toEqual({ directChargeMethods: ['telebirr', 'mpesa', 'cbebirr', 'ebirr'] });
      const badPhone = await charge(user, auctionId, { method: 'telebirr', phoneNumber: '0111234567' });
      expect(badPhone.status).toBe(422);
      expect(chapa.chargeCalls).toBe(0);
    });

    it('says so, and takes nothing, when Chapa will not send the request', async () => {
      const auctionId = await liveAuction();
      const user = await account();
      chapa.refuseInitialize = 'Invalid mobile number';

      const res = await charge(user, auctionId, { method: 'telebirr' });

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ error: 'PAYMENT_PROVIDER_ERROR', details: { directCharge: true } });
      expect(res.body.message).not.toContain('Invalid mobile number');
      const payment = await t.prisma.paymentTransaction.findFirstOrThrow({ where: { userId: user.id } });
      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect(payment.failureReason).toContain('Invalid mobile number');
    });

    it('gives up on a wallet that wants a one-time code typed in', async () => {
      const auctionId = await liveAuction();
      const user = await account();
      chapa.chargeAuthType = 'otp';
      const res = await charge(user, auctionId, { method: 'cbebirr' });
      expect(res.status).toBe(502);
      expect(res.body.details).toEqual({ directCharge: true });
    });
  });

  it('leaves an ordinary deposit as it was', async () => {
    const user = await account();
    const res = await t
      .post('/wallet/deposits', { amountMinor: '50000' }, user.token)
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    expect(res.body.bid).toBeNull();
    expect(chapa.last().request).toMatchObject({ customization: { description: 'Wallet deposit' } });
  });
});
