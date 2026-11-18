import { randomUUID } from 'node:crypto';
import { FakeChapa } from './helpers/fake-chapa';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd';
const PUBLIC_KEY = 'CHAPUBK_TEST-e2epublickey';

/** Phone payments sent from the browser through Chapa's inline service; the server only confirms them. */
describe('Inline phone payments', () => {
  const chapa = new FakeChapa();
  let t: TestApp;
  let phoneCounter = 0;

  beforeAll(async () => {
    await chapa.start();
    t = await createTestApp({
      PHONE_VERIFICATION_REQUIRED: 'false',
      OTP_PROVIDER: 'none',
      PAYMENT_PROVIDER: 'chapa',
      CHAPA_SECRET_KEY: 'CHASECK_TEST-e2e-not-a-real-key',
      CHAPA_PUBLIC_KEY: PUBLIC_KEY,
      CHAPA_WEBHOOK_SECRET: 'e2e-webhook-secret-0001',
      CHAPA_BASE_URL: chapa.baseUrl,
      WEB_APP_URL: 'http://localhost:5173',
    });
  });
  afterAll(async () => {
    await t.close();
    await chapa.stop();
    delete process.env.CHAPA_PUBLIC_KEY;
  });
  beforeEach(async () => {
    await t.reset();
    chapa.reset();
  });

  async function account(): Promise<string> {
    const phoneNumber = `+2519${String(60000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    return res.body.tokens.accessToken as string;
  }
  const start = (token: string) =>
    t
      .post(
        '/wallet/deposits',
        { amountMinor: '10000', charge: { method: 'telebirr', phoneNumber: '0911223344' } },
        token,
      )
      .set('Idempotency-Key', randomUUID());

  it('hands the browser the public key, and does not send the phone request itself', async () => {
    expect((await t.get('/wallet/deposit-options').expect(200)).body.inlinePublicKey).toBe(PUBLIC_KEY);
    const token = await account();
    const res = await start(token).expect(201);
    expect(res.body).toMatchObject({ status: 'PENDING', checkoutUrl: null, chargeMethod: 'telebirr' });
    expect(chapa.chargeCalls).toBe(0);
    expect(chapa.initializeCalls).toBe(0);
  });

  it('credits the wallet once Chapa confirms the payment the browser started', async () => {
    const token = await account();
    const deposit = (await start(token).expect(201)).body;
    chapa.inlineCharge(deposit.reference, { amount: '100', currency: 'ETB', mobile: '0911223344' });
    chapa.pay(deposit.reference);

    const done = await t.get(`/wallet/deposits/${deposit.id}`, token).expect(200);
    expect(done.body.status).toBe('SUCCEEDED');
    expect((await t.get('/wallet', token).expect(200)).body.availableMinor).toBe('10000');
  });

  it('does not credit a payment of another amount than the deposit', async () => {
    const token = await account();
    const deposit = (await start(token).expect(201)).body;
    // The amount sent from a browser can be changed by the payer; Chapa's answer is what counts.
    chapa.inlineCharge(deposit.reference, { amount: '1', currency: 'ETB', mobile: '0911223344' });
    chapa.pay(deposit.reference);

    const res = await t.get(`/wallet/deposits/${deposit.id}`, token).expect(200);
    expect(res.body.status).not.toBe('SUCCEEDED');
    expect((await t.get('/wallet', token).expect(200)).body.availableMinor).toBe('0');
  });

  it('closes a deposit whose phone request the browser could not send', async () => {
    const token = await account();
    const deposit = (await start(token).expect(201)).body;
    const res = await t
      .post(
        `/wallet/deposits/${deposit.id}/charge-not-sent`,
        { reason: 'Transaction initiation failed: not allowed' },
        token,
      )
      .expect(200);
    expect(res.body).toMatchObject({ status: 'FAILED', requestNotSent: true });
    const other = await account();
    await t.post(`/wallet/deposits/${deposit.id}/charge-not-sent`, {}, other).expect(404);
  });

  it('still credits a payment Chapa knows, even when the browser reported a failure', async () => {
    const token = await account();
    const deposit = (await start(token).expect(201)).body;
    chapa.inlineCharge(deposit.reference, { amount: '100', currency: 'ETB', mobile: '0911223344' });
    chapa.pay(deposit.reference);
    const res = await t.post(`/wallet/deposits/${deposit.id}/charge-not-sent`, {}, token).expect(200);
    expect(res.body.status).toBe('SUCCEEDED');
  });
});
