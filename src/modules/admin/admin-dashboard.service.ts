import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { STAFF_ROLES } from '../../common/roles';
import { formatMinor } from '../../common/utils/money';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuctionStatisticsDto, DashboardDto, DashboardMoneyDto } from './dto/dashboard.dto';

type Counts = Record<string, bigint>;
interface MoneyRow {
  code: string;
  minor_units: number;
  revenue: bigint;
  revenue_24h: bigint;
  revenue_7d: bigint;
  revenue_30d: bigint;
  wallet_balances: bigint;
  held_balances: bigint;
}

/** Figures for the back-office home page. Everything is read in one snapshot, so the numbers agree with each other. */
@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  dashboard(): Promise<DashboardDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const one = async (query: Prisma.Sql): Promise<Counts> => (await tx.$queryRaw<Counts[]>(query))[0];
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;

        const users = await one(Prisma.sql`
          SELECT count(*) AS total,
                 count(*) FILTER (WHERE status = 'ACTIVE') AS active,
                 count(*) FILTER (WHERE status = 'SUSPENDED') AS suspended,
                 count(*) FILTER (WHERE status = 'BLOCKED') AS blocked,
                 count(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS new_24h,
                 count(*) FILTER (WHERE created_at >= now() - interval '7 days') AS new_7d,
                 count(*) FILTER (WHERE created_at >= now() - interval '30 days') AS new_30d
          FROM users`);
        const staff = await tx.user.count({ where: { roles: { some: { role: { name: { in: [...STAFF_ROLES] } } } } } });
        const auctions = await one(Prisma.sql`
          SELECT count(*) FILTER (WHERE status = 'DRAFT') AS draft,
                 count(*) FILTER (WHERE status = 'SCHEDULED') AS scheduled,
                 count(*) FILTER (WHERE status = 'ACTIVE') AS active,
                 count(*) FILTER (WHERE status = 'CLOSING') AS closing,
                 count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
                 count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled
          FROM auctions`);
        const bids = await one(Prisma.sql`
          SELECT count(*) AS total,
                 count(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS last_24h,
                 count(*) FILTER (WHERE created_at >= now() - interval '7 days') AS last_7d,
                 count(*) FILTER (WHERE created_at >= now() - interval '30 days') AS last_30d
          FROM bids`);
        const winners = await one(Prisma.sql`
          SELECT count(*) FILTER (WHERE verification_status = 'PENDING_VERIFICATION') AS pending,
                 count(*) FILTER (WHERE verification_status = 'VERIFIED') AS verified,
                 count(*) FILTER (WHERE verification_status = 'REJECTED') AS rejected,
                 count(*) FILTER (WHERE published_at IS NOT NULL) AS published
          FROM winners`);
        const deliveries = await one(Prisma.sql`
          SELECT count(*) FILTER (WHERE status = 'PENDING') AS pending,
                 count(*) FILTER (WHERE status = 'CONTACTED') AS contacted,
                 count(*) FILTER (WHERE status = 'VERIFIED') AS verified,
                 count(*) FILTER (WHERE status = 'DISPATCHED') AS dispatched,
                 count(*) FILTER (WHERE status = 'DELIVERED') AS delivered,
                 count(*) FILTER (WHERE status = 'DISPUTED') AS disputed
          FROM prize_deliveries`);
        const frozenWallets = await tx.wallet.count({ where: { isFrozen: true } });

        // Revenue is credit-normal: a bid fee credits it, a refund debits it.
        const money = await tx.$queryRaw<MoneyRow[]>`
          SELECT c.code, c.minor_units,
                 COALESCE(b.revenue, 0)::bigint AS revenue,
                 COALESCE(r.d1, 0)::bigint AS revenue_24h,
                 COALESCE(r.d7, 0)::bigint AS revenue_7d,
                 COALESCE(r.d30, 0)::bigint AS revenue_30d,
                 COALESCE(b.wallet_balances, 0)::bigint AS wallet_balances,
                 COALESCE(b.held_balances, 0)::bigint AS held_balances
          FROM currencies c
          LEFT JOIN (
            SELECT currency,
                   sum(balance_minor) FILTER (WHERE type = 'PLATFORM_REVENUE') AS revenue,
                   sum(balance_minor) FILTER (WHERE type = 'USER_WALLET') AS wallet_balances,
                   sum(balance_minor) FILTER (WHERE type = 'USER_WALLET_HOLD') AS held_balances
            FROM ledger_accounts GROUP BY currency
          ) b ON b.currency = c.code
          LEFT JOIN (
            SELECT a.currency,
                   sum(s.amount) FILTER (WHERE e.created_at >= now() - interval '24 hours') AS d1,
                   sum(s.amount) FILTER (WHERE e.created_at >= now() - interval '7 days') AS d7,
                   sum(s.amount) AS d30
            FROM ledger_entries e
            JOIN ledger_accounts a ON a.id = e.account_id AND a.type = 'PLATFORM_REVENUE'
            CROSS JOIN LATERAL (
              SELECT CASE WHEN e.direction = 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END AS amount
            ) s
            WHERE e.created_at >= now() - interval '30 days'
            GROUP BY a.currency
          ) r ON r.currency = c.code
          WHERE c.is_active
          ORDER BY c.code`;

        const n = (value: bigint | undefined) => Number(value ?? 0n);
        return {
          generatedAt: clock.now,
          users: {
            total: n(users.total),
            active: n(users.active),
            suspended: n(users.suspended),
            blocked: n(users.blocked),
            staff,
            newLast24h: n(users.new_24h),
            newLast7d: n(users.new_7d),
            newLast30d: n(users.new_30d),
          },
          auctions: {
            draft: n(auctions.draft),
            scheduled: n(auctions.scheduled),
            active: n(auctions.active),
            closing: n(auctions.closing),
            completed: n(auctions.completed),
            cancelled: n(auctions.cancelled),
          },
          bids: {
            total: n(bids.total),
            last24h: n(bids.last_24h),
            last7d: n(bids.last_7d),
            last30d: n(bids.last_30d),
          },
          winners: {
            pendingVerification: n(winners.pending),
            verified: n(winners.verified),
            rejected: n(winners.rejected),
            published: n(winners.published),
          },
          deliveries: {
            pending: n(deliveries.pending),
            contacted: n(deliveries.contacted),
            verified: n(deliveries.verified),
            dispatched: n(deliveries.dispatched),
            delivered: n(deliveries.delivered),
            disputed: n(deliveries.disputed),
          },
          frozenWallets,
          money: money.map((row) => this.toMoney(row)),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async auctionStatistics(auctionId: string): Promise<AuctionStatisticsDto> {
    const auction = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      include: { currencyRef: true },
    });
    if (!auction) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Auction not found');

    const [[bids], [submissions]] = await Promise.all([
      this.prisma.$queryRaw<
        {
          bid_count: bigint;
          bidder_count: bigint;
          distinct_amounts: bigint;
          unique_amounts: bigint;
          lowest: bigint | null;
          highest: bigint | null;
          first_at: Date | null;
          last_at: Date | null;
        }[]
      >`
        SELECT COALESCE(sum(g.bids), 0)::bigint AS bid_count,
               (SELECT count(DISTINCT user_id) FROM bids WHERE auction_id = ${auctionId}::uuid) AS bidder_count,
               count(*) AS distinct_amounts,
               count(*) FILTER (WHERE g.bids = 1) AS unique_amounts,
               min(g.amount_minor) AS lowest,
               max(g.amount_minor) AS highest,
               min(g.first_at) AS first_at,
               max(g.last_at) AS last_at
        FROM (
          SELECT amount_minor, count(*) AS bids, min(created_at) AS first_at, max(created_at) AS last_at
          FROM bids WHERE auction_id = ${auctionId}::uuid GROUP BY amount_minor
        ) g`,
      this.prisma.$queryRaw<{ submissions: bigint; fees: bigint }[]>`
        SELECT count(*) AS submissions, COALESCE(sum(total_fee_minor), 0)::bigint AS fees
        FROM bid_submissions WHERE auction_id = ${auctionId}::uuid`,
    ]);

    const minorUnits = auction.currencyRef.minorUnits;
    return {
      auctionId,
      status: auction.status,
      currency: auction.currency,
      minorUnits,
      bidCount: Number(bids.bid_count),
      bidderCount: Number(bids.bidder_count),
      submissionCount: Number(submissions.submissions),
      distinctAmounts: Number(bids.distinct_amounts),
      uniqueAmounts: Number(bids.unique_amounts),
      lowestBidMinor: bids.lowest?.toString() ?? null,
      highestBidMinor: bids.highest?.toString() ?? null,
      feesChargedMinor: submissions.fees.toString(),
      feesCharged: formatMinor(submissions.fees, minorUnits),
      feesRefunded: auction.bidFeesRefundedAt !== null,
      firstBidAt: bids.first_at,
      lastBidAt: bids.last_at,
    };
  }

  private toMoney(row: MoneyRow): DashboardMoneyDto {
    const format = (amount: bigint) => formatMinor(amount, row.minor_units);
    return {
      currency: row.code,
      minorUnits: row.minor_units,
      revenueMinor: row.revenue.toString(),
      revenue: format(row.revenue),
      revenueLast24hMinor: row.revenue_24h.toString(),
      revenueLast24h: format(row.revenue_24h),
      revenueLast7dMinor: row.revenue_7d.toString(),
      revenueLast7d: format(row.revenue_7d),
      revenueLast30dMinor: row.revenue_30d.toString(),
      revenueLast30d: format(row.revenue_30d),
      walletBalancesMinor: row.wallet_balances.toString(),
      walletBalances: format(row.wallet_balances),
      heldBalancesMinor: row.held_balances.toString(),
      heldBalances: format(row.held_balances),
    };
  }
}
