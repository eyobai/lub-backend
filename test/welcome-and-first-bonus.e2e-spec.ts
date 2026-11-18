import { randomUUID } from 'node:crypto';
import { FakeChapa } from './helpers/fake-chapa';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd';

/** ETB 10 for every new account, and the top-up bonus on the first top-up only. */
describe('Welcome bonus and first top-up bonus', () => {
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
      CHAPA_WEBHOOK_SECRET: 'e2e-webhook-secret-0001',
      CHAPA_BASE_URL: chapa.baseUrl,
      WEB_APP_URL: 'http://localhost:5173',
      WELCOME_BONUS_MINOR: '1000',
      WELCOME_BONUS_VALID_DAYS: '30',
      TOPUP_BONUS_FIRST_ONLY: 'true',
    });
  });
  afterAll(async () => {
    await t.close();
    await chapa.stop();
  });
  beforeEach(async () => {
    await t.reset();
    chapa.reset();
  });

  async function register() {
    const phoneNumber = `+2519${String(70000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    return { body: res.body, token: res.body.tokens.accessToken as string, phoneNumber };
  }
  async function topUp(token: string, amountMinor: string) {
    const res = await t
      .post('/wallet/deposits', { amountMinor }, token)
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    return res.body as { id: string; reference: string; bonusMinor: string };
  }

  it('gives a new account ETB 10 to bid with, once, and says so', async () => {
    const { body, token, phoneNumber } = await register();
    expect(body.welcomeBonusMinor).toBe('1000');
    const wallet = (await t.get('/wallet', token).expect(200)).body;
    expect(wallet).toMatchObject({ availableMinor: '0', bonusMinor: '1000', spendableMinor: '1000' });
    const expires = Date.parse(wallet.bonusExpiresAt);
    expect(expires).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const history = (await t.get('/wallet/transactions', token).expect(200)).body.items;
    expect(history[0]).toMatchObject({ type: 'BONUS', description: 'Welcome bonus', amountMinor: '1000' });

    const login = await t.post('/auth/login', { phoneNumber, password: PASSWORD }).expect(200);
    expect(login.body.welcomeBonusMinor).toBeUndefined();
    const recon = await t.prisma.walletBonusGrant.count();
    expect(recon).toBe(1);
  });

  it('promises and gives the top-up bonus on the first top-up only', async () => {
    const { token } = await register();
    expect((await t.get('/wallet', token).expect(200)).body.topUpBonusAvailable).toBe(true);

    const first = await topUp(token, '50000');
    expect(first.bonusMinor).toBe('50000');
    chapa.pay(first.reference);
    await t.get(`/wallet/deposits/${first.id}`, token).expect(200);
    expect((await t.get('/wallet', token).expect(200)).body).toMatchObject({
      availableMinor: '50000',
      bonusMinor: '51000',
      topUpBonusAvailable: false,
    });

    const second = await topUp(token, '20000');
    expect(second.bonusMinor).toBe('0');
    chapa.pay(second.reference);
    await t.get(`/wallet/deposits/${second.id}`, token).expect(200);
    expect((await t.get('/wallet', token).expect(200)).body).toMatchObject({
      availableMinor: '70000',
      bonusMinor: '51000',
    });
  });

  it('keeps the bonus only for the first of two first top-ups paid at the same time', async () => {
    const { token } = await register();
    const a = await topUp(token, '10000');
    const b = await topUp(token, '20000');
    expect([a.bonusMinor, b.bonusMinor]).toEqual(['10000', '20000']);
    chapa.pay(a.reference);
    chapa.pay(b.reference);
    await t.get(`/wallet/deposits/${a.id}`, token).expect(200);
    const late = (await t.get(`/wallet/deposits/${b.id}`, token).expect(200)).body;
    expect(late).toMatchObject({ status: 'SUCCEEDED', bonusMinor: '0' });
    expect((await t.get('/wallet', token).expect(200)).body).toMatchObject({
      availableMinor: '30000',
      bonusMinor: '11000',
    });
  });
});
