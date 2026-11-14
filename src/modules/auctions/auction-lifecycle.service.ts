import { Inject, Injectable } from '@nestjs/common';
import { ActorType } from '@prisma/client';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { closingReminder } from '../notifications/notification-templates';
import { NotificationsService } from '../notifications/notifications.service';

export interface LifecycleSweep {
  /** Auctions opened for bidding (SCHEDULED → ACTIVE). */
  activated: string[];
  /** Auctions whose bidding ended (ACTIVE → CLOSING). */
  closing: string[];
}

/**
 * The sweep waits its turn for a database connection as long as a bid does. With the default 2 seconds it lost
 * its turn whenever many bids were queued, which is exactly when an auction is about to close.
 */
const SWEEP_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

@Injectable()
export class AuctionLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Opens every scheduled auction whose opening time has come and closes bidding on every active auction whose
   * closing time has passed, judged by the database clock. Safe to call at any time and from several instances.
   */
  syncDue(): Promise<LifecycleSweep> {
    return this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext('auction-lifecycle-sweep')) AS locked`;
      if (!locked) return { activated: [], closing: [] }; // another sweep is in progress

      const activated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE auctions
        SET status = 'ACTIVE'::"AuctionStatus", activated_at = now(), version = version + 1, updated_at = now()
        WHERE status = 'SCHEDULED'::"AuctionStatus" AND opens_at <= now()
        RETURNING id`;
      const closing = await tx.$queryRaw<{ id: string }[]>`
        UPDATE auctions
        SET status = 'CLOSING'::"AuctionStatus", closed_at = now(), version = version + 1, updated_at = now()
        WHERE status = 'ACTIVE'::"AuctionStatus" AND closes_at <= now()
        RETURNING id`;

      const audit = (action: string, rows: { id: string }[]) =>
        rows.map(({ id }) => ({ actorType: ActorType.SYSTEM, action, entityType: 'auction', entityId: id }));
      const records = [...audit('auction.activate', activated), ...audit('auction.close', closing)];
      if (records.length > 0) await tx.auditLog.createMany({ data: records });

      return { activated: activated.map((r) => r.id), closing: closing.map((r) => r.id) };
    }, SWEEP_TX_OPTIONS);
  }

  /**
   * Reminds the bidders of every running auction that closes within the configured time. Each auction is
   * reminded once: the auction row records it in the same transaction as the notifications. An auction
   * shorter than the reminder time gets no reminder.
   */
  async sendClosingReminders(): Promise<string[]> {
    const minutes = this.config.auctions.closingReminderMinutes;
    if (minutes <= 0) return [];
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<{ id: string; title: string; closes_at: Date }[]>`
        UPDATE auctions
        SET closing_reminder_sent_at = now()
        WHERE status = 'ACTIVE'::"AuctionStatus" AND closing_reminder_sent_at IS NULL
          AND closes_at > now() AND closes_at <= now() + make_interval(mins => ${minutes}::int)
          AND closes_at - make_interval(mins => ${minutes}::int) >= COALESCE(activated_at, opens_at)
        RETURNING id, title, closes_at`;
      for (const auction of due) {
        await this.notifications.notifyBidders(tx, auction.id, closingReminder(auction, auction.closes_at, minutes));
      }
      return due.map((auction) => auction.id);
    }, SWEEP_TX_OPTIONS);
  }
}
