import { NotificationChannel, NotificationType } from '@prisma/client';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { MAX_ATTEMPTS, NotificationDispatcher, retryDelaySeconds } from './notification-dispatcher.service';
import type { NotificationProvider } from './notification.types';

const provider = (channel: NotificationProvider['channel']): NotificationProvider => ({
  channel,
  accepts: (type) => type === NotificationType.WINNER_ANNOUNCEMENT,
  send: () => Promise.resolve(),
});

describe('NotificationDispatcher', () => {
  it('waits longer after each failed attempt', () => {
    const delays = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => retryDelaySeconds(i + 1));
    expect(delays).toEqual([60, 300, 1800, 7200]);
    expect(retryDelaySeconds(50)).toBe(7200);
  });

  it('does nothing, without touching the database, when no provider is registered', async () => {
    const findMany = jest.fn();
    const dispatcher = new NotificationDispatcher({ notification: { findMany } } as unknown as PrismaService, []);

    expect(dispatcher.enabled).toBe(false);
    await expect(dispatcher.dispatchPending()).resolves.toEqual({ sent: 0, failed: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('refuses two providers for the same channel', () => {
    const sms = [provider(NotificationChannel.SMS), provider(NotificationChannel.SMS)];
    expect(() => new NotificationDispatcher({} as PrismaService, sms)).toThrow(/share a channel/);
  });
});
