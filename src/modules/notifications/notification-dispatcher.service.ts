import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationStatus } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { NOTIFICATION_PROVIDERS } from './notification.types';
import type { NotificationProvider } from './notification.types';

export const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;
const SEND_TIMEOUT_MS = 15_000;

/** Wait before the next try: 1 min, 5 min, 30 min, 2 h. */
const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200];
export const retryDelaySeconds = (attempts: number): number =>
  RETRY_DELAYS_SECONDS[Math.min(attempts, RETRY_DELAYS_SECONDS.length) - 1];

export interface DispatchRun {
  sent: number;
  failed: number;
}

/**
 * Sends the notifications waiting for an external channel (SMS, email, push). A failed send is retried
 * with growing delays and given up after MAX_ATTEMPTS. Delivery is at-least-once: a message may be sent
 * twice if the server stops between sending it and recording that.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly byChannel: Map<NotificationChannel, NotificationProvider>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_PROVIDERS) providers: NotificationProvider[],
  ) {
    this.byChannel = new Map(providers.map((p) => [p.channel, p]));
    if (this.byChannel.size !== providers.length) throw new Error('Two notification providers share a channel');
  }

  get enabled(): boolean {
    return this.byChannel.size > 0;
  }

  async dispatchPending(): Promise<DispatchRun> {
    const run: DispatchRun = { sent: 0, failed: 0 };
    if (!this.enabled) return run;
    const due = await this.prisma.notification.findMany({
      where: {
        status: NotificationStatus.PENDING,
        channel: { in: [...this.byChannel.keys()] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true },
    });
    for (const { id } of due) {
      const outcome = await this.dispatchOne(id);
      if (outcome) run[outcome] += 1;
    }
    return run;
  }

  /** The row lock keeps two instances from sending the same notification at the same time. */
  private dispatchOne(id: string): Promise<'sent' | 'failed' | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM notifications
          WHERE id = ${id}::uuid AND status = 'PENDING'::"NotificationStatus"
          FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return null; // taken by another instance, or already handled
        const n = await tx.notification.findUniqueOrThrow({
          where: { id },
          include: { user: { select: { phoneNumber: true, profile: { select: { email: true, locale: true } } } } },
        });
        const provider = this.byChannel.get(n.channel);
        if (!provider) return null;

        try {
          await withTimeout(
            provider.send({
              id: n.id,
              type: n.type,
              title: n.title,
              body: n.body,
              data: (n.data ?? undefined) as never,
              recipient: {
                userId: n.userId,
                phoneNumber: n.user.phoneNumber,
                email: n.user.profile?.email ?? null,
                locale: n.user.profile?.locale ?? 'en',
              },
            }),
            SEND_TIMEOUT_MS,
          );
        } catch (error) {
          const attempts = n.attempts + 1;
          const givenUp = attempts >= MAX_ATTEMPTS;
          await tx.notification.update({
            where: { id },
            data: {
              attempts,
              lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
              status: givenUp ? NotificationStatus.FAILED : NotificationStatus.PENDING,
              nextAttemptAt: givenUp ? null : new Date(Date.now() + retryDelaySeconds(attempts) * 1000),
            },
          });
          this.logger.warn({ notificationId: id, channel: n.channel, attempts, givenUp }, 'Notification not sent');
          return 'failed';
        }
        await tx.notification.update({
          where: { id },
          data: {
            attempts: n.attempts + 1,
            status: NotificationStatus.SENT,
            sentAt: new Date(),
            lastError: null,
            nextAttemptAt: null,
          },
        });
        return 'sent';
      },
      { maxWait: 5_000, timeout: SEND_TIMEOUT_MS + 5_000 },
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Sending timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
