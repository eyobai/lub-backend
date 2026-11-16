import { HttpStatus, Injectable } from '@nestjs/common';
import { ActorType, AuctionStatus, DuplicateBidPolicy, EntryDirection } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { paging } from '../../common/dto/page-query.dto';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { isStaff } from '../../common/roles';
import { formatMinor } from '../../common/utils/money';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LEDGER_TX_OPTIONS } from '../ledger/ledger.service';
import { bidSubmitted, lowBalance } from '../notifications/notification-templates';
import { NotificationsService } from '../notifications/notifications.service';
import { WalletService } from '../wallet/wallet.service';
import type {
  AdminBidPageDto,
  AdminListBidsQueryDto,
  BidSubmissionDto,
  ListMyBidsQueryDto,
  MyBidPageDto,
} from './dto/bid.dto';

type Tx = Prisma.TransactionClient;

const submissionInclude = {
  bids: { orderBy: { sequence: 'asc' } },
  auction: { select: { currency: true, currencyRef: { select: { minorUnits: true } } } },
  walletTransaction: { include: { entries: { where: { direction: EntryDirection.DEBIT } } } },
} satisfies Prisma.BidSubmissionInclude;
type SubmissionWithRelations = Prisma.BidSubmissionGetPayload<{ include: typeof submissionInclude }>;

function toSubmissionDto(s: SubmissionWithRelations): BidSubmissionDto {
  const minorUnits = s.auction.currencyRef.minorUnits;
  const money = (value: bigint) => formatMinor(value, minorUnits);
  // The debit line of the fee journal is the bidder's wallet; it carries the balance right after the charge.
  const balanceAfter = s.walletTransaction.entries[0].balanceAfterMinor;
  return {
    id: s.id,
    auctionId: s.auctionId,
    currency: s.auction.currency,
    minorUnits,
    bidCount: s.bidCount,
    bidFeeMinor: s.bidFeeMinor.toString(),
    bidFee: money(s.bidFeeMinor),
    totalFeeMinor: s.totalFeeMinor.toString(),
    totalFee: money(s.totalFeeMinor),
    transactionId: s.walletTransactionId,
    transactionReference: s.walletTransaction.reference,
    walletAvailableMinor: balanceAfter.toString(),
    walletAvailable: money(balanceAfter),
    bids: s.bids.map((b) => ({
      id: b.id,
      amountMinor: b.amountMinor.toString(),
      amount: money(b.amountMinor),
      createdAt: b.createdAt,
    })),
    createdAt: s.createdAt,
  };
}

const notFound = () => new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Auction not found');

@Injectable()
export class BiddingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Records one bid per amount and charges the fees, as a single database transaction: either every bid
   * exists and the wallet was debited once, or nothing happened. Nothing in the request is trusted except
   * the amounts themselves; fee, status and deadline come from the locked auction row and the database clock.
   */
  async place(
    user: AuthenticatedUser,
    auctionId: string,
    amounts: string[],
    idempotencyKey: string,
    client: ClientInfo,
  ): Promise<{ submission: BidSubmissionDto; replayed: boolean }> {
    if (isStaff(user.roles)) {
      // Staff can see every bid of an auction, so they must not take part in one.
      throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, 'Staff accounts cannot place bids');
    }
    const amountsMinor = amounts.map((amount) => BigInt(amount));

    return this.prisma.$transaction(async (tx) => {
      // Same-key requests from one user run one at a time, so a retry sees the finished first attempt.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`bid:${user.id}:${idempotencyKey}`}, 0))::text`;
      const earlier = await tx.bidSubmission.findUnique({
        where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
        include: submissionInclude,
      });
      if (earlier) {
        const same =
          earlier.auctionId === auctionId &&
          earlier.bids.length === amountsMinor.length &&
          earlier.bids.every((bid, i) => bid.amountMinor === amountsMinor[i]);
        if (!same) {
          throw new AppException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This idempotency key was already used for a different request',
          );
        }
        return { submission: toSubmissionDto(earlier), replayed: true };
      }

      const { auction, rejectDuplicates } = await this.checkAmounts(tx, user.id, auctionId, amountsMinor);

      const count = amountsMinor.length;
      const totalFeeMinor = auction.bidFeeMinor * BigInt(count);
      // Throws INSUFFICIENT_FUNDS or WALLET_FROZEN, which rolls the whole transaction back.
      const charge = await this.wallets.chargeBidFee(
        {
          userId: user.id,
          amountMinor: totalFeeMinor,
          currency: auction.currency,
          idempotencyKey: createHash('sha256').update(`bid|${user.id}|${idempotencyKey}`).digest('hex'),
          description: `Bid fee: ${count} ${count === 1 ? 'bid' : 'bids'} in "${auction.title}"`,
          metadata: { auctionId, bidCount: count },
          createdById: user.id,
        },
        tx,
      );
      if (charge.replayed) throw new Error('Bid fee was already charged for a submission that does not exist');

      const { id } = await tx.bidSubmission.create({
        data: {
          auctionId,
          userId: user.id,
          idempotencyKey,
          bidCount: count,
          bidFeeMinor: auction.bidFeeMinor,
          totalFeeMinor,
          walletTransactionId: charge.transaction.id,
          ipAddress: client.ipAddress,
        },
      });
      await tx.bid.createMany({
        data: amountsMinor.map((amountMinor) => ({
          auctionId,
          userId: user.id,
          submissionId: id,
          amountMinor,
          dedupeAmountMinor: rejectDuplicates ? amountMinor : null,
        })),
      });
      await tx.$executeRaw`UPDATE auctions SET total_bid_count = total_bid_count + ${count} WHERE id = ${auctionId}::uuid`;

      const submission = await tx.bidSubmission.findUniqueOrThrow({ where: { id }, include: submissionInclude });

      const money = (amountMinor: bigint) => ({
        amountMinor,
        currency: auction.currency,
        minorUnits: submission.auction.currencyRef.minorUnits,
      });
      await this.notifications.notify(tx, user.id, bidSubmitted(auction, id, count, money(totalFeeMinor)));
      const balanceMinor = submission.walletTransaction.entries[0]?.balanceAfterMinor;
      if (balanceMinor !== undefined && balanceMinor < auction.bidFeeMinor) {
        await this.notifications.notify(tx, user.id, lowBalance(money(balanceMinor), money(auction.bidFeeMinor)));
      }
      return { submission: toSubmissionDto(submission), replayed: false };
    }, LEDGER_TX_OPTIONS);
  }

  /**
   * Whether these bids would be accepted right now, without placing them or charging anything. Used before a
   * payment is opened for them, so nobody pays for bids that are refused. The same rules run again when the
   * bids are placed.
   */
  async check(
    user: AuthenticatedUser,
    auctionId: string,
    amountsMinor: bigint[],
  ): Promise<{ title: string; currency: string; bidFeeMinor: bigint }> {
    if (isStaff(user.roles)) {
      throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, 'Staff accounts cannot place bids');
    }
    const { auction } = await this.prisma.$transaction((tx) => this.checkAmounts(tx, user.id, auctionId, amountsMinor));
    return { title: auction.title, currency: auction.currency, bidFeeMinor: auction.bidFeeMinor };
  }

  /** The rules every submission must pass, read under the auction row lock. Throws the first one broken. */
  private async checkAmounts(tx: Tx, userId: string, auctionId: string, amountsMinor: bigint[]) {
    const auction = await this.openAuction(tx, auctionId);

    const invalid = amountsMinor.filter(
      (a) =>
        a < auction.minBidMinor || a > auction.maxBidMinor || (a - auction.minBidMinor) % auction.bidStepMinor !== 0n,
    );
    if (invalid.length > 0) {
      throw new AppException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.BID_AMOUNT_INVALID,
        'Some amounts are outside the range this auction accepts',
        {
          invalidAmountsMinor: invalid.map(String),
          minBidMinor: auction.minBidMinor.toString(),
          maxBidMinor: auction.maxBidMinor.toString(),
          bidStepMinor: auction.bidStepMinor.toString(),
        },
      );
    }
    if (amountsMinor.length > auction.maxBidsPerRequest) {
      throw new AppException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.BID_LIMIT_EXCEEDED,
        `This auction accepts at most ${auction.maxBidsPerRequest} bids per request`,
        { maxBidsPerRequest: auction.maxBidsPerRequest },
      );
    }
    if (auction.maxBidsPerUser !== null) {
      // Exact under the auction row lock: nobody else can add bids to this auction right now.
      const placed = await tx.bid.count({ where: { auctionId, userId: userId } });
      if (placed + amountsMinor.length > auction.maxBidsPerUser) {
        throw new AppException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ErrorCode.BID_LIMIT_EXCEEDED,
          `This auction allows ${auction.maxBidsPerUser} bids per user`,
          {
            maxBidsPerUser: auction.maxBidsPerUser,
            placed,
            remaining: Math.max(auction.maxBidsPerUser - placed, 0),
          },
        );
      }
    }
    const rejectDuplicates = auction.duplicateBidPolicy === DuplicateBidPolicy.REJECT_SAME_USER_SAME_AMOUNT;
    if (rejectDuplicates) {
      const repeated = await tx.bid.findMany({
        where: { auctionId, userId: userId, amountMinor: { in: amountsMinor } },
        select: { amountMinor: true },
        orderBy: { amountMinor: 'asc' },
      });
      if (repeated.length > 0) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.DUPLICATE_BID,
          'You have already bid some of these amounts in this auction',
          { amountsMinor: repeated.map((bid) => bid.amountMinor.toString()) },
        );
      }
    }
    return { auction, rejectDuplicates };
  }

  /** The signed-in user's own bids, newest first. Other users' amounts are never returned. */
  async listMine(userId: string, query: ListMyBidsQueryDto): Promise<MyBidPageDto> {
    const { page, limit, skip } = paging(query);
    const where: Prisma.BidWhereInput = { userId, auctionId: query.auctionId };
    const [bids, total] = await Promise.all([
      this.prisma.bid.findMany({
        where,
        include: {
          auction: {
            select: { title: true, status: true, currency: true, currencyRef: { select: { minorUnits: true } } },
          },
          submission: { select: { bidFeeMinor: true } },
        },
        orderBy: { sequence: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.bid.count({ where }),
    ]);
    return {
      items: bids.map((b) => {
        const money = (value: bigint) => formatMinor(value, b.auction.currencyRef.minorUnits);
        return {
          id: b.id,
          amountMinor: b.amountMinor.toString(),
          amount: money(b.amountMinor),
          createdAt: b.createdAt,
          auctionId: b.auctionId,
          auctionTitle: b.auction.title,
          auctionStatus: b.auction.status,
          currency: b.auction.currency,
          submissionId: b.submissionId,
          bidFeeMinor: b.submission.bidFeeMinor.toString(),
          bidFee: money(b.submission.bidFeeMinor),
        };
      }),
      total,
      page,
      limit,
    };
  }

  /** Back office: every bid of an auction, in the order it was accepted. */
  async listForAuction(auctionId: string, query: AdminListBidsQueryDto): Promise<AdminBidPageDto> {
    const auction = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      select: { currencyRef: { select: { minorUnits: true } } },
    });
    if (!auction) throw notFound();
    const { page, limit, skip } = paging(query);
    const where: Prisma.BidWhereInput = {
      auctionId,
      userId: query.userId,
      amountMinor: query.amountMinor === undefined ? undefined : BigInt(query.amountMinor),
    };
    const [bids, total] = await Promise.all([
      this.prisma.bid.findMany({
        where,
        include: { user: { select: { phoneNumber: true } } },
        orderBy: { sequence: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.bid.count({ where }),
    ]);
    return {
      items: bids.map((b) => ({
        id: b.id,
        sequence: b.sequence.toString(),
        amountMinor: b.amountMinor.toString(),
        amount: formatMinor(b.amountMinor, auction.currencyRef.minorUnits),
        userId: b.userId,
        phoneNumber: b.user.phoneNumber,
        submissionId: b.submissionId,
        createdAt: b.createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Row-locks the auction and returns it only if bids may be accepted right now. The lock makes bids on one
   * auction take turns, and makes the close of bidding wait for (or shut out) any bid in flight.
   */
  private async openAuction(tx: Tx, auctionId: string) {
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM auctions WHERE id = ${auctionId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw notFound();
    const auction = await tx.auction.findUniqueOrThrow({ where: { id: auctionId } });
    // Read after the lock is held, so time spent queueing counts against the deadline.
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;

    const hidden =
      auction.status === AuctionStatus.DRAFT ||
      (auction.status === AuctionStatus.CANCELLED && auction.activatedAt === null);
    if (hidden) throw notFound();

    if (auction.status === AuctionStatus.SCHEDULED) {
      if (auction.opensAt > now) {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.AUCTION_NOT_OPEN, 'This auction has not opened yet', {
          opensAt: auction.opensAt.toISOString(),
          serverTime: now.toISOString(),
        });
      }
      // The opening time has passed but the background job has not flipped the status yet: open it here.
      await tx.auction.update({
        where: { id: auctionId },
        data: { status: AuctionStatus.ACTIVE, activatedAt: now, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        actorType: ActorType.SYSTEM,
        action: 'auction.activate',
        entityType: 'auction',
        entityId: auctionId,
      });
    } else if (auction.status !== AuctionStatus.ACTIVE) {
      throw new AppException(HttpStatus.CONFLICT, ErrorCode.AUCTION_CLOSED, 'This auction no longer accepts bids', {
        status: auction.status,
      });
    }
    if (auction.closesAt <= now) {
      throw new AppException(HttpStatus.CONFLICT, ErrorCode.AUCTION_CLOSED, 'Bidding on this auction has closed', {
        closesAt: auction.closesAt.toISOString(),
        serverTime: now.toISOString(),
      });
    }
    return auction;
  }
}
