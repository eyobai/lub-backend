import { CountryCode } from 'libphonenumber-js/max';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  apiPrefix: string;
  corsOrigins: string[];
  logLevel: string;
  trustProxy: boolean;
  swaggerEnabled: boolean;
  redisUrl: string;
  /** Currency used when a request does not name one. Must exist in the `currencies` table. */
  defaultCurrency: string;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtlSeconds: number;
    refreshTtlDays: number;
    issuer: string;
  };
  login: { maxFailedAttempts: number; failureWindowSeconds: number; lockoutSeconds: number };
  otp: {
    provider: string;
    hmacSecret: string;
    length: number;
    ttlSeconds: number;
    maxAttempts: number;
    resendCooldownSeconds: number;
    maxPerHour: number;
  };
  phone: { allowedCountries: CountryCode[]; defaultCountry: CountryCode; verificationRequired: boolean };
  throttle: { ttlSeconds: number; limit: number; authLimit: number };
  /** How often due auctions are opened/closed, in seconds. 0 turns the background sweep off. */
  auctions: {
    sweepIntervalSeconds: number;
    /** How long before closing bidders are reminded, in minutes. 0 turns reminders off. */
    closingReminderMinutes: number;
  };
  /** How often pending SMS/email/push notifications are sent, in seconds. 0 turns the background job off. */
  notifications: { dispatchIntervalSeconds: number };
  payments: {
    /** "none" turns deposits off. */
    provider: 'none' | 'chapa';
    /** Smallest and largest single deposit, in minor units of the default currency. */
    depositMinMinor: bigint;
    /** Top-up bonus: this percent of a wallet top-up, at most `maxMinor`, spendable for `validDays`. 0 turns it off. */
    bonus: { percent: number; maxMinor: bigint; validDays: number };
    depositMaxMinor: bigint;
    /** A deposit the provider never confirms is given up on after this long. */
    depositExpiryMinutes: number;
    /** How often unconfirmed deposits are checked with the provider, in seconds. 0 turns the background job off. */
    sweepIntervalSeconds: number;
    /** This API's address as the provider reaches it, without a trailing slash. Empty: no callback address is sent. */
    publicApiUrl: string;
    /** The website's address, where users land after paying, without a trailing slash. */
    webAppUrl: string;
    chapa: {
      secretKey: string;
      webhookSecret: string;
      baseUrl: string;
      timeoutMs: number;
      /** Mobile wallets charged without leaving the site (Chapa direct charge). Empty: only the checkout page. */
      directChargeMethods: string[];
    };
  };
}

/** Builds the typed config from already-validated environment variables. */
export function configuration(): { app: AppConfig } {
  const e = process.env;
  const num = (key: string, fallback: number) => (e[key] !== undefined && e[key] !== '' ? Number(e[key]) : fallback);
  const bool = (key: string, fallback: boolean) =>
    e[key] !== undefined && e[key] !== '' ? e[key] === 'true' : fallback;
  const env = (e.NODE_ENV ?? 'development') as AppConfig['env'];

  return {
    app: {
      env,
      isProduction: env === 'production',
      port: num('PORT', 3000),
      apiPrefix: e.API_PREFIX ?? 'api/v1',
      corsOrigins: (e.CORS_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      logLevel: e.LOG_LEVEL ?? 'info',
      trustProxy: bool('TRUST_PROXY', false),
      swaggerEnabled: bool('SWAGGER_ENABLED', env !== 'production'),
      redisUrl: e.REDIS_URL as string,
      defaultCurrency: e.DEFAULT_CURRENCY ?? 'ETB',
      jwt: {
        accessSecret: e.JWT_ACCESS_SECRET as string,
        refreshSecret: e.JWT_REFRESH_SECRET as string,
        accessTtlSeconds: num('JWT_ACCESS_TTL_SECONDS', 900),
        refreshTtlDays: num('JWT_REFRESH_TTL_DAYS', 30),
        issuer: e.JWT_ISSUER ?? 'lub-auction',
      },
      login: {
        maxFailedAttempts: num('LOGIN_MAX_FAILED_ATTEMPTS', 5),
        failureWindowSeconds: num('LOGIN_FAILURE_WINDOW_SECONDS', 900),
        lockoutSeconds: num('LOGIN_LOCKOUT_SECONDS', 900),
      },
      otp: {
        provider: e.OTP_PROVIDER ?? 'none',
        hmacSecret: e.OTP_HMAC_SECRET as string,
        length: num('OTP_LENGTH', 6),
        ttlSeconds: num('OTP_TTL_SECONDS', 300),
        maxAttempts: num('OTP_MAX_ATTEMPTS', 5),
        resendCooldownSeconds: num('OTP_RESEND_COOLDOWN_SECONDS', 60),
        maxPerHour: num('OTP_MAX_PER_HOUR', 5),
      },
      phone: {
        allowedCountries: (e.PHONE_ALLOWED_COUNTRIES ?? 'ET').split(',') as CountryCode[],
        defaultCountry: (e.PHONE_DEFAULT_COUNTRY ?? 'ET') as CountryCode,
        verificationRequired: bool('PHONE_VERIFICATION_REQUIRED', false),
      },
      throttle: {
        ttlSeconds: num('THROTTLE_TTL_SECONDS', 60),
        limit: num('THROTTLE_LIMIT', 120),
        authLimit: num('AUTH_THROTTLE_LIMIT', 10),
      },
      auctions: {
        sweepIntervalSeconds: num('AUCTION_SWEEP_INTERVAL_SECONDS', 5),
        closingReminderMinutes: num('AUCTION_CLOSING_REMINDER_MINUTES', 60),
      },
      notifications: { dispatchIntervalSeconds: num('NOTIFICATION_DISPATCH_INTERVAL_SECONDS', 10) },
      payments: {
        provider: (e.PAYMENT_PROVIDER ?? 'none') as 'none' | 'chapa',
        depositMinMinor: BigInt(e.DEPOSIT_MIN_MINOR || '1000'),
        bonus: {
          percent: num('TOPUP_BONUS_PERCENT', 100),
          maxMinor: BigInt(e.TOPUP_BONUS_MAX_MINOR || '1000000'),
          validDays: num('TOPUP_BONUS_VALID_DAYS', 7),
        },
        depositMaxMinor: BigInt(e.DEPOSIT_MAX_MINOR || '5000000'),
        depositExpiryMinutes: num('DEPOSIT_EXPIRY_MINUTES', 120),
        sweepIntervalSeconds: num('PAYMENT_SWEEP_INTERVAL_SECONDS', 60),
        publicApiUrl: (e.PUBLIC_API_URL ?? '').replace(/\/+$/, ''),
        webAppUrl: (e.WEB_APP_URL ?? '').replace(/\/+$/, ''),
        chapa: {
          secretKey: e.CHAPA_SECRET_KEY ?? '',
          webhookSecret: e.CHAPA_WEBHOOK_SECRET ?? '',
          baseUrl: (e.CHAPA_BASE_URL ?? 'https://api.chapa.co').replace(/\/+$/, ''),
          timeoutMs: num('CHAPA_TIMEOUT_MS', 15000),
          directChargeMethods: (e.CHAPA_DIRECT_CHARGE_METHODS ?? 'telebirr,mpesa,cbebirr,ebirr')
            .split(',')
            .map((method) => method.trim())
            .filter(Boolean),
        },
      },
    },
  };
}

export const APP_CONFIG = 'APP_CONFIG';
