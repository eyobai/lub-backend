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
});
