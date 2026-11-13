import { Throttle } from '@nestjs/throttler';

/** Stricter per-IP limit for unauthenticated, abuse-prone endpoints (AUTH_THROTTLE_LIMIT per THROTTLE_TTL_SECONDS). */
export const AuthThrottle = () =>
  Throttle({
    default: {
      limit: () => Number(process.env.AUTH_THROTTLE_LIMIT ?? 10),
      ttl: () => Number(process.env.THROTTLE_TTL_SECONDS ?? 60) * 1000,
    },
  });
