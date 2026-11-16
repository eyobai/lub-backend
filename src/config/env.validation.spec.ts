import { validateEnv } from './env.validation';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  OTP_HMAC_SECRET: 'c'.repeat(40),
  OTP_PROVIDER: 'console',
};

describe('environment validation', () => {
  it('accepts a valid development configuration and applies defaults', () => {
    const env = validateEnv(base);
    expect(env).toMatchObject({
      PORT: 3000,
      OTP_LENGTH: 6,
      JWT_ACCESS_TTL_SECONDS: 900,
      PHONE_ALLOWED_COUNTRIES: 'ET',
    });
  });

  it('refuses to start in production with the development OTP provider', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /OTP_PROVIDER "console" is a development-only provider/,
    );
  });

  it('accepts a real OTP provider name in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', OTP_PROVIDER: 'some-sms-gateway' })).not.toThrow();
  });

  it('refuses placeholder secrets in production but allows them in development', () => {
    const placeholder = { ...base, JWT_ACCESS_SECRET: 'change-me-access-secret-at-least-32-characters' };
    expect(() => validateEnv(placeholder)).not.toThrow();
    expect(() => validateEnv({ ...placeholder, NODE_ENV: 'production', OTP_PROVIDER: 'some-sms-gateway' })).toThrow(
      /JWT_ACCESS_SECRET.*placeholder/,
    );
  });

  it('refuses short secrets and identical access/refresh secrets', () => {
    expect(() => validateEnv({ ...base, OTP_HMAC_SECRET: 'short' })).toThrow(/OTP_HMAC_SECRET/);
    expect(() => validateEnv({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET })).toThrow(
      /JWT_REFRESH_SECRET must differ/,
    );
  });

  it('reports every missing required variable', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL.*REDIS_URL.*JWT_ACCESS_SECRET/s);
  });

  it('defaults to no phone verification and no SMS provider', () => {
    const withoutProvider: Record<string, string> = { ...base };
    delete withoutProvider.OTP_PROVIDER;
    expect(validateEnv(withoutProvider)).toMatchObject({ PHONE_VERIFICATION_REQUIRED: false, OTP_PROVIDER: 'none' });
    expect(() => validateEnv({ ...withoutProvider, NODE_ENV: 'production' })).not.toThrow();
  });

  it('refuses phone verification without an SMS provider', () => {
    expect(() => validateEnv({ ...base, PHONE_VERIFICATION_REQUIRED: 'true', OTP_PROVIDER: 'none' })).toThrow(
      /PHONE_VERIFICATION_REQUIRED=true needs an OTP_PROVIDER/,
    );
  });

  describe('payments', () => {
    const chapa = {
      PAYMENT_PROVIDER: 'chapa',
      CHAPA_SECRET_KEY: 'CHASECK_TEST-not-a-real-key',
      CHAPA_WEBHOOK_SECRET: 'w'.repeat(32),
      WEB_APP_URL: 'http://localhost:5173',
    };

    it('leaves deposits off by default, with the default limits', () => {
      expect(validateEnv(base)).toMatchObject({
        PAYMENT_PROVIDER: 'none',
        DEPOSIT_MIN_MINOR: '1000',
        DEPOSIT_MAX_MINOR: '5000000',
      });
    });

    it('accepts Chapa with a key, a webhook secret and the website address', () => {
      expect(validateEnv({ ...base, ...chapa })).toMatchObject({ PAYMENT_PROVIDER: 'chapa' });
    });

    it.each(['CHAPA_SECRET_KEY', 'WEB_APP_URL'])('refuses Chapa without %s', (key) => {
      expect(() => validateEnv({ ...base, ...chapa, [key]: '' })).toThrow(key);
    });

    it.each([{ CHAPA_WEBHOOK_SECRET: '' }, { CHAPA_WEBHOOK_SECRET: undefined }])(
      'accepts Chapa without a webhook secret: %o',
      (override) => {
        expect(validateEnv({ ...base, ...chapa, ...override })).toMatchObject({ PAYMENT_PROVIDER: 'chapa' });
      },
    );

    it('refuses a short webhook secret and an unknown provider', () => {
      expect(() => validateEnv({ ...base, ...chapa, CHAPA_WEBHOOK_SECRET: 'short' })).toThrow('CHAPA_WEBHOOK_SECRET');
      expect(() => validateEnv({ ...base, PAYMENT_PROVIDER: 'paypal' })).toThrow('PAYMENT_PROVIDER');
    });

    it('needs https addresses for the API, the website and Chapa in production', () => {
      const production = {
        ...base,
        ...chapa,
        NODE_ENV: 'production',
        OTP_PROVIDER: 'none',
        PUBLIC_API_URL: 'https://api.example.com',
        WEB_APP_URL: 'https://example.com',
      };
      expect(() => validateEnv(production)).not.toThrow();
      for (const key of ['PUBLIC_API_URL', 'WEB_APP_URL', 'CHAPA_BASE_URL']) {
        expect(() => validateEnv({ ...production, [key]: 'http://example.com' })).toThrow(`${key} must be an https`);
      }
      expect(() => validateEnv({ ...production, PUBLIC_API_URL: '' })).toThrow('PUBLIC_API_URL must be an https');
    });

    it('refuses a minimum deposit above the maximum, and amounts that are not whole numbers', () => {
      expect(() => validateEnv({ ...base, DEPOSIT_MIN_MINOR: '2000', DEPOSIT_MAX_MINOR: '1000' })).toThrow(
        'DEPOSIT_MIN_MINOR is larger',
      );
      expect(() => validateEnv({ ...base, DEPOSIT_MIN_MINOR: '10.5' })).toThrow('DEPOSIT_MIN_MINOR');
    });
  });
});
