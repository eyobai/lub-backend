import { ApiProperty } from '@nestjs/swagger';
import { AuctionStatus } from '@prisma/client';

const MINOR = 'Integer amount in minor units (santim for ETB), as a string so large values keep full precision.';
const DECIMAL = 'The same amount formatted in major units for display. Do not use it for arithmetic.';

export class DashboardUsersDto {
  @ApiProperty()
  total!: number;

  @ApiProperty()
  active!: number;

  @ApiProperty()
  suspended!: number;

  @ApiProperty()
  blocked!: number;

  @ApiProperty({ description: 'Accounts holding a back-office role' })
  staff!: number;

  @ApiProperty({ description: 'Registered in the last 24 hours' })
  newLast24h!: number;

  @ApiProperty()
  newLast7d!: number;

  @ApiProperty()
  newLast30d!: number;
}

export class DashboardAuctionsDto {
  @ApiProperty()
  draft!: number;

  @ApiProperty()
  scheduled!: number;

  @ApiProperty()
  active!: number;

  @ApiProperty({ description: 'Bidding has ended and the result is being computed' })
  closing!: number;

  @ApiProperty()
  completed!: number;

  @ApiProperty()
  cancelled!: number;
}

export class DashboardBidsDto {
  @ApiProperty()
  total!: number;

  @ApiProperty()
  last24h!: number;

  @ApiProperty()
  last7d!: number;

  @ApiProperty()
  last30d!: number;
}

export class DashboardWinnersDto {
  @ApiProperty({ description: 'Waiting for an admin to verify or reject' })
  pendingVerification!: number;

  @ApiProperty()
  verified!: number;

  @ApiProperty()
  rejected!: number;

  @ApiProperty({ description: 'Shown in the public recent-winners list' })
  published!: number;
}

export class DashboardDeliveriesDto {
  @ApiProperty()
  pending!: number;

  @ApiProperty()
  contacted!: number;

  @ApiProperty()
  verified!: number;

  @ApiProperty()
  dispatched!: number;

  @ApiProperty()
  delivered!: number;

  @ApiProperty()
  disputed!: number;
}

export class DashboardMoneyDto {
  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ example: 2 })
  minorUnits!: number;

  @ApiProperty({ example: '1500000', description: `Bid fees kept, after refunds, since launch. ${MINOR}` })
  revenueMinor!: string;

  @ApiProperty({ example: '15000.00', description: DECIMAL })
  revenue!: string;

  @ApiProperty({ example: '30000', description: 'Bid fees charged minus fees refunded in the last 24 hours' })
  revenueLast24hMinor!: string;

  @ApiProperty({ example: '300.00' })
  revenueLast24h!: string;

  @ApiProperty({ example: '210000' })
  revenueLast7dMinor!: string;

  @ApiProperty({ example: '2100.00' })
  revenueLast7d!: string;

  @ApiProperty({ example: '900000' })
  revenueLast30dMinor!: string;

  @ApiProperty({ example: '9000.00' })
  revenueLast30d!: string;

  @ApiProperty({ example: '4200000', description: 'Money users can spend: what the platform owes its users' })
  walletBalancesMinor!: string;

  @ApiProperty({ example: '42000.00' })
  walletBalances!: string;

  @ApiProperty({ example: '0', description: 'User money set aside for pending withdrawals' })
  heldBalancesMinor!: string;

  @ApiProperty({ example: '0.00' })
  heldBalances!: string;
}

export class DashboardDto {
  @ApiProperty({ description: 'Database time the figures were read at' })
  generatedAt!: Date;

  @ApiProperty({ type: DashboardUsersDto })
  users!: DashboardUsersDto;

  @ApiProperty({ type: DashboardAuctionsDto })
  auctions!: DashboardAuctionsDto;

  @ApiProperty({ type: DashboardBidsDto })
  bids!: DashboardBidsDto;

  @ApiProperty({ type: DashboardWinnersDto })
  winners!: DashboardWinnersDto;

  @ApiProperty({ type: DashboardDeliveriesDto })
  deliveries!: DashboardDeliveriesDto;

  @ApiProperty({ description: 'Wallets a finance user has frozen' })
  frozenWallets!: number;

  @ApiProperty({ type: [DashboardMoneyDto], description: 'One entry per active currency' })
  money!: DashboardMoneyDto[];
}

export class AuctionStatisticsDto {
  @ApiProperty({ format: 'uuid' })
  auctionId!: string;

  @ApiProperty({ enum: AuctionStatus })
  status!: AuctionStatus;

  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ example: 2 })
  minorUnits!: number;

  @ApiProperty()
  bidCount!: number;

  @ApiProperty({ description: 'Users who placed at least one bid' })
  bidderCount!: number;

  @ApiProperty({ description: 'Bid requests accepted (one request can carry several bids)' })
  submissionCount!: number;

  @ApiProperty({ description: 'Different amounts that were bid' })
  distinctAmounts!: number;

  @ApiProperty({ description: 'Amounts bid exactly once so far' })
  uniqueAmounts!: number;

  @ApiProperty({ type: String, nullable: true, example: '100', description: `Lowest amount bid. ${MINOR}` })
  lowestBidMinor!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2500' })
  highestBidMinor!: string | null;

  @ApiProperty({ example: '750000', description: `Bid fees charged for this auction. ${MINOR}` })
  feesChargedMinor!: string;

  @ApiProperty({ example: '7500.00', description: DECIMAL })
  feesCharged!: string;

  @ApiProperty({
    description: 'All bid fees were returned (cancelled auction, or no unique bid with the refund policy)',
  })
  feesRefunded!: boolean;

  @ApiProperty({ type: Date, nullable: true })
  firstBidAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  lastBidAt!: Date | null;
}
