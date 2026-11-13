import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';

/** Per-phone-number brute-force protection: N failures inside a window lock login for a while. */
@Injectable()
export class LoginAttemptService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private failKey = (phone: string) => `auth:login:fail:${phone}`;
  private lockKey = (phone: string) => `auth:login:lock:${phone}`;

  /** Seconds until the lock expires, or 0 when the number is not locked. */
  async lockedForSeconds(phoneNumber: string): Promise<number> {
    const ttl = await this.redis.ttl(this.lockKey(phoneNumber));
    return ttl > 0 ? ttl : 0;
  }

  /** Records a failed attempt; returns true when this failure triggered a lock. */
  async recordFailure(phoneNumber: string): Promise<boolean> {
    const { maxFailedAttempts, failureWindowSeconds, lockoutSeconds } = this.config.login;
    const key = this.failKey(phoneNumber);
    const failures = await this.redis.incr(key);
    if (failures === 1) await this.redis.expire(key, failureWindowSeconds);
    if (failures < maxFailedAttempts) return false;

    await this.redis.multi().set(this.lockKey(phoneNumber), '1', 'EX', lockoutSeconds).del(key).exec();
    return true;
  }

  async reset(phoneNumber: string): Promise<void> {
    await this.redis.del(this.failKey(phoneNumber), this.lockKey(phoneNumber));
  }
}
