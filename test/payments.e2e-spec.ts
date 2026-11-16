import { PaymentStatus, RoleName, SecurityEventType, WalletTransactionType } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import { ReconciliationService } from '../src/modules/ledger/reconciliation.service';
import { MAX_OPEN_DEPOSITS, PaymentsService } from '../src/modules/payments/payments.service';
import { FakeChapa } from './helpers/fake-chapa';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd';
const SECRET_KEY = 'CHASECK_TEST-e2e-not-a-real-key';
const WEBHOOK_SECRET = 'e2e-webhook-secret-0001';
const WEB = 'http://localhost:5173';
const API = 'http://localhost:3000';

interface Account {
  id: string;
  token: string;
  phoneNumber: string;
}

const sign = (key: string, data: string) => createHmac('sha256', key).update(data).digest('hex');

describe('Deposits through Chapa', () => {
  const chapa = new FakeChapa();
  let t: TestApp;
  let payments: PaymentsService;
  let reconciliation: ReconciliationService;
  let phoneCounter = 0;

  beforeAll(async () => {
    await chapa.start();
    t = await createTestApp({
      PHONE_VERIFICATION_REQUIRED: 'false',
      OTP_PROVIDER: 'none',
      PAYMENT_PROVIDER: 'chapa',
      CHAPA_SECRET_KEY: SECRET_KEY,
      CHAPA_WEBHOOK_SECRET: WEBHOOK_SECRET,
      CHAPA_BASE_URL: chapa.baseUrl,
      WEB_APP_URL: WEB,
      PUBLIC_API_URL: API,
    });
    payments = t.app.get(PaymentsService);
    reconciliation = t.app.get(ReconciliationService);
  });
  afterAll(async () => {
    await t.close();
    await chapa.stop();
  });
  beforeEach(async () => {
    await t.reset();
    chapa.reset();
  });

  async function account(...roles: RoleName[]): Promise<Account> {
    const phoneNumber = `+2519${String(20000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    for (const name of roles) {
      const role = await t.prisma.role.findUniqueOrThrow({ where: { name } });
      await t.prisma.userRole.create({ data: { userId: res.body.userId, roleId: role.id } });
    }
    return { id: res.body.userId, token: res.body.tokens.accessToken, phoneNumber };
  }

  const start = (user: Account, amountMinor = '50000', key: string = randomUUID()) =>
    t.post('/wallet/deposits', { amountMinor }, user.token).set('Idempotency-Key', key);

  /** Opens a deposit and returns it as the API answered. */
  async function opened(user: Account, amountMinor = '50000') {
    const res = await start(user, amountMinor).expect(201);
    return res.body as { id: string; reference: string; status: PaymentStatus; checkoutUrl: string | null };
  }

  const read = async (user: Account, id: string) =>
    (await t.get(`/wallet/deposits/${id}`, user.token).expect(200)).body;

  const balance = async (user: Account): Promise<string> =>
    (await t.get('/wallet', user.token).expect(200)).body.availableMinor;

  const depositPostings = (user: Account) =>
    t.prisma.walletTransaction.count({
      where: {
        type: WalletTransactionType.DEPOSIT,
        entries: { some: { account: { wallet: { userId: user.id } } } },
      },
    });

  /** Lets the next read ask Chapa again without waiting out the spacing between checks. */
  const forgetLastCheck = () => t.prisma.paymentTransaction.updateMany({ data: { lastCheckedAt: null } });

  const webhookBody = (reference: string, event = 'charge.success', extra: Record<string, unknown> = {}) => ({
    event,
    first_name: null,
    last_name: null,
    email: null,
    mobile: null,
    currency: 'ETB',
    amount: '500.00',
    charge: '17.50',
    status: event === 'charge.success' ? 'success' : 'failed',
    mode: 'test',
    reference: `AP${reference.slice(4, 14)}`,
    type: 'API',
    tx_ref: reference,
    payment_method: 'test',
    ...extra,
  });

  const webhook = (body: object, headers?: Record<string, string>) =>
    t
      .post('/payments/chapa/webhook', body)
      .set(headers ?? { 'x-chapa-signature': sign(WEBHOOK_SECRET, JSON.stringify(body)) });

  async function expectBooksToBalance(): Promise<void> {
    const report = await reconciliation.reconcile();
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  }

  describe('GET /wallet/deposit-options', () => {
    it('requires authentication', async () => {
      await t.get('/wallet/deposit-options').expect(401);
    });

    it('reports the provider, test mode and the limits', async () => {
      const user = await account();
      const res = await t.get('/wallet/deposit-options', user.token).expect(200);
      expect(res.body).toEqual({
        enabled: true,
        provider: 'chapa',
        testMode: true,
        currency: 'ETB',
        minorUnits: 2,
        minAmountMinor: '1000',
        maxAmountMinor: '5000000',
        directChargeMethods: ['telebirr', 'mpesa', 'cbebirr', 'ebirr'],
        bonusPercent: 100,
        bonusMaxMinor: '1000000',
        bonusValidDays: 7,
      });
    });
  });

  describe('POST /wallet/deposits', () => {
    it('requires authentication and an Idempotency-Key', async () => {
      const user = await account();
      await t.post('/wallet/deposits', { amountMinor: '50000' }).expect(401);
      const res = await t.post('/wallet/deposits', { amountMinor: '50000' }, user.token);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(chapa.initializeCalls).toBe(0);
    });

    it('opens the payment at Chapa and answers with the checkout address, without adding money', async () => {
      const user = await account();
      await t.patch('/users/me', { fullName: 'Abebe Kebede Alemu' }, user.token);

      const res = await start(user, '12550').expect(201);

      expect(res.body).toMatchObject({
        status: 'PENDING',
        provider: 'chapa',
        amountMinor: '12550',
        amount: '125.50',
        currency: 'ETB',
        minorUnits: 2,
        failureReason: null,
        walletTransactionId: null,
        confirmedAt: null,
      });
      expect(res.body.reference).toMatch(/^LUB-[0-9A-HJKMNP-TV-Z]{20}$/);
      expect(res.body.checkoutUrl).toBe(`https://checkout.chapa.co/checkout/payment/${res.body.reference}`);

      const sent = chapa.last();
      expect(sent.authorization).toBe(`Bearer ${SECRET_KEY}`);
      expect(sent.request).toMatchObject({
        amount: '125.50',
        currency: 'ETB',
        tx_ref: res.body.reference,
        phone_number: `0${user.phoneNumber.slice(4)}`,
        return_url: `${WEB}/wallet/deposits/${res.body.id}`,
        callback_url: `${API}/api/v1/payments/chapa/callback`,
      });
      expect(await balance(user)).toBe('0');
      expect(await depositPostings(user)).toBe(0);
    });

    it.each([
      ['below the minimum', '999'],
      ['above the maximum', '5000001'],
    ])('refuses an amount %s', async (_name, amountMinor) => {
      const user = await account();
      const res = await start(user, amountMinor);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('DEPOSIT_AMOUNT_INVALID');
      expect(res.body.details).toMatchObject({ minAmountMinor: '1000', maxAmountMinor: '5000000' });
      expect(chapa.initializeCalls).toBe(0);
    });

    it.each([['0'], ['-100'], ['12.5'], ['abc'], [''], [500]])(
      'refuses the malformed amount %p',
      async (amountMinor) => {
        const user = await account();
        const res = await t.post('/wallet/deposits', { amountMinor }, user.token).set('Idempotency-Key', randomUUID());
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('VALIDATION_FAILED');
      },
    );

    it('accepts the limits themselves', async () => {
      const user = await account();
      await start(user, '1000').expect(201);
      await start(user, '5000000').expect(201);
    });

    it('answers a retry with the same key with the same deposit, opening one payment only', async () => {
      const user = await account();
      const key = randomUUID();
      const first = await start(user, '50000', key).expect(201);
      const again = await start(user, '50000', key).expect(201);

      expect(again.body.id).toBe(first.body.id);
      expect(again.body.checkoutUrl).toBe(first.body.checkoutUrl);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(chapa.initializeCalls).toBe(1);
      expect(await t.prisma.paymentTransaction.count()).toBe(1);
    });

    it('opens one payment when the same request arrives twice at once', async () => {
      const user = await account();
      const key = randomUUID();
      const [a, b] = await Promise.all([start(user, '50000', key), start(user, '50000', key)]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect(await t.prisma.paymentTransaction.count()).toBe(1);
      expect(chapa.initializeCalls).toBe(1);
    });

    it('refuses a key that was used for another amount', async () => {
      const user = await account();
      const key = randomUUID();
      await start(user, '50000', key).expect(201);
      const res = await start(user, '60000', key);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('lets two users use the same key', async () => {
      const [a, b] = [await account(), await account()];
      const key = randomUUID();
      const first = await start(a, '50000', key).expect(201);
      const second = await start(b, '50000', key).expect(201);
      expect(second.body.id).not.toBe(first.body.id);
    });

    it('refuses staff accounts', async () => {
      const staff = await account(RoleName.FINANCE);
      const res = await start(staff);
      expect(res.status).toBe(403);
      expect(chapa.initializeCalls).toBe(0);
    });

    it('refuses a frozen wallet', async () => {
      const user = await account();
      await balance(user);
      await t.prisma.wallet.updateMany({ where: { userId: user.id }, data: { isFrozen: true } });
      const res = await start(user);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('WALLET_FROZEN');
      expect(chapa.initializeCalls).toBe(0);
    });

    it(`allows ${MAX_OPEN_DEPOSITS} unpaid deposits at once and refuses the next`, async () => {
      const user = await account();
      for (let i = 0; i < MAX_OPEN_DEPOSITS; i++) await start(user).expect(201);
      const res = await start(user);
      expect(res.status).toBe(429);
      expect(res.body.error).toBe('DEPOSIT_LIMIT_REACHED');

      const first = [...chapa.transactions.keys()][0];
      chapa.pay(first);
      await webhook(webhookBody(first)).expect(200);
      await start(user).expect(201);
    });

    it('records a failed deposit and takes nothing when Chapa refuses to open the payment', async () => {
      const user = await account();
      chapa.refuseInitialize = 'Invalid currency';
      const key = randomUUID();

      const res = await start(user, '50000', key);
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('PAYMENT_PROVIDER_ERROR');
      expect(res.body.message).not.toContain('Invalid currency');

      const stored = await t.prisma.paymentTransaction.findFirstOrThrow();
      expect(stored.status).toBe(PaymentStatus.FAILED);
      expect(stored.failureReason).toContain('Invalid currency');
      expect(await balance(user)).toBe('0');

      // The same key answers with the failed deposit; a fresh key starts over.
      chapa.refuseInitialize = null;
      const retry = await start(user, '50000', key).expect(201);
      expect(retry.body.status).toBe('FAILED');
      expect(retry.body.checkoutUrl).toBeNull();
      await start(user).expect(201);
    });

    it('answers 502 when Chapa is down', async () => {
      const user = await account();
      chapa.down = true;
      const res = await start(user);
      expect(res.status).toBe(502);
      expect(await t.prisma.paymentTransaction.count({ where: { status: PaymentStatus.FAILED } })).toBe(1);
    });
  });

  describe('confirming a payment', () => {
    it('credits the wallet once Chapa confirms, when the payer returns to the site', async () => {
      const user = await account();
      const deposit = await opened(user, '12550');

      expect((await read(user, deposit.id)).status).toBe('PENDING');
      expect(await balance(user)).toBe('0');

      chapa.pay(deposit.reference);
      await forgetLastCheck();
      const after = await read(user, deposit.id);

      expect(after).toMatchObject({ status: 'SUCCEEDED', checkoutUrl: null, failureReason: null });
      expect(after.walletTransactionId).toEqual(expect.any(String));
      expect(after.confirmedAt).toEqual(expect.any(String));
      expect(await balance(user)).toBe('12550');

      const history = await t.get('/wallet/transactions', user.token).expect(200);
      // The deposit, and the top-up bonus it earned (newest first).
      expect(history.body.items).toHaveLength(2);
      expect(history.body.items[1]).toMatchObject({
        id: after.walletTransactionId,
        type: 'DEPOSIT',
        balance: 'CASH',
        amountMinor: '12550',
      });
      expect(history.body.items[0]).toMatchObject({ type: 'BONUS', balance: 'BONUS', amountMinor: '12550' });
      const notifications = await t.get('/notifications', user.token).expect(200);
      expect(notifications.body.total).toBe(1);
      await expectBooksToBalance();
    });

    it('does not ask Chapa again within a few seconds, and never credits twice', async () => {
      const user = await account();
      const deposit = await opened(user);
      await read(user, deposit.id);
      await read(user, deposit.id);
      await read(user, deposit.id);
      expect(chapa.verifyCalls).toBe(1);

      chapa.pay(deposit.reference);
      await forgetLastCheck();
      await Promise.all([read(user, deposit.id), read(user, deposit.id), read(user, deposit.id)]);
      await read(user, deposit.id);

      expect(await balance(user)).toBe('50000');
      expect(await depositPostings(user)).toBe(1);
      await expectBooksToBalance();
    });

    it('credits once when the webhook, the return page, the callback and the sweep all arrive together', async () => {
      const user = await account();
      const deposit = await opened(user);
      chapa.pay(deposit.reference);
      const body = webhookBody(deposit.reference);

      const results = await Promise.all([
        webhook(body),
        webhook(body),
        t.get(`/wallet/deposits/${deposit.id}`, user.token),
        t.get(`/payments/chapa/callback?trx_ref=${deposit.reference}&status=success`),
        payments.sweep(),
      ]);

      expect(results.slice(0, 4).map((r) => (r as { status: number }).status)).toEqual([200, 200, 200, 200]);
      expect(await balance(user)).toBe('50000');
      expect(await depositPostings(user)).toBe(1);
      expect((await read(user, deposit.id)).status).toBe('SUCCEEDED');
      expect(await t.prisma.paymentProviderEvent.count()).toBe(1);
      await expectBooksToBalance();
    });

    it.each([
      ['a smaller amount', { amount: 5 }, 'Paid amount 5 '],
      ['a larger amount', { amount: 5000 }, 'Paid amount 5000 '],
      ['another currency', { currency: 'USD' }, 'USD'],
      ['a live-mode payment under a test key', { mode: 'live' }, 'live'],
      ['another reference', { tx_ref: 'LUB-SOMEONEELSE000000000' }, 'another reference'],
    ])('does not credit when Chapa reports %s, and flags it for review', async (_name, change, reason) => {
      const user = await account();
      const deposit = await opened(user);
      chapa.pay(deposit.reference, change);

      const after = await read(user, deposit.id);

      expect(after.status).toBe('FAILED');
      expect(after.failureReason).toBe('The payment was not completed. No money was added.');
      expect(await balance(user)).toBe('0');
      const stored = await t.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: deposit.id } });
      expect(stored.reviewReason).toContain(reason);
      expect(stored.walletTransactionId).toBeNull();
      expect(
        await t.prisma.securityEvent.count({ where: { type: SecurityEventType.SUSPICIOUS_PAYMENT, userId: user.id } }),
      ).toBe(1);
    });

    it('does not let one Chapa payment confirm two deposits', async () => {
      const user = await account();
      const [first, second] = [await opened(user), await opened(user)];
      chapa.pay(first.reference, { reference: 'APSAME000001' });
      chapa.pay(second.reference, { reference: 'APSAME000001' });

      expect((await read(user, first.id)).status).toBe('SUCCEEDED');
      expect((await read(user, second.id)).status).toBe('FAILED');
      expect(await balance(user)).toBe('50000');
      const stored = await t.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: second.id } });
      expect(stored.reviewReason).toContain('APSAME000001');
    });

    it.each(['failed', 'cancelled', 'failed/cancelled'])('closes the deposit when Chapa reports %s', async (status) => {
      const user = await account();
      const deposit = await opened(user);
      chapa.fail(deposit.reference, status);

      const after = await read(user, deposit.id);
      expect(after).toMatchObject({ status: 'FAILED', checkoutUrl: null });
      expect(after.failureReason).toBe('The payment was not completed. No money was added.');
      expect(await balance(user)).toBe('0');
    });

    it('still credits a payment that Chapa confirms after the deposit was closed here', async () => {
      const user = await account();
      const deposit = await opened(user);
      chapa.fail(deposit.reference);
      expect((await read(user, deposit.id)).status).toBe('FAILED');

      chapa.pay(deposit.reference);
      await forgetLastCheck();
      // Reading a closed deposit does not ask Chapa again; the webhook does.
      expect((await read(user, deposit.id)).status).toBe('FAILED');
      await webhook(webhookBody(deposit.reference)).expect(200);

      expect((await read(user, deposit.id)).status).toBe('SUCCEEDED');
      expect(await balance(user)).toBe('50000');
      await expectBooksToBalance();
    });

    it('credits a wallet that was frozen after the deposit was opened', async () => {
      const user = await account();
      const deposit = await opened(user);
      await t.prisma.wallet.updateMany({ where: { userId: user.id }, data: { isFrozen: true } });
      chapa.pay(deposit.reference);
      expect((await read(user, deposit.id)).status).toBe('SUCCEEDED');
      expect(await balance(user)).toBe('50000');
    });

    it('leaves the deposit pending and still answers when Chapa is down', async () => {
      const user = await account();
      const deposit = await opened(user);
      chapa.pay(deposit.reference);
      chapa.down = true;
      expect((await read(user, deposit.id)).status).toBe('PENDING');
      expect(await balance(user)).toBe('0');

      chapa.down = false;
      expect((await read(user, deposit.id)).status).toBe('SUCCEEDED');
    });
  });

  describe('GET /wallet/deposits', () => {
    it('lists my deposits newest first, and nobody else’s', async () => {
      const [me, other] = [await account(), await account()];
      const first = await opened(me, '10000');
      const second = await opened(me, '20000');
      const theirs = await opened(other, '30000');

      const res = await t.get('/wallet/deposits?limit=10', me.token).expect(200);
      expect(res.body.total).toBe(2);
      expect(res.body.items.map((d: { id: string }) => d.id)).toEqual([second.id, first.id]);

      const hidden = await t.get(`/wallet/deposits/${theirs.id}`, me.token);
      expect(hidden.status).toBe(404);
      await t.get('/wallet/deposits/not-a-uuid', me.token).expect(400);
      await t.get('/wallet/deposits').expect(401);
    });
  });

  describe('POST /payments/chapa/webhook', () => {
    it('credits the wallet on a signed event, after checking with Chapa', async () => {
      const user = await account();
      const deposit = await opened(user);
      chapa.pay(deposit.reference);

      const res = await webhook(webhookBody(deposit.reference)).expect(200);

      expect(res.body).toEqual({ received: true });
      expect(await balance(user)).toBe('50000');
      const event = await t.prisma.paymentProviderEvent.findFirstOrThrow();
      expect(event).toMatchObject({ provider: 'chapa', paymentTransactionId: deposit.id, signatureValid: true });
      expect(event.processedAt).not.toBeNull();
      expect(event.payload).toMatchObject({ event: 'charge.success', tx_ref: deposit.reference });
      await expectBooksToBalance();
    });

    it('accepts the chapa-signature header as well', async () => {
      const user = await account();
      const deposit = await opened(user);
      chapa.pay(deposit.reference);
      await webhook(webhookBody(deposit.reference), {
        'chapa-signature': sign(WEBHOOK_SECRET, WEBHOOK_SECRET),
      }).expect(200);
      expect(await balance(user)).toBe('50000');
    });

    it('handles a repeated event once', async () => {
      const user = await account();
      const deposit = await opened(user);
      chapa.pay(deposit.reference);
      const body = webhookBody(deposit.reference);

      await webhook(body).expect(200);
      const verifications = chapa.verifyCalls;
      await webhook(body).expect(200);
      await webhook(body).expect(200);

      expect(chapa.verifyCalls).toBe(verifications);
      expect(await t.prisma.paymentProviderEvent.count()).toBe(1);
      expect(await balance(user)).toBe('50000');
      expect(await depositPostings(user)).toBe(1);
    });

    it.each([
      ['no signature', () => ({})],
      ['a signature made with another secret', (raw: string) => ({ 'x-chapa-signature': sign('wrong-secret', raw) })],
      ['a signature of another body', (raw: string) => ({ 'x-chapa-signature': sign(WEBHOOK_SECRET, `${raw} `) })],
      ['the secret itself as the signature', () => ({ 'chapa-signature': WEBHOOK_SECRET })],
    ])('refuses %s and stores nothing', async (_name, headers) => {
      const user = await account();
      const deposit = await opened(user);
      chapa.pay(deposit.reference);
      const body = webhookBody(deposit.reference);

      const res = await t.post('/payments/chapa/webhook', body).set(headers(JSON.stringify(body)));

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('WEBHOOK_SIGNATURE_INVALID');
      expect(await t.prisma.paymentProviderEvent.count()).toBe(0);
      expect(chapa.verifyCalls).toBe(0);
      expect(await balance(user)).toBe('0');
    });

    it('does not credit on a signed event that Chapa itself does not confirm', async () => {
      const user = await account();
      const deposit = await opened(user);

      await webhook(webhookBody(deposit.reference, 'charge.success', { amount: '999999.00' })).expect(200);

      expect(await balance(user)).toBe('0');
      expect((await read(user, deposit.id)).status).toBe('PENDING');
    });

    it('answers 503 while Chapa cannot be asked, and finishes the job when the event is sent again', async () => {
      const user = await account();
      const deposit = await opened(user);
      chapa.pay(deposit.reference);
      const body = webhookBody(deposit.reference);

      chapa.down = true;
      const res = await webhook(body);
      expect(res.status).toBe(503);
      const waiting = await t.prisma.paymentProviderEvent.findFirstOrThrow();
      expect(waiting.processedAt).toBeNull();
      expect(waiting.processingError).toEqual(expect.any(String));
      expect(await balance(user)).toBe('0');

      chapa.down = false;
      await webhook(body).expect(200);
      expect(await balance(user)).toBe('50000');
      expect((await t.prisma.paymentProviderEvent.findFirstOrThrow()).processedAt).not.toBeNull();
    });

    it('accepts and keeps an event about a payment it does not know', async () => {
      await webhook(webhookBody('LUB-UNKNOWN0000000000000')).expect(200);
      const event = await t.prisma.paymentProviderEvent.findFirstOrThrow();
      expect(event.paymentTransactionId).toBeNull();
      expect(event.processingError).toBe('No deposit has this tx_ref');
    });

    it('closes the deposit on a failure event that Chapa confirms', async () => {
      const user = await account();
      const deposit = await opened(user);
      chapa.fail(deposit.reference);
      await webhook(webhookBody(deposit.reference, 'charge.failed/cancelled')).expect(200);
      expect((await read(user, deposit.id)).status).toBe('FAILED');
    });

    it.each(['charge.refunded', 'charge.reversed'])(
      'flags a credited deposit for review on %s, without touching the wallet',
      async (event) => {
        const user = await account();
        const deposit = await opened(user);
        chapa.pay(deposit.reference);
        await webhook(webhookBody(deposit.reference)).expect(200);

        await webhook(webhookBody(deposit.reference, event)).expect(200);

        const stored = await t.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: deposit.id } });
        expect(stored.status).toBe(PaymentStatus.SUCCEEDED);
        expect(stored.reviewReason).toBe(`Chapa reported ${event}`);
        expect(await balance(user)).toBe('50000');
        expect(await depositPostings(user)).toBe(1);
        expect(await t.prisma.paymentProviderEvent.count()).toBe(2);
        await expectBooksToBalance();
      },
    );

    it('refuses a body that is not an object', async () => {
      const raw = JSON.stringify(['charge.success']);
      const res = await t
        .post('/payments/chapa/webhook', ['charge.success'])
        .set('x-chapa-signature', sign(WEBHOOK_SECRET, raw));
      expect(res.status).toBe(400);
    });
  });

  describe('GET /payments/chapa/callback', () => {
    it('checks the named payment with Chapa and ignores the status it is told', async () => {
      const user = await account();
      const deposit = await opened(user);

      await t.get(`/payments/chapa/callback?trx_ref=${deposit.reference}&ref_id=AP1&status=success`).expect(200);
      expect(await balance(user)).toBe('0');

      chapa.pay(deposit.reference);
      await forgetLastCheck();
      await t.get(`/payments/chapa/callback?trx_ref=${deposit.reference}&ref_id=AP1&status=failed`).expect(200);
      expect(await balance(user)).toBe('50000');
    });

    it('answers the same for a reference it does not know, or none at all', async () => {
      const known = await t.get('/payments/chapa/callback?trx_ref=LUB-UNKNOWN0000000000000').expect(200);
      const none = await t.get('/payments/chapa/callback').expect(200);
      const odd = await t.get("/payments/chapa/callback?trx_ref=' OR 1=1 --").expect(200);
      expect(known.body).toEqual({ received: true });
      expect(none.body).toEqual(known.body);
      expect(odd.body).toEqual(known.body);
      expect(chapa.verifyCalls).toBe(0);
    });
  });

  describe('background sweep', () => {
    it('credits a paid deposit whose webhook never came and whose payer never returned', async () => {
      const user = await account();
      const deposit = await opened(user);
      chapa.pay(deposit.reference);

      const result = await payments.sweep();

      expect(result).toEqual({ checked: 1, succeeded: 1, closed: 0 });
      expect(await balance(user)).toBe('50000');
      expect((await read(user, deposit.id)).status).toBe('SUCCEEDED');
      expect(await payments.sweep()).toEqual({ checked: 0, succeeded: 0, closed: 0 });
      await expectBooksToBalance();
    });

    it('gives up on a deposit that is still unpaid after the expiry time', async () => {
      const user = await account();
      const fresh = await opened(user);
      const old = await opened(user);
      await t.prisma.paymentTransaction.update({
        where: { id: old.id },
        data: { createdAt: new Date(Date.now() - 121 * 60_000) },
      });

      const result = await payments.sweep();

      expect(result).toEqual({ checked: 2, succeeded: 0, closed: 1 });
      const expired = await read(user, old.id);
      expect(expired).toMatchObject({ status: 'EXPIRED', checkoutUrl: null });
      expect(expired.failureReason).toBe('The payment was not completed in time. No money was added.');
      expect((await read(user, fresh.id)).status).toBe('PENDING');
    });

    it('credits a payment that turns out paid at the expiry check', async () => {
      const user = await account();
      const deposit = await opened(user);
      await t.prisma.paymentTransaction.update({
        where: { id: deposit.id },
        data: { createdAt: new Date(Date.now() - 500 * 60_000) },
      });
      chapa.pay(deposit.reference);
      await payments.sweep();
      expect(await balance(user)).toBe('50000');
    });

    it('spaces out checks of the same deposit', async () => {
      const user = await account();
      await opened(user);
      await payments.sweep();
      await payments.sweep();
      expect(chapa.verifyCalls).toBe(1);
      const later = new Date(Date.now() + 31_000);
      await payments.sweep(later);
      expect(chapa.verifyCalls).toBe(2);
    });

    it('stops quietly when Chapa is down and picks up afterwards', async () => {
      const user = await account();
      const deposit = await opened(user);
      await opened(user);
      chapa.pay(deposit.reference);
      chapa.down = true;

      await expect(payments.sweep()).resolves.toEqual({ checked: 0, succeeded: 0, closed: 0 });
      expect(await t.prisma.paymentTransaction.count({ where: { status: PaymentStatus.PENDING } })).toBe(2);

      chapa.down = false;
      expect(await payments.sweep()).toEqual({ checked: 2, succeeded: 1, closed: 0 });
    });

    it('closes a deposit that was recorded but never opened at Chapa', async () => {
      const user = await account();
      const deposit = await opened(user);
      await t.prisma.paymentTransaction.update({
        where: { id: deposit.id },
        data: { status: PaymentStatus.INITIATED, checkoutUrl: null, createdAt: new Date(Date.now() - 11 * 60_000) },
      });
      expect(await payments.sweep()).toEqual({ checked: 0, succeeded: 0, closed: 1 });
      expect((await read(user, deposit.id)).status).toBe('FAILED');
    });
  });

  describe('back office', () => {
    it('lets SUPPORT, FINANCE and ADMIN read deposits, and nobody else', async () => {
      const user = await account();
      const deposit = await opened(user);
      for (const role of [RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN, RoleName.SUPER_ADMIN]) {
        const staff = await account(role);
        const list = await t.get('/admin/deposits', staff.token).expect(200);
        expect(list.body.total).toBe(1);
        const one = await t.get(`/admin/deposits/${deposit.id}`, staff.token).expect(200);
        expect(one.body).toMatchObject({ id: deposit.id, userId: user.id, phoneNumber: user.phoneNumber });
      }
      await t.get('/admin/deposits', user.token).expect(403);
      await t.get(`/admin/deposits/${deposit.id}`, user.token).expect(403);
      await t.get('/admin/deposits').expect(401);
    });

    it('filters by status, user, reference and review flag', async () => {
      const finance = await account(RoleName.FINANCE);
      const [a, b] = [await account(), await account()];
      const paid = await opened(a);
      const waiting = await opened(a);
      const wrong = await opened(b);
      chapa.pay(paid.reference);
      chapa.pay(wrong.reference, { amount: 1 });
      await payments.sweep();

      const ids = async (query: string) =>
        ((await t.get(`/admin/deposits?${query}`, finance.token).expect(200)).body.items as { id: string }[])
          .map((d) => d.id)
          .sort();

      expect(await ids('status=SUCCEEDED')).toEqual([paid.id]);
      expect(await ids('status=PENDING')).toEqual([waiting.id]);
      expect(await ids(`userId=${a.id}`)).toEqual([paid.id, waiting.id].sort());
      expect(await ids('needsReview=true')).toEqual([wrong.id]);
      expect(await ids('needsReview=false')).toEqual([paid.id, waiting.id].sort());
      expect(await ids(`reference=${waiting.reference}`)).toEqual([waiting.id]);
      expect(await ids(`reference=AP${paid.reference.slice(4, 14)}`)).toEqual([paid.id]);
      await t.get('/admin/deposits?status=NOPE', finance.token).expect(400);

      const detail = await t.get(`/admin/deposits/${wrong.id}`, finance.token).expect(200);
      expect(detail.body.reviewReason).toContain('is not the amount requested');
      expect(detail.body.failureReason).toBe('The payment did not match what was requested');
    });

    it('lets FINANCE re-check a deposit with Chapa, which credits a paid one', async () => {
      const finance = await account(RoleName.FINANCE);
      const user = await account();
      const deposit = await opened(user);
      await read(user, deposit.id);
      chapa.pay(deposit.reference);

      const res = await t.post(`/admin/deposits/${deposit.id}/recheck`, {}, finance.token).expect(200);

      expect(res.body.status).toBe('SUCCEEDED');
      expect(res.body.providerReference).toBe(`AP${deposit.reference.slice(4, 14)}`);
      expect(await balance(user)).toBe('50000');
      const again = await t.post(`/admin/deposits/${deposit.id}/recheck`, {}, finance.token).expect(200);
      expect(again.body.status).toBe('SUCCEEDED');
      expect(await depositPostings(user)).toBe(1);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'payment.deposit.recheck' } });
      expect(audit.actorId).toBe(finance.id);
    });

    it('re-checking cannot credit a deposit Chapa does not confirm', async () => {
      const finance = await account(RoleName.FINANCE);
      const user = await account();
      const deposit = await opened(user);
      const res = await t.post(`/admin/deposits/${deposit.id}/recheck`, {}, finance.token).expect(200);
      expect(res.body.status).toBe('PENDING');
      expect(await balance(user)).toBe('0');
    });

    it('answers 502 to a re-check while Chapa is down', async () => {
      const finance = await account(RoleName.FINANCE);
      const deposit = await opened(await account());
      chapa.down = true;
      const res = await t.post(`/admin/deposits/${deposit.id}/recheck`, {}, finance.token);
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('PAYMENT_PROVIDER_ERROR');
    });

    it('limits re-checking and closing a review to FINANCE and SUPER_ADMIN', async () => {
      const deposit = await opened(await account());
      for (const role of [RoleName.SUPPORT, RoleName.ADMIN]) {
        const staff = await account(role);
        await t.post(`/admin/deposits/${deposit.id}/recheck`, {}, staff.token).expect(403);
        await t.post(`/admin/deposits/${deposit.id}/resolve-review`, { note: 'Looked at it' }, staff.token).expect(403);
      }
      const root = await account(RoleName.SUPER_ADMIN);
      await t.post(`/admin/deposits/${deposit.id}/recheck`, {}, root.token).expect(200);
      await t.post(`/admin/deposits/${randomUUID()}/recheck`, {}, root.token).expect(404);
    });

    it('lets FINANCE close a review with a note, once', async () => {
      const finance = await account(RoleName.FINANCE);
      const user = await account();
      const deposit = await opened(user);
      chapa.pay(deposit.reference);
      await webhook(webhookBody(deposit.reference)).expect(200);
      await webhook(webhookBody(deposit.reference, 'charge.refunded')).expect(200);

      await t.post(`/admin/deposits/${deposit.id}/resolve-review`, { note: 'ok' }, finance.token).expect(400);
      const note = 'Refund confirmed with Chapa; wallet debited by adjustment';
      const res = await t.post(`/admin/deposits/${deposit.id}/resolve-review`, { note }, finance.token).expect(200);

      expect(res.body).toMatchObject({ id: deposit.id, status: 'SUCCEEDED', reviewReason: null });
      expect(await balance(user)).toBe('50000');
      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'payment.deposit.review-resolved' },
      });
      expect(audit.actorId).toBe(finance.id);
      expect(audit.metadata).toMatchObject({ note });

      const again = await t.post(`/admin/deposits/${deposit.id}/resolve-review`, { note }, finance.token);
      expect(again.status).toBe(409);
    });
  });
});

describe('Deposits with no payment provider configured', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' });
    await t.reset();
  });
  afterAll(async () => {
    await t.close();
  });

  it('says so, refuses to start a deposit, and has no webhook', async () => {
    const res = await t.post('/auth/register', { phoneNumber: '+251930000001', password: PASSWORD }).expect(201);
    const token: string = res.body.tokens.accessToken;

    const options = await t.get('/wallet/deposit-options', token).expect(200);
    expect(options.body).toMatchObject({ enabled: false, provider: null, testMode: false });

    const start = await t
      .post('/wallet/deposits', { amountMinor: '50000' }, token)
      .set('Idempotency-Key', randomUUID());
    expect(start.status).toBe(503);
    expect(start.body.error).toBe('PAYMENTS_UNAVAILABLE');

    await t.get('/wallet/deposits', token).expect(200);
    await t.post('/payments/chapa/webhook', { event: 'charge.success' }).expect(404);
    await t.get('/payments/chapa/callback?trx_ref=LUB-X').expect(200);
  });
});
