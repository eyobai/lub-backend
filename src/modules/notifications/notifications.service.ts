import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationStatus } from '@prisma/client';
import type { Notification, Prisma } from '@prisma/client';
import { paging } from '../../common/dto/page-query.dto';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { ListNotificationsQueryDto, NotificationDto, NotificationPageDto } from './dto/notification.dto';
import { NOTIFICATION_PROVIDERS } from './notification.types';
import type { NotificationMessage, NotificationProvider } from './notification.types';

type Tx = Prisma.TransactionClient;

const toDto = (n: Notification): NotificationDto => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  data: (n.data ?? null) as Record<string, unknown> | null,
  read: n.readAt !== null,
  readAt: n.readAt,
  createdAt: n.createdAt,
});

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_PROVIDERS) private readonly providers: NotificationProvider[],
  ) {}

  /**
   * Records a notification for one user. Call it with the transaction of the event it reports: the
   * notification then exists exactly when the event was committed. The in-app copy is readable at once;
   * copies for SMS, email or push (if a provider wants this type) are sent afterwards by the dispatcher.
   *
   * A notification never fails the event it reports: if recording it fails, only the notification is
   * rolled back (to a savepoint), the failure is logged and the caller's transaction carries on.
   */
  notify(tx: Tx, userId: string, message: NotificationMessage): Promise<void> {
    return this.notifyMany(tx, [userId], message);
  }

  /** Records the same notification for several users. */
  notifyMany(tx: Tx, userIds: readonly string[], message: NotificationMessage): Promise<void> {
    return this.guarded(tx, message, async () => {
      const external = this.externalChannels(message);
      // Set here rather than by the column default, which is the start of the transaction.
      const now = new Date();
      const rows = [...new Set(userIds)].flatMap((userId) => [
        {
          ...message,
          userId,
          channel: NotificationChannel.IN_APP,
          status: NotificationStatus.SENT,
          sentAt: now,
          createdAt: now,
        },
        ...external.map((channel) => ({
          ...message,
          userId,
          channel,
          status: NotificationStatus.PENDING,
          createdAt: now,
        })),
      ]);
      if (rows.length > 0) await tx.notification.createMany({ data: rows });
    });
  }

  /**
   * Records the same notification for everyone who has bid in an auction, optionally leaving some users
   * out (e.g. the winner, who gets a different message). One statement, however many bidders there are.
   */
  notifyBidders(
    tx: Tx,
    auctionId: string,
    message: NotificationMessage,
    except: readonly string[] = [],
  ): Promise<void> {
    return this.guarded(tx, message, async () => {
      const channels: string[] = [NotificationChannel.IN_APP, ...this.externalChannels(message)];
      const data = message.data === undefined ? null : JSON.stringify(message.data);
      const now = new Date();
      await tx.$executeRaw`
        INSERT INTO notifications (id, user_id, type, channel, status, title, body, data, sent_at, created_at)
        SELECT gen_random_uuid(), bidder.user_id, ${message.type}::"NotificationType",
               c.channel::"NotificationChannel",
               (CASE WHEN c.channel = 'IN_APP' THEN 'SENT' ELSE 'PENDING' END)::"NotificationStatus",
               ${message.title}, ${message.body}, ${data}::jsonb,
               CASE WHEN c.channel = 'IN_APP' THEN ${now}::timestamptz END, ${now}::timestamptz
        FROM (
          SELECT DISTINCT user_id FROM bids
          WHERE auction_id = ${auctionId}::uuid AND user_id::text <> ALL(${[...except]}::text[])
        ) AS bidder
        CROSS JOIN unnest(${channels}::text[]) AS c(channel)`;
    });
  }

  private externalChannels(message: NotificationMessage): NotificationChannel[] {
    return this.providers.filter((p) => p.accepts(message.type)).map((p) => p.channel);
  }

  private async guarded(tx: Tx, message: NotificationMessage, write: () => Promise<void>): Promise<void> {
    await tx.$executeRaw`SAVEPOINT notification`;
    try {
      await write();
      await tx.$executeRaw`RELEASE SAVEPOINT notification`;
    } catch (error) {
      // Undo only the failed write; without this PostgreSQL would refuse the rest of the caller's transaction.
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT notification`;
      this.logger.error(
        { err: error, type: message.type },
        'Recording a notification failed; the event itself is unaffected',
      );
    }
  }

  // ── The signed-in user's inbox ─────────────────────────────────────────────

  async listMine(userId: string, query: ListNotificationsQueryDto): Promise<NotificationPageDto> {
    const { page, limit, skip } = paging(query);
    const inbox: Prisma.NotificationWhereInput = { userId, channel: NotificationChannel.IN_APP };
    const where = { ...inbox, type: query.type, readAt: query.unreadOnly ? null : undefined };
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...inbox, readAt: null } }),
    ]);
    return { items: items.map(toDto), total, unread, page, limit };
  }

  async unreadCount(userId: string): Promise<{ unread: number }> {
    const unread = await this.prisma.notification.count({
      where: { userId, channel: NotificationChannel.IN_APP, readAt: null },
    });
    return { unread };
  }

  /** Marks one of the user's notifications as read. Reading it again changes nothing. */
  async markRead(userId: string, id: string): Promise<NotificationDto> {
    const inbox = { id, userId, channel: NotificationChannel.IN_APP };
    await this.prisma.notification.updateMany({
      where: { ...inbox, readAt: null },
      data: { readAt: new Date(), status: NotificationStatus.READ },
    });
    const notification = await this.prisma.notification.findFirst({ where: inbox });
    // Someone else's notification looks the same as one that does not exist.
    if (!notification) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Notification not found');
    return toDto(notification);
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, channel: NotificationChannel.IN_APP, readAt: null },
      data: { readAt: new Date(), status: NotificationStatus.READ },
    });
    return { updated: count };
  }
}
