import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ActorType, AuctionOutcome, AuctionStatus, NoUniqueBidPolicy } from '@prisma/client';
import type { AuctionResult, Prisma } from '@prisma/client';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { formatMinor } from '../../common/utils/money';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SUPPORTED_NO_UNIQUE_BID_POLICIES } from '../auctions/auction-policies';
import { BidRefundService } from '../bidding/bid-refund.service';
import { LEDGER_TX_OPTIONS } from '../ledger/ledger.service';
import { auctionEndedWithoutWinner, auctionEndedWithWinner, auctionWon } from '../notifications/notification-templates';
import { NotificationsService } from '../notifications/notifications.service';
import { MyBidOutcome } from './dto/result.dto';
import type {
  AdminAuctionResultDto,
  AuctionResultDto,
  MyAuctionResultDto,
  ResultAuditDto,
  ResultSnapshotDto,
} from './dto/result.dto';
import { ALGORITHM_VERSION, calculateResult } from './lowest-unique-bid';
import type { AmountCount, Calculation } from './lowest-unique-bid';

type Tx = Prisma.TransactionClient;

// A type alias, not an interface, so that it is assignable to Prisma's JSON input type.
type StoredHistogramEntry = { amountMinor: string; count: number };

const resultInclude = {
  auction: { select: { currency: true, bidFeesRefundedAt: true, currencyRef: { select: { minorUnits: true } } } },
} satisfies Prisma.AuctionResultInclude;
type ResultWithAuction = Prisma.AuctionResultGetPayload<{ include: typeof resultInclude }>;

const notFound = () => new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Auction not found');

function toResultDto(r: ResultWithAuction): AuctionResultDto {
  const minorUnits = r.auction.currencyRef.minorUnits;
  return {
    auctionId: r.auctionId,
    outcome: r.outcome,
    currency: r.auction.currency,
    minorUnits,
    winningAmountMinor: r.winningAmountMinor?.toString() ?? null,
    winningAmount: r.winningAmountMinor === null ? null : formatMinor(r.winningAmountMinor, minorUnits),
    totalBids: r.totalBids,
    appliedNoUniquePolicy: r.appliedNoUniquePolicy,
    bidFeesRefundedAt: r.auction.bidFeesRefundedAt,
    computedAt: r.computedAt,
  };
}

const snapshot = (
  r: Pick<AuctionResult, 'outcome' | 'winningAmountMinor' | 'winningBidId' | 'totalBids' | 'inputHash'>,
): ResultSnapshotDto => ({
  outcome: r.outcome,
  winningAmountMinor: r.winningAmountMinor?.toString() ?? null,
  winningBidId: r.winningBidId,
  totalBids: r.totalBids,
  inputHash: r.inputHash,
});

@Injectable()
export class ResultsService {
  private readonly logger = new Logger(ResultsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly refunds: BidRefundService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Computes and records the result of an auction whose bidding has ended, and marks it COMPLETED. Runs once
   * per auction: the auction row lock serializes concurrent calls and the later ones find it already completed.
   * Returns false if there was nothing to do.
   */
  async finalize(auctionId: string, actor?: { id: string; client: ClientInfo }): Promise<boolean> {
    const applied = await this.prisma.$transaction(async (tx) => {
      // Placing a bid holds this same row lock until it commits, so once the lock is ours every accepted bid
      // is committed and visible, and no further bid can get in: it would find the auction closed.
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM auctions WHERE id = ${auctionId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw notFound();
      const auction = await tx.auction.findUniqueOrThrow({
        where: { id: auctionId },
        include: { currencyRef: { select: { minorUnits: true } } },
      });
      if (auction.status === AuctionStatus.COMPLETED) return null;

      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const closedNow = auction.status === AuctionStatus.ACTIVE && auction.closesAt <= now;
      if (auction.status !== AuctionStatus.CLOSING && !closedNow) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.AUCTION_INVALID_STATE,
          auction.status === AuctionStatus.ACTIVE
            ? 'Bidding on this auction has not closed yet'
            : `An auction that is ${auction.status} cannot be finalized`,
          { status: auction.status, closesAt: auction.closesAt.toISOString(), serverTime: now.toISOString() },
        );
      }
      const policy = auction.noUniqueBidPolicy;
      if (policy === null || !SUPPORTED_NO_UNIQUE_BID_POLICIES.includes(policy)) {
        throw new AppException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ErrorCode.AUCTION_NOT_READY,
          'Choose what happens when there is no unique bid before this auction can be finalized',
          { noUniqueBidPolicy: policy },
        );
      }

      const { calculation, lastBidSequence } = await this.calculate(tx, auctionId);
      if (calculation.totalBids !== auction.totalBidCount) {
        throw new Error(
          `Auction ${auctionId} has ${calculation.totalBids} bids on record but a bid count of ${auction.totalBidCount}`,
        );
      }
      const winningBid = await this.winningBid(tx, auctionId, calculation);
      const appliedNoUniquePolicy = calculation.outcome === AuctionOutcome.NO_UNIQUE_BID ? policy : null;

      const result = await tx.auctionResult.create({
        data: {
          auctionId,
          outcome: calculation.outcome,
          appliedNoUniquePolicy,
          winningBidId: winningBid?.id,
          winningAmountMinor: calculation.winningAmountMinor,
          winnerUserId: winningBid?.userId,
          totalBids: calculation.totalBids,
          distinctAmounts: calculation.distinctAmounts,
          uniqueAmounts: calculation.uniqueAmounts,
          lastBidSequence,
          histogram: calculation.histogram.map((entry): StoredHistogramEntry => ({
            amountMinor: entry.amountMinor.toString(),
            count: entry.count,
          })),
          inputHash: calculation.inputHash,
          algorithmVersion: ALGORITHM_VERSION,
          computedAt: now,
        },
      });
      if (winningBid) {
        const winner = await tx.winner.create({
          data: {
            auctionId,
            userId: winningBid.userId,
            bidId: winningBid.id,
            amountMinor: winningBid.amountMinor,
            currency: auction.currency,
          },
        });
        const amount = {
          amountMinor: winningBid.amountMinor,
          currency: auction.currency,
          minorUnits: auction.currencyRef.minorUnits,
        };
        await this.notifications.notify(tx, winningBid.userId, auctionWon(auction, winner.id, amount));
        // The winning amount is public once the auction ends; who bid it is not part of the message.
        await this.notifications.notifyBidders(tx, auctionId, auctionEndedWithWinner(auction, amount), [
          winningBid.userId,
        ]);
      } else if (appliedNoUniquePolicy) {
        await this.notifications.notifyBidders(
          tx,
          auctionId,
          auctionEndedWithoutWinner(auction, appliedNoUniquePolicy),
        );
      }
      await tx.auction.update({
        where: { id: auctionId },
        data: {
          status: AuctionStatus.COMPLETED,
          closedAt: auction.closedAt ?? now,
          completedAt: now,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        actorId: actor?.id,
        actorType: actor ? ActorType.ADMIN : ActorType.SYSTEM,
        action: 'auction.finalize',
        entityType: 'auction',
        entityId: auctionId,
        before: { status: auction.status },
        after: { status: AuctionStatus.COMPLETED },
        metadata: { ...snapshot(result), appliedNoUniquePolicy, algorithmVersion: ALGORITHM_VERSION },
        client: actor?.client,
      });
      return { appliedNoUniquePolicy };
    }, LEDGER_TX_OPTIONS);

    if (applied?.appliedNoUniquePolicy === NoUniqueBidPolicy.REFUND_BID_FEES) {
      try {
        // The result is committed. If refunding is interrupted, the background job finishes it.
        await this.refunds.refundAuction(auctionId);
      } catch (error) {
        this.logger.error({ err: error, auctionId }, 'Refunding bid fees failed; the background job will retry');
      }
    }
    return applied !== null;
  }

  /** Finalizes every auction whose bidding has ended. One failing auction does not hold up the others. */
  async finalizeDue(): Promise<string[]> {
    const due = await this.prisma.auction.findMany({
      where: { status: AuctionStatus.CLOSING },
      select: { id: true },
      orderBy: { closesAt: 'asc' },
      take: 20,
    });
    const finalized: string[] = [];
    for (const { id } of due) {
      try {
        if (await this.finalize(id)) finalized.push(id);
      } catch (error) {
        this.logger.error({ err: error, auctionId: id }, 'Finalizing an auction failed; it will be retried');
      }
    }
    return finalized;
  }

  async getPublic(auctionId: string): Promise<AuctionResultDto> {
    return toResultDto(await this.load(auctionId, true));
  }

  /** The public result plus how each of the caller's own bids fared. */
  async getMine(userId: string, auctionId: string): Promise<MyAuctionResultDto> {
    const result = await this.load(auctionId, true);
    const bids = await this.prisma.bid.findMany({
      where: { auctionId, userId },
      orderBy: [{ amountMinor: 'asc' }, { sequence: 'asc' }],
    });
    const counts = new Map(
      (result.histogram as unknown as StoredHistogramEntry[]).map((entry) => [entry.amountMinor, entry.count]),
    );
    const minorUnits = result.auction.currencyRef.minorUnits;
    return {
      ...toResultDto(result),
      won: result.winnerUserId === userId,
      bids: bids.map((bid) => ({
        id: bid.id,
        amountMinor: bid.amountMinor.toString(),
        amount: formatMinor(bid.amountMinor, minorUnits),
        outcome:
          bid.id === result.winningBidId
            ? MyBidOutcome.WINNING
            : counts.get(bid.amountMinor.toString()) === 1
              ? MyBidOutcome.UNIQUE_NOT_LOWEST
              : MyBidOutcome.NOT_UNIQUE,
        createdAt: bid.createdAt,
      })),
    };
  }

  async getForAdmin(auctionId: string): Promise<AdminAuctionResultDto> {
    const result = await this.load(auctionId, false);
    const winner = await this.prisma.winner.findUnique({
      where: { auctionId },
      include: { user: { select: { phoneNumber: true } } },
    });
    const minorUnits = result.auction.currencyRef.minorUnits;
    return {
      ...toResultDto(result),
      distinctAmounts: result.distinctAmounts,
      uniqueAmounts: result.uniqueAmounts,
      lastBidSequence: result.lastBidSequence?.toString() ?? null,
      algorithmVersion: result.algorithmVersion,
      inputHash: result.inputHash,
      histogram: (result.histogram as unknown as StoredHistogramEntry[]).map((entry) => ({
        amountMinor: entry.amountMinor,
        amount: formatMinor(BigInt(entry.amountMinor), minorUnits),
        count: entry.count,
      })),
      winner: winner && {
        id: winner.id,
        userId: winner.userId,
        phoneNumber: winner.user.phoneNumber,
        bidId: winner.bidId,
        verificationStatus: winner.verificationStatus,
      },
    };
  }

  /** Recomputes the result from the bids on record and compares it with what was recorded at finalization. */
  async auditResult(auctionId: string, tx?: Tx): Promise<ResultAuditDto> {
    const recorded = await this.load(auctionId, false, tx);
    const recompute = async (t: Tx) => {
      const computed = await this.calculate(t, auctionId);
      return { ...computed, winningBid: await this.winningBid(t, auctionId, computed.calculation) };
    };
    // A caller already inside a transaction passes it, so the check reads through that connection.
    const { calculation, winningBid } = await (tx ? recompute(tx) : this.prisma.$transaction(recompute));
    const recomputed: ResultSnapshotDto = {
      outcome: calculation.outcome,
      winningAmountMinor: calculation.winningAmountMinor?.toString() ?? null,
      winningBidId: winningBid?.id ?? null,
      totalBids: calculation.totalBids,
      inputHash: calculation.inputHash,
    };
    const stored = snapshot(recorded);
    return {
      auctionId,
      matches: (Object.keys(stored) as (keyof ResultSnapshotDto)[]).every((key) => stored[key] === recomputed[key]),
      recorded: stored,
      recomputed,
      checkedAt: new Date(),
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async load(auctionId: string, publicOnly: boolean, client: Tx = this.prisma): Promise<ResultWithAuction> {
    const auction = await client.auction.findUnique({
      where: { id: auctionId },
      select: { status: true, activatedAt: true },
    });
    const hidden =
      auction !== null &&
      publicOnly &&
      (auction.status === AuctionStatus.DRAFT ||
        (auction.status === AuctionStatus.CANCELLED && auction.activatedAt === null));
    if (!auction || hidden) throw notFound();
    const result = await client.auctionResult.findUnique({ where: { auctionId }, include: resultInclude });
    if (!result) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.RESULT_NOT_AVAILABLE,
        auction.status === AuctionStatus.CANCELLED
          ? 'This auction was cancelled and has no result'
          : 'The result of this auction is not available yet',
        { status: auction.status },
      );
    }
    return result;
  }

  private async calculate(
    tx: Tx,
    auctionId: string,
  ): Promise<{ calculation: Calculation; lastBidSequence: bigint | null }> {
    const counts = await tx.$queryRaw<AmountCount[]>`
      SELECT amount_minor AS "amountMinor", count(*)::int AS count
      FROM bids WHERE auction_id = ${auctionId}::uuid
      GROUP BY amount_minor ORDER BY amount_minor`;
    const last = await tx.bid.aggregate({ where: { auctionId }, _max: { sequence: true } });
    return { calculation: calculateResult(counts), lastBidSequence: last._max.sequence };
  }

  private async winningBid(tx: Tx, auctionId: string, calculation: Calculation) {
    if (calculation.winningAmountMinor === null) return null;
    const bids = await tx.bid.findMany({
      where: { auctionId, amountMinor: calculation.winningAmountMinor },
      select: { id: true, userId: true, amountMinor: true },
      take: 2,
    });
    if (bids.length !== 1) throw new Error(`Auction ${auctionId}: the winning amount is not held by exactly one bid`);
    return bids[0];
  }
}
