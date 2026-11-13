import { createTestApp, TestApp } from './helpers/test-app';

const PHONE = '+251911234567';
const PASSWORD = 'Str0ngPassw0rd';

describe('Authentication without phone verification (PHONE_VERIFICATION_REQUIRED=false)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const register = (phoneNumber = PHONE, password = PASSWORD) => t.post('/auth/register', { phoneNumber, password });

  it('registers with just a phone number and password, signs the user in and sends no SMS', async () => {
    const res = await register('0911234567').expect(201);

    expect(res.body).toMatchObject({
      phoneNumber: PHONE,
      verificationRequired: false,
      user: { id: res.body.userId, phoneNumber: PHONE, phoneVerified: false, roles: ['USER'], status: 'ACTIVE' },
      tokens: { tokenType: 'Bearer' },
    });
    expect(res.body.verificationToken).toBeUndefined();
    expect(res.body.otp).toBeUndefined();
    expect(t.sms.messages).toHaveLength(0);
    expect(await t.prisma.otpVerification.count()).toBe(0);

    await t.get('/auth/me', res.body.tokens.accessToken).expect(200);
    const refreshed = await t.post('/auth/refresh', { refreshToken: res.body.tokens.refreshToken }).expect(200);
    await t.get('/auth/me', refreshed.body.accessToken).expect(200);
  });

  it('lets the user sign in with the password afterwards', async () => {
    await register().expect(201);
    const res = await t.post('/auth/login', { phoneNumber: '911234567', password: PASSWORD }).expect(200);
    expect(res.body.user.phoneNumber).toBe(PHONE);
    await t.post('/auth/login', { phoneNumber: PHONE, password: 'Wr0ngPassword' }).expect(401);
  });

  it('does not let a second registration take over an existing number', async () => {
    await register().expect(201);

    const res = await register(PHONE, 'An0therPassword');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PHONE_ALREADY_REGISTERED');
    await t.post('/auth/login', { phoneNumber: PHONE, password: 'An0therPassword' }).expect(401);
    await t.post('/auth/login', { phoneNumber: PHONE, password: PASSWORD }).expect(200);
  });

  it('creates exactly one account when the same number registers concurrently', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => register()));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await t.prisma.user.count()).toBe(1);
  });

  it('still validates the phone number and password', async () => {
    expect((await register('+254712345678')).body.error).toBe('INVALID_PHONE_NUMBER');
    expect((await register(PHONE, 'short')).body.error).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['/auth/verify-phone', { phoneNumber: PHONE, code: '123456', verificationToken: 'a'.repeat(43) }],
    ['/auth/resend-verification', { phoneNumber: PHONE }],
    ['/auth/forgot-password', { phoneNumber: PHONE }],
    ['/auth/reset-password', { phoneNumber: PHONE, code: '123456', newPassword: 'Br4ndNewPassword' }],
  ])('turns off the SMS-based endpoint %s', async (path, body) => {
    await register().expect(201);

    const res = await t.post(path, body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('SMS_VERIFICATION_DISABLED');
    expect(t.sms.messages).toHaveLength(0);
    await t.post('/auth/login', { phoneNumber: PHONE, password: PASSWORD }).expect(200);
  });

  it('keeps password change working for signed-in users', async () => {
    const reg = await register().expect(201);
    await t
      .post(
        '/auth/change-password',
        { currentPassword: PASSWORD, newPassword: 'Br4ndNewPassword' },
        reg.body.tokens.accessToken,
      )
      .expect(200);
    await t.post('/auth/login', { phoneNumber: PHONE, password: 'Br4ndNewPassword' }).expect(200);
  });
});
