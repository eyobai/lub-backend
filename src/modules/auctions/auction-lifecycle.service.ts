import { Injectable } from '@nestjs/common';
import { ActorType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface LifecycleSweep {
  /** Auctions opened for bidding (SCHEDULED → ACTIVE). */
  activated: string[];
  /** Auctions whose bidding ended (ACTIVE → CLOSING). */
  closing: string[];
}

@Injectable()
export class AuctionLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

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
    });
  }
}
