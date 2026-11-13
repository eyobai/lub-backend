import { JwtService } from '@nestjs/jwt';
import { AccountStatus, OtpPurpose, SecurityEventType } from '@prisma/client';
import { createTestApp, TestApp } from './helpers/test-app';

const PHONE = '+251911234567';
const PASSWORD = 'Str0ngPassw0rd';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

describe('Authentication (integration: real PostgreSQL + Redis)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const register = (phoneNumber = PHONE, password = PASSWORD, extra: object = {}) =>
    t.post('/auth/register', { phoneNumber, password, ...extra });

  /** Registers and verifies a user, returning the session created by phone verification. */
  async function signUp(phoneNumber = PHONE, password = PASSWORD): Promise<Tokens & { userId: string }> {
    const reg = await register(phoneNumber, password).expect(201);
    const res = await t
      .post('/auth/verify-phone', {
        phoneNumber,
        code: t.sms.lastCode(phoneNumber, OtpPurpose.PHONE_VERIFICATION),
        verificationToken: reg.body.verificationToken,
      })
      .expect(200);
    return { ...res.body.tokens, userId: res.body.user.id };
  }

  const login = (phoneNumber = PHONE, password = PASSWORD) => t.post('/auth/login', { phoneNumber, password });

  describe('registration', () => {
    it('creates an unverified user with a normalized phone number and an Argon2id password hash', async () => {
      const res = await register('0911234567', PASSWORD, { fullName: ' Abebe Kebede ', email: 'Abebe@Example.com' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        phoneNumber: PHONE,
        verificationRequired: true,
        otp: { expiresInSeconds: 300, resendAvailableInSeconds: 0 },
      });
      expect(res.body.tokens).toBeUndefined();

      const user = await t.prisma.user.findUniqueOrThrow({
        where: { phoneNumber: PHONE },
        include: { profile: true, roles: { include: { role: true } } },
      });
      expect(user.id).toBe(res.body.userId);
      expect(user.phoneVerifiedAt).toBeNull();
      expect(user.status).toBe(AccountStatus.ACTIVE);
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain(PASSWORD);
      expect(user.profile).toMatchObject({ fullName: 'Abebe Kebede', email: 'abebe@example.com' });
      expect(user.roles.map((r) => r.role.name)).toEqual(['USER']);
    });

    it('sends the OTP through the sender only: never in the response, never stored in clear text', async () => {
      const res = await register().expect(201);
      const code = t.sms.lastCode(PHONE, OtpPurpose.PHONE_VERIFICATION);

      expect(code).toMatch(/^\d{6}$/);
      expect(JSON.stringify(res.body)).not.toContain(code);
      const stored = await t.prisma.otpVerification.findFirstOrThrow({ where: { phoneNumber: PHONE } });
      expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.codeHash).not.toContain(code);
    });

    it.each(['+251911234567', '251911234567', '0911234567', '911234567', '+251 91 123 4567', '0711234567'])(
      'accepts Ethiopian mobile number written as "%s"',
      async (input) => {
        const res = await register(input).expect(201);
        expect(res.body.phoneNumber).toMatch(/^\+251[79]\d{8}$/);
      },
    );

    it.each([
      ['a Kenyan number', '+254712345678'],
      ['an Ethiopian landline', '+251111234567'],
      ['a number that is too short', '09112345'],
    ])('rejects %s', async (_label, input) => {
      const res = await register(input);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_PHONE_NUMBER');
      expect(await t.prisma.user.count()).toBe(0);
    });

    it.each([
      ['too short', 'Ab1'],
      ['without a digit', 'OnlyLettersHere'],
      ['without a letter', '1234567890'],
    ])('rejects a password that is %s', async (_label, password) => {
      const res = await register(PHONE, password);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_FAILED');
    });

    it('rejects unknown fields such as a client-supplied role or status', async () => {
      const res = await register(PHONE, PASSWORD, { role: 'ADMIN', status: 'ACTIVE' });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual(expect.arrayContaining(['property role should not exist']));
    });

    it('rejects a phone number that is already verified', async () => {
      await signUp();
      const res = await register(PHONE, 'An0therPassword');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('PHONE_ALREADY_REGISTERED');
    });

    it('rejects an email that belongs to another account', async () => {
      await register(PHONE, PASSWORD, { email: 'same@example.com' }).expect(201);
      const res = await register('+251922334455', PASSWORD, { email: 'SAME@example.com' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('EMAIL_ALREADY_IN_USE');
    });

    it('lets a later registration replace an unverified one, and invalidates the earlier verification token', async () => {
      const first = await register(PHONE, 'F1rstPassword').expect(201);
      const second = await register(PHONE, 'Sec0ndPassword').expect(201);
      expect(second.body.userId).toBe(first.body.userId);
      const code = t.sms.lastCode(PHONE, OtpPurpose.PHONE_VERIFICATION);

      // The first registrant cannot complete verification with the code sent for the second registration.
      const hijack = await t.post('/auth/verify-phone', {
        phoneNumber: PHONE,
        code,
        verificationToken: first.body.verificationToken,
      });
      expect(hijack.status).toBe(400);
      expect(hijack.body.error).toBe('REGISTRATION_SUPERSEDED');

      await t
        .post('/auth/verify-phone', { phoneNumber: PHONE, code, verificationToken: second.body.verificationToken })
        .expect(200);
      await login(PHONE, 'F1rstPassword').expect(401);
      await login(PHONE, 'Sec0ndPassword').expect(200);
    });

    it('reports a failed SMS delivery and lets the user retry', async () => {
      t.sms.failNext = true;
      const failed = await register();
      expect(failed.status).toBe(503);
      expect(failed.body.error).toBe('OTP_DELIVERY_FAILED');

      await register().expect(201);
    });
  });

  describe('phone verification', () => {
    it('verifies the phone, signs the user in and makes the code single-use', async () => {
      const reg = await register().expect(201);
      const body = {
        phoneNumber: PHONE,
        code: t.sms.lastCode(PHONE, OtpPurpose.PHONE_VERIFICATION),
        verificationToken: reg.body.verificationToken,
      };

      const res = await t.post('/auth/verify-phone', body).expect(200);
      expect(res.body.user).toMatchObject({ phoneNumber: PHONE, phoneVerified: true, roles: ['USER'] });
      expect(res.body.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, refreshExpiresIn: 30 * 86400 });

      const me = await t.get('/auth/me', res.body.tokens.accessToken).expect(200);
      expect(me.body).toMatchObject({ id: reg.body.userId, phoneVerified: true });
      expect(me.body.passwordHash).toBeUndefined();

      const again = await t.post('/auth/verify-phone', body);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('PHONE_ALREADY_VERIFIED');
    });

    it('rejects a wrong code and locks the code after too many attempts', async () => {
      const reg = await register().expect(201);
      const code = t.sms.lastCode(PHONE, OtpPurpose.PHONE_VERIFICATION);
      const wrong = code === '000000' ? '111111' : '000000';
      const verify = (c: string) =>
        t.post('/auth/verify-phone', { phoneNumber: PHONE, code: c, verificationToken: reg.body.verificationToken });

      for (let i = 0; i < 3; i++) {
        const res = await verify(wrong);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('OTP_INVALID');
      }
      // OTP_MAX_ATTEMPTS=3 in tests: even the right code is now refused.
      const locked = await verify(code);
      expect(locked.status).toBe(400);
      expect(locked.body.error).toBe('OTP_ATTEMPTS_EXCEEDED');

      const user = await t.prisma.user.findUniqueOrThrow({ where: { phoneNumber: PHONE } });
      expect(user.phoneVerifiedAt).toBeNull();
      expect(await t.prisma.securityEvent.count({ where: { type: SecurityEventType.OTP_VERIFICATION_FAILED } })).toBe(
        3,
      );
    });

    it('rejects an expired code', async () => {
      const reg = await register().expect(201);
      await t.prisma.otpVerification.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

      const res = await t.post('/auth/verify-phone', {
        phoneNumber: PHONE,
        code: t.sms.lastCode(PHONE, OtpPurpose.PHONE_VERIFICATION),
        verificationToken: reg.body.verificationToken,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('OTP_INVALID');
    });

    it('resending issues a new code and invalidates the previous one', async () => {
      const reg = await register().expect(201);
      const oldCode = t.sms.lastCode(PHONE, OtpPurpose.PHONE_VERIFICATION);

      await t.post('/auth/resend-verification', { phoneNumber: PHONE }).expect(202);
      const newCode = t.sms.lastCode(PHONE, OtpPurpose.PHONE_VERIFICATION);
      expect(t.sms.count(PHONE)).toBe(2);

      const verify = (code: string) =>
        t.post('/auth/verify-phone', { phoneNumber: PHONE, code, verificationToken: reg.body.verificationToken });
      if (oldCode !== newCode) await verify(oldCode).expect(400);
      await verify(newCode).expect(200);
    });

    it('answers resend requests identically for unknown numbers and sends nothing', async () => {
      await register().expect(201);
      const known = await t.post('/auth/resend-verification', { phoneNumber: PHONE }).expect(202);
      const unknown = await t.post('/auth/resend-verification', { phoneNumber: '+251922334455' }).expect(202);

      expect(unknown.body).toEqual(known.body);
      expect(t.sms.count('+251922334455')).toBe(0);
    });
  });

  describe('login', () => {
    it('signs in with phone number and password, in any accepted phone format', async () => {
      const { userId } = await signUp();

      const res = await login('0911234567').expect(200);
      expect(res.body.user).toMatchObject({ id: userId, phoneNumber: PHONE, phoneVerified: true });
      await t.get('/auth/me', res.body.tokens.accessToken).expect(200);

      const user = await t.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.lastLoginAt).not.toBeNull();
      expect(await t.prisma.securityEvent.count({ where: { type: SecurityEventType.LOGIN_SUCCESS, userId } })).toBe(1);
    });

    it('gives the same answer for a wrong password and an unknown phone number', async () => {
      await signUp();
      const wrongPassword = await login(PHONE, 'Wr0ngPassword');
      const unknownPhone = await login('+251922334455', PASSWORD);

      expect(wrongPassword.status).toBe(401);
      expect(unknownPhone.status).toBe(401);
      expect(wrongPassword.body.error).toBe('INVALID_CREDENTIALS');
      expect(unknownPhone.body.message).toBe(wrongPassword.body.message);
    });

    it('refuses unverified users but lets them finish verification with the returned token', async () => {
      await register().expect(201);

      const res = await login();
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('PHONE_NOT_VERIFIED');

      await t
        .post('/auth/verify-phone', {
          phoneNumber: PHONE,
          code: t.sms.lastCode(PHONE, OtpPurpose.PHONE_VERIFICATION),
          verificationToken: res.body.details.verificationToken,
        })
        .expect(200);
      await login().expect(200);
    });

    it.each([
      [AccountStatus.SUSPENDED, 'ACCOUNT_SUSPENDED'],
      [AccountStatus.BLOCKED, 'ACCOUNT_BLOCKED'],
    ])('refuses %s accounts', async (status, error) => {
      const { userId } = await signUp();
      await t.prisma.user.update({ where: { id: userId }, data: { status } });

      const res = await login();
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(error);
    });

    it('locks sign-in after repeated failures, even for the correct password', async () => {
      await signUp();
      // LOGIN_MAX_FAILED_ATTEMPTS=3 in tests.
      await login(PHONE, 'Wr0ngPassword1').expect(401);
      await login(PHONE, 'Wr0ngPassword2').expect(401);
      const third = await login(PHONE, 'Wr0ngPassword3');
      expect(third.status).toBe(429);
      expect(third.body.error).toBe('ACCOUNT_LOCKED');
      expect(third.body.details.retryAfterSeconds).toBe(900);

      const correct = await login();
      expect(correct.status).toBe(429);
      expect(correct.body.error).toBe('ACCOUNT_LOCKED');

      expect(await t.prisma.securityEvent.count({ where: { type: SecurityEventType.LOGIN_FAILED } })).toBe(3);
      expect(await t.prisma.securityEvent.count({ where: { type: SecurityEventType.ACCOUNT_LOCKED } })).toBe(1);

      // The lock is temporary: once it expires the user can sign in again.
      await t.redis.del(`auth:login:lock:${PHONE}`);
      await login().expect(200);
    });

    it('resets the failure counter after a successful sign-in', async () => {
      await signUp();
      await login(PHONE, 'Wr0ngPassword1').expect(401);
      await login(PHONE, 'Wr0ngPassword2').expect(401);
      await login().expect(200);
      await login(PHONE, 'Wr0ngPassword3').expect(401);
      await login().expect(200);
    });
  });

  describe('access and refresh tokens', () => {
    it('rejects requests without a token, with a malformed token, or with a refresh token used as access token', async () => {
      const session = await signUp();

      for (const token of [undefined, 'not-a-jwt', session.refreshToken, `${session.accessToken}x`]) {
        const res = await t.get('/auth/me', token);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('UNAUTHORIZED');
      }
    });

    it('rejects an access token signed with a different secret', async () => {
      const session = await signUp();
      const forged = await new JwtService().signAsync(
        { sub: session.userId, sid: 'x', roles: ['SUPER_ADMIN'], typ: 'access' },
        { secret: 'attacker-secret-attacker-secret-attacker', issuer: 'lub-auction-test', expiresIn: 900 },
      );
      await t.get('/auth/me', forged).expect(401);
    });

    it('rotates refresh tokens: the new pair works and the old refresh token stops working', async () => {
      const session = await signUp();

      const refreshed = await t.post('/auth/refresh', { refreshToken: session.refreshToken }).expect(200);
      expect(refreshed.body.refreshToken).not.toBe(session.refreshToken);
      await t.get('/auth/me', refreshed.body.accessToken).expect(200);

      const stored = await t.prisma.refreshToken.findMany({ orderBy: { createdAt: 'asc' } });
      expect(stored).toHaveLength(2);
      expect(stored[0]).toMatchObject({ revokedReason: 'ROTATED', replacedById: stored[1].id });
      expect(stored[1]).toMatchObject({ revokedAt: null, familyId: stored[0].familyId });
      expect(stored.every((s) => /^[0-9a-f]{64}$/.test(s.tokenHash))).toBe(true);
    });

    it('treats reuse of a rotated refresh token as theft and revokes the whole session', async () => {
      const session = await signUp();
      const refreshed = await t.post('/auth/refresh', { refreshToken: session.refreshToken }).expect(200);

      const reuse = await t.post('/auth/refresh', { refreshToken: session.refreshToken });
      expect(reuse.status).toBe(401);
      expect(reuse.body.error).toBe('INVALID_REFRESH_TOKEN');

      await t.post('/auth/refresh', { refreshToken: refreshed.body.refreshToken }).expect(401);
      await t.get('/auth/me', refreshed.body.accessToken).expect(401);
      expect(await t.prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
      expect(await t.prisma.securityEvent.count({ where: { type: SecurityEventType.REFRESH_TOKEN_REUSE } })).toBe(1);
    });

    it('never lets two concurrent refreshes of the same token both succeed', async () => {
      const session = await signUp();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => t.post('/auth/refresh', { refreshToken: session.refreshToken })),
      );
      expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
      expect(await t.prisma.refreshToken.count({ where: { revokedAt: null } })).toBeLessThanOrEqual(1);
    });

    it('rejects an access token presented as a refresh token and an expired refresh token', async () => {
      const session = await signUp();
      await t.post('/auth/refresh', { refreshToken: session.accessToken }).expect(401);

      await t.prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      await t.post('/auth/refresh', { refreshToken: session.refreshToken }).expect(401);
    });

    it('logout revokes the session immediately, for both the refresh and the access token', async () => {
      const session = await signUp();
      const other = (await login().expect(200)).body.tokens as Tokens;

      await t.post('/auth/logout', { refreshToken: session.refreshToken }).expect(204);

      await t.post('/auth/refresh', { refreshToken: session.refreshToken }).expect(401);
      await t.get('/auth/me', session.accessToken).expect(401);
      // Other devices stay signed in, and logging out twice is harmless.
      await t.get('/auth/me', other.accessToken).expect(200);
      await t.post('/auth/logout', { refreshToken: session.refreshToken }).expect(204);
    });

    it('logout-all revokes every session of the user', async () => {
      const first = await signUp();
      const second = (await login().expect(200)).body.tokens as Tokens;

      await t.post('/auth/logout-all', {}, first.accessToken).expect(204);

      for (const s of [first, second]) {
        await t.get('/auth/me', s.accessToken).expect(401);
        await t.post('/auth/refresh', { refreshToken: s.refreshToken }).expect(401);
      }
    });

    it('cuts off a suspended user immediately, without waiting for the access token to expire', async () => {
      const session = await signUp();
      await t.prisma.user.update({ where: { id: session.userId }, data: { status: AccountStatus.SUSPENDED } });

      const me = await t.get('/auth/me', session.accessToken);
      expect(me.status).toBe(403);
      expect(me.body.error).toBe('ACCOUNT_SUSPENDED');
      const refresh = await t.post('/auth/refresh', { refreshToken: session.refreshToken });
      expect(refresh.status).toBe(403);
    });
  });

  describe('password reset and change', () => {
    it('resets the password with an SMS code, signs out all sessions and clears a login lock', async () => {
      const session = await signUp();
      for (let i = 0; i < 3; i++) await login(PHONE, `Wr0ngPassword${i}`);
      await login().expect(429);

      await t.post('/auth/forgot-password', { phoneNumber: '0911234567' }).expect(202);
      const code = t.sms.lastCode(PHONE, OtpPurpose.PASSWORD_RESET);
      const body = { phoneNumber: PHONE, code, newPassword: 'Br4ndNewPassword' };
      await t.post('/auth/reset-password', body).expect(200);

      await t.get('/auth/me', session.accessToken).expect(401);
      await t.post('/auth/refresh', { refreshToken: session.refreshToken }).expect(401);
      await login(PHONE, PASSWORD).expect(401);
      await login(PHONE, 'Br4ndNewPassword').expect(200);

      // The code is single-use.
      const replay = await t.post('/auth/reset-password', { ...body, newPassword: 'Y3tAnotherPassword' });
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe('OTP_INVALID');
      expect(await t.prisma.securityEvent.count({ where: { type: SecurityEventType.PASSWORD_RESET } })).toBe(1);
    });

    it('answers forgot-password identically for unknown numbers and sends nothing', async () => {
      await signUp();
      const known = await t.post('/auth/forgot-password', { phoneNumber: PHONE }).expect(202);
      const unknown = await t.post('/auth/forgot-password', { phoneNumber: '+251922334455' }).expect(202);

      expect(unknown.body).toEqual(known.body);
      expect(t.sms.count('+251922334455')).toBe(0);
      expect(JSON.stringify(known.body)).not.toContain(t.sms.lastCode(PHONE, OtpPurpose.PASSWORD_RESET));
    });

    it('does not accept a phone-verification code for a password reset', async () => {
      await signUp();
      await register('+251922334455').expect(201);
      await t.prisma.otpVerification.updateMany({
        where: { phoneNumber: '+251922334455' },
        data: { phoneNumber: PHONE, consumedAt: null },
      });
      const verificationCode = t.sms.lastCode('+251922334455', OtpPurpose.PHONE_VERIFICATION);

      const res = await t.post('/auth/reset-password', {
        phoneNumber: PHONE,
        code: verificationCode,
        newPassword: 'Br4ndNewPassword',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('OTP_INVALID');
      await login().expect(200);
    });

    it('rejects a wrong reset code and keeps the old password', async () => {
      await signUp();
      await t.post('/auth/forgot-password', { phoneNumber: PHONE }).expect(202);
      const code = t.sms.lastCode(PHONE, OtpPurpose.PASSWORD_RESET);

      const res = await t.post('/auth/reset-password', {
        phoneNumber: PHONE,
        code: code === '000000' ? '111111' : '000000',
        newPassword: 'Br4ndNewPassword',
      });
      expect(res.status).toBe(400);
      await login(PHONE, 'Br4ndNewPassword').expect(401);
      await login().expect(200);
    });

    it('changes the password for a signed-in user and replaces all sessions with a new one', async () => {
      const session = await signUp();
      const other = (await login().expect(200)).body.tokens as Tokens;

      await t
        .post(
          '/auth/change-password',
          { currentPassword: 'Wr0ngPassword', newPassword: 'Br4ndNewPassword' },
          session.accessToken,
        )
        .expect(401);
      const same = await t.post(
        '/auth/change-password',
        { currentPassword: PASSWORD, newPassword: PASSWORD },
        session.accessToken,
      );
      expect(same.body.error).toBe('PASSWORD_REUSED');

      const res = await t
        .post(
          '/auth/change-password',
          { currentPassword: PASSWORD, newPassword: 'Br4ndNewPassword' },
          session.accessToken,
        )
        .expect(200);

      await t.get('/auth/me', res.body.tokens.accessToken).expect(200);
      await t.get('/auth/me', session.accessToken).expect(401);
      await t.get('/auth/me', other.accessToken).expect(401);
      await t.post('/auth/refresh', { refreshToken: other.refreshToken }).expect(401);
      await login(PHONE, PASSWORD).expect(401);
      await login(PHONE, 'Br4ndNewPassword').expect(200);
    });
  });

  describe('rate limiting', () => {
    it('limits authentication endpoints per IP address', async () => {
      const previous = process.env.AUTH_THROTTLE_LIMIT;
      process.env.AUTH_THROTTLE_LIMIT = '3';
      try {
        // Different numbers each time, so this is the per-IP limit and not the per-account lockout.
        for (let i = 0; i < 3; i++) await login(`+25191100000${i}`, PASSWORD).expect(401);
        const res = await login('+251911000009', PASSWORD);
        expect(res.status).toBe(429);
        expect(res.body.error).toBe('RATE_LIMITED');
      } finally {
        process.env.AUTH_THROTTLE_LIMIT = previous;
      }
    });
  });

  describe('health', () => {
    it('reports readiness of PostgreSQL and Redis without authentication', async () => {
      const res = await t.get('/health/ready').expect(200);
      expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    });
  });
});
