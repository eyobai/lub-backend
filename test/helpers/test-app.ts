import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OtpPurpose } from '@prisma/client';
import Redis from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PrismaService } from '../../src/infra/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/infra/redis/redis.module';
import { NOTIFICATION_PROVIDERS } from '../../src/modules/notifications/notification.types';
import type { NotificationProvider } from '../../src/modules/notifications/notification.types';
import { OTP_SENDER, OtpMessage, OtpSender } from '../../src/modules/otp/senders/otp-sender.interface';

/** Stands in for an SMS provider: records messages so tests can read the code "from the phone". */
export class CapturingOtpSender implements OtpSender {
  readonly name = 'test-capture';
  readonly messages: OtpMessage[] = [];
  failNext = false;

  send(message: OtpMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('simulated SMS provider outage'));
    }
    this.messages.push(message);
    return Promise.resolve();
  }

  lastCode(phoneNumber: string, purpose: OtpPurpose): string {
    const message = [...this.messages].reverse().find((m) => m.phoneNumber === phoneNumber && m.purpose === purpose);
    if (!message) throw new Error(`No ${purpose} OTP was sent to ${phoneNumber}`);
    return message.code;
  }

  count(phoneNumber: string, purpose?: OtpPurpose): number {
    return this.messages.filter((m) => m.phoneNumber === phoneNumber && (!purpose || m.purpose === purpose)).length;
  }
}

export interface TestApp {
  app: INestApplication<App>;
  prisma: PrismaService;
  redis: Redis;
  sms: CapturingOtpSender;
  post: (path: string, body?: object, accessToken?: string) => request.Test;
  patch: (path: string, body?: object, accessToken?: string) => request.Test;
  put: (path: string, body?: object, accessToken?: string) => request.Test;
  get: (path: string, accessToken?: string) => request.Test;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/** Boots the real application (real PostgreSQL + Redis); only SMS delivery is replaced. */
export async function createTestApp(
  envOverrides: Record<string, string> = {},
  notificationProviders: NotificationProvider[] = [],
): Promise<TestApp> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const sms = new CapturingOtpSender();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OTP_SENDER)
    .useValue(sms)
    .overrideProvider(NOTIFICATION_PROVIDERS)
    .useValue(notificationProviders)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  const config = configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  const redis = app.get<Redis>(REDIS_CLIENT);
  const url = (path: string) => (path.startsWith('/health') ? path : `/${config.apiPrefix}${path}`);
  const withAuth = (req: request.Test, token?: string) => (token ? req.set('Authorization', `Bearer ${token}`) : req);

  return {
    app,
    prisma,
    redis,
    sms,
    post: (path, body = {}, token) => withAuth(request(app.getHttpServer()).post(url(path)).send(body), token),
    patch: (path, body = {}, token) => withAuth(request(app.getHttpServer()).patch(url(path)).send(body), token),
    put: (path, body = {}, token) => withAuth(request(app.getHttpServer()).put(url(path)).send(body), token),
    get: (path, token) => withAuth(request(app.getHttpServer()).get(url(path)), token),
    reset: async () => {
      const tables = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'roles', 'currencies')`;
      const list = tables.map((t) => `"${t.tablename}"`).join(', ');
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
      await redis.flushdb();
      sms.messages.length = 0;
      sms.failNext = false;
    },
    close: async () => {
      await app.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
