import { Injectable, Logger } from '@nestjs/common';
import { ActorType, AuctionStatus } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LEDGER_TX_OPTIONS } from '../ledger/ledger.service';
import { WalletService } from '../wallet/wallet.service';

const BATCH_SIZE = 100;

export interface RefundRun {
  /** Bid requests refunded by this call. */
  refunded: number;
  /** True once no bid fee of the auction is left to refund. */
  complete: boolean;
}

/** Returns the bid fees of a cancelled auction to the bidders' wallets. */
@Injectable()
export class BidRefundService {
  private readonly logger = new Logger(BidRefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Refunds every paid bid request of a cancelled auction, one wallet credit per request, in batches.
   * Safe to call repeatedly and from several instances: each request is refunded exactly once, and an
   * interrupted run is finished by the next call.
   */
  async refundAuction(auctionId: string): Promise<RefundRun> {
    let refunded = 0;
    for (;;) {
      const batch = await this.refundBatch(auctionId);
      refunded += batch.refunded;
      if (batch.complete || batch.refunded === 0) return { refunded, complete: batch.complete };
    }
  }

  /** Finishes refunds that a cancellation started but did not complete (e.g. the server stopped midway). */
  async refundPending(): Promise<void> {
    const auctions = await this.prisma.auction.findMany({
      where: { status: AuctionStatus.CANCELLED, totalBidCount: { gt: 0 }, bidFeesRefundedAt: null },
      select: { id: true },
      take: 10,
    });
    for (const { id } of auctions) {
      try {
        await this.refundAuction(id);
      } catch (error) {
        this.logger.error({ err: error, auctionId: id }, 'Refunding a cancelled auction failed; it will be retried');
      }
    }
  }

  private refundBatch(auctionId: string): Promise<RefundRun> {
    return this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`bid-refund:${auctionId}`}, 0)) AS locked`;
      if (!locked) return { refunded: 0, complete: false }; // another run is refunding this auction

      const auction = await tx.auction.findUnique({ where: { id: auctionId } });
      if (!auction || auction.status !== AuctionStatus.CANCELLED) {
        throw new Error(`Auction ${auctionId} is not cancelled; its bid fees cannot be refunded`);
      }
      if (auction.bidFeesRefundedAt) return { refunded: 0, complete: true };

      const pending = await tx.$queryRaw<{ id: string; user_id: string; total_fee_minor: bigint }[]>`
        SELECT s.id, s.user_id, s.total_fee_minor
        FROM bid_submissions s
        WHERE s.auction_id = ${auctionId}::uuid
          AND NOT EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.idempotency_key = 'bid-refund:' || s.id::text)
        ORDER BY s.created_at, s.id
        LIMIT ${BATCH_SIZE}`;

      for (const submission of pending) {
        await this.wallets.refund(
          {
            userId: submission.user_id,
            amountMinor: submission.total_fee_minor,
            currency: auction.currency,
            idempotencyKey: `bid-refund:${submission.id}`,
            description: `Bid fee refund: "${auction.title}" was cancelled`,
            metadata: { auctionId, bidSubmissionId: submission.id },
          },
          tx,
        );
      }
      if (pending.length === BATCH_SIZE) return { refunded: pending.length, complete: false };

      const totals = await tx.bidSubmission.aggregate({
        where: { auctionId },
        _count: true,
        _sum: { totalFeeMinor: true },
      });
      await tx.auction.update({ where: { id: auctionId }, data: { bidFeesRefundedAt: new Date() } });
      await this.audit.record(tx, {
        actorType: ActorType.SYSTEM,
        action: 'auction.bid-fees-refunded',
        entityType: 'auction',
        entityId: auctionId,
        metadata: {
          submissions: totals._count,
          totalFeeMinor: (totals._sum.totalFeeMinor ?? 0n).toString(),
          currency: auction.currency,
        },
      });
      return { refunded: pending.length, complete: true };
    }, LEDGER_TX_OPTIONS);
  }
}
