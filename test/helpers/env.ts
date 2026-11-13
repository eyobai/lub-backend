// Loaded by Jest before every test file: fixed, non-secret configuration for the test stack.
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? 'postgresql://lub:lub_dev_password@localhost:5432/lub_test?schema=public',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
  JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0001',
  JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-0002',
  JWT_ACCESS_TTL_SECONDS: '900',
  JWT_REFRESH_TTL_DAYS: '30',
  JWT_ISSUER: 'lub-auction-test',
  OTP_PROVIDER: 'console',
  OTP_HMAC_SECRET: 'test-otp-hmac-secret-test-otp-hmac-secret-0003',
  OTP_LENGTH: '6',
  OTP_TTL_SECONDS: '300',
  OTP_MAX_ATTEMPTS: '3',
  OTP_RESEND_COOLDOWN_SECONDS: '0',
  OTP_MAX_PER_HOUR: '100',
  LOGIN_MAX_FAILED_ATTEMPTS: '3',
  LOGIN_FAILURE_WINDOW_SECONDS: '900',
  LOGIN_LOCKOUT_SECONDS: '900',
  PHONE_ALLOWED_COUNTRIES: 'ET',
  PHONE_DEFAULT_COUNTRY: 'ET',
  THROTTLE_TTL_SECONDS: '60',
  THROTTLE_LIMIT: '100000',
  AUTH_THROTTLE_LIMIT: '100000',
  TRUST_PROXY: 'false',
  SWAGGER_ENABLED: 'false',
};

for (const [key, value] of Object.entries(defaults)) process.env[key] = value;
