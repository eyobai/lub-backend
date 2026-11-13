import { PasswordService } from '../src/modules/auth/password.service';
import { createTestApp, TestApp } from './helpers/test-app';

const PHONE = '+251911234567';
const PASSWORD = 'Str0ngPassw0rd';

describe('OTP request limits (integration)', () => {
  let limited: TestApp;

  beforeAll(async () => {
    limited = await createTestApp({ OTP_RESEND_COOLDOWN_SECONDS: '60', OTP_MAX_PER_HOUR: '2' });
  });
  afterAll(async () => {
    await limited.close();
  });
  beforeEach(async () => {
    await limited.reset();
  });

  it('enforces the resend cooldown and does not let a rate-limited request replace a pending registration', async () => {
    await limited.post('/auth/register', { phoneNumber: PHONE, password: 'F1rstPassword' }).expect(201);

    const res = await limited.post('/auth/register', { phoneNumber: PHONE, password: 'Sec0ndPassword' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('OTP_COOLDOWN');
    expect(res.body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.sms.count(PHONE)).toBe(1);

    const user = await limited.prisma.user.findUniqueOrThrow({ where: { phoneNumber: PHONE } });
    expect(await limited.app.get(PasswordService).verify(user.passwordHash, 'F1rstPassword')).toBe(true);
  });

  it('enforces the hourly cap per phone number', async () => {
    await limited.post('/auth/register', { phoneNumber: PHONE, password: PASSWORD }).expect(201);
    // Move earlier codes outside the cooldown window but keep them inside the last hour.
    const age = () =>
      limited.prisma.otpVerification.updateMany({ data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    await age();
    await limited.post('/auth/register', { phoneNumber: PHONE, password: PASSWORD }).expect(201);
    await age();

    const res = await limited.post('/auth/register', { phoneNumber: PHONE, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('OTP_LIMIT_REACHED');
    expect(limited.sms.count(PHONE)).toBe(2);
  });
});
