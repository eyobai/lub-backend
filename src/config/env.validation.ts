import * as Joi from 'joi';

const PLACEHOLDER_SECRET = /change-me/i;

const secret = () =>
  Joi.string()
    .min(32)
    .required()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().pattern(PLACEHOLDER_SECRET, { invert: true }).messages({
        'string.pattern.invert.base': '{{#label}} must not use a placeholder value in production',
      }),
    });

/** OTP providers that only exist for local development and automated tests. */
export const DEV_ONLY_OTP_PROVIDERS = ['console'];

export const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent').default('info'),
  TRUST_PROXY: Joi.boolean().default(false),
  // API docs are opt-in in production.
  SWAGGER_ENABLED: Joi.boolean().when('NODE_ENV', {
    is: 'production',
    then: Joi.boolean().default(false),
    otherwise: Joi.boolean().default(true),
  }),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  JWT_ACCESS_SECRET: secret(),
  JWT_REFRESH_SECRET: secret().invalid(Joi.ref('JWT_ACCESS_SECRET')).messages({
    'any.invalid': 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
  }),
  JWT_ACCESS_TTL_SECONDS: Joi.number().integer().min(60).max(3600).default(900),
  JWT_REFRESH_TTL_DAYS: Joi.number().integer().min(1).max(365).default(30),
  JWT_ISSUER: Joi.string().default('lub-auction'),

  LOGIN_MAX_FAILED_ATTEMPTS: Joi.number().integer().min(1).default(5),
  LOGIN_FAILURE_WINDOW_SECONDS: Joi.number().integer().min(1).default(900),
  LOGIN_LOCKOUT_SECONDS: Joi.number().integer().min(1).default(900),

  // false: accounts are usable right after registration and no SMS is ever sent.
  PHONE_VERIFICATION_REQUIRED: Joi.boolean().default(false),
  OTP_PROVIDER: Joi.string()
    .default('none')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string()
        .invalid(...DEV_ONLY_OTP_PROVIDERS)
        .messages({
          'any.invalid': 'OTP_PROVIDER "{{#value}}" is a development-only provider and cannot be used in production',
        }),
    }),
  OTP_HMAC_SECRET: secret(),
  OTP_LENGTH: Joi.number().integer().min(4).max(8).default(6),
  OTP_TTL_SECONDS: Joi.number().integer().min(30).max(3600).default(300),
  OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: Joi.number().integer().min(0).default(60),
  OTP_MAX_PER_HOUR: Joi.number().integer().min(1).default(5),

  PHONE_ALLOWED_COUNTRIES: Joi.string()
    .pattern(/^[A-Z]{2}(,[A-Z]{2})*$/)
    .default('ET'),
  DEFAULT_CURRENCY: Joi.string().length(3).uppercase().default('ETB'),
  PHONE_DEFAULT_COUNTRY: Joi.string().length(2).uppercase().default('ET'),

  THROTTLE_TTL_SECONDS: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(120),
  AUTH_THROTTLE_LIMIT: Joi.number().integer().min(1).default(10),

  AUCTION_SWEEP_INTERVAL_SECONDS: Joi.number().integer().min(0).max(3600).default(5),
  AUCTION_CLOSING_REMINDER_MINUTES: Joi.number().integer().min(0).max(10080).default(60),
  NOTIFICATION_DISPATCH_INTERVAL_SECONDS: Joi.number().integer().min(0).max(3600).default(10),

  PAYMENT_PROVIDER: Joi.string().valid('none', 'chapa').default('none'),
  CHAPA_SECRET_KEY: Joi.string()
    .allow('')
    .when('PAYMENT_PROVIDER', { is: 'chapa', then: Joi.string().min(10).invalid('').required() }),
  CHAPA_WEBHOOK_SECRET: Joi.string()
    .allow('')
    .when('PAYMENT_PROVIDER', { is: 'chapa', then: Joi.string().min(16).invalid('').required() }),
  CHAPA_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://api.chapa.co'),
  CHAPA_TIMEOUT_MS: Joi.number().integer().min(1000).max(60000).default(15000),
  DEPOSIT_MIN_MINOR: Joi.string()
    .pattern(/^[1-9]\d{0,14}$/)
    .default('1000'),
  DEPOSIT_MAX_MINOR: Joi.string()
    .pattern(/^[1-9]\d{0,14}$/)
    .default('5000000'),
  DEPOSIT_EXPIRY_MINUTES: Joi.number().integer().min(5).max(10080).default(120),
  PAYMENT_SWEEP_INTERVAL_SECONDS: Joi.number().integer().min(0).max(3600).default(60),
  PUBLIC_API_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow(''),
  WEB_APP_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .when('PAYMENT_PROVIDER', { is: 'chapa', then: Joi.string().min(1).invalid('').required() }),
}).unknown(true);

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const result = envSchema.validate(config, { abortEarly: false });
  if (result.error) {
    throw new Error(`Invalid environment configuration: ${result.error.details.map((d) => d.message).join('; ')}`);
  }
  const value = result.value as Record<string, unknown>;
  if (value.PHONE_VERIFICATION_REQUIRED === true && value.OTP_PROVIDER === 'none') {
    throw new Error('Invalid environment configuration: PHONE_VERIFICATION_REQUIRED=true needs an OTP_PROVIDER');
  }
  if (BigInt(value.DEPOSIT_MIN_MINOR as string) > BigInt(value.DEPOSIT_MAX_MINOR as string)) {
    throw new Error('Invalid environment configuration: DEPOSIT_MIN_MINOR is larger than DEPOSIT_MAX_MINOR');
  }
  if (value.PAYMENT_PROVIDER === 'chapa' && value.NODE_ENV === 'production') {
    // In production the webhook is the only notice that reaches the server when a payer never returns to the site.
    for (const key of ['PUBLIC_API_URL', 'WEB_APP_URL', 'CHAPA_BASE_URL']) {
      const address: unknown = value[key];
      if (typeof address !== 'string' || !address.startsWith('https://')) {
        throw new Error(`Invalid environment configuration: ${key} must be an https address in production`);
      }
    }
  }
  return value;
}
