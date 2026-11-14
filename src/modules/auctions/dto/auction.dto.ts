import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuctionStatus, DuplicateBidPolicy, NoUniqueBidPolicy, ProductStatus } from '@prisma/client';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto';
import { Trim } from '../../../common/utils/trim.transform';
import { IsInstant, IsMinorAmount, IsUndefinable } from '../../../common/validators/validators';
import { ProductSummaryDto } from '../../products/dto/product.dto';

const MINOR = 'Integer amount in minor units (santim for ETB), as a string so large values keep full precision.';
const DECIMAL = 'The same amount formatted in major units for display. Do not use it for arithmetic.';
const INSTANT = 'ISO-8601 instant with a time zone, e.g. 2027-01-31T09:00:00+03:00.';

/** EXTEND_AUCTION exists in the data model but needs extension rules that are not defined yet. */
export const SUPPORTED_NO_UNIQUE_BID_POLICIES = [NoUniqueBidPolicy.NO_WINNER, NoUniqueBidPolicy.REFUND_BID_FEES];
const NO_UNIQUE_DOC =
  'What happens if no amount was bid exactly once. NO_WINNER: the auction ends without a winner and fees are kept. ' +
  'REFUND_BID_FEES: it ends without a winner and every bid fee is refunded. Required before scheduling.';

/** Statuses a visitor can list. */
export const PUBLIC_AUCTION_STATUSES = [
  AuctionStatus.SCHEDULED,
  AuctionStatus.ACTIVE,
  AuctionStatus.CLOSING,
  AuctionStatus.COMPLETED,
];

export class CreateAuctionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ example: 'Win a Samsung Galaxy A55', minLength: 3, maxLength: 200 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 10000, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(10000)
  description?: string | null;

  @ApiProperty({ example: '7500', description: `Fee charged for each bid amount. ${MINOR}` })
  @IsMinorAmount()
  bidFeeMinor!: string;

  @ApiProperty({ example: '100', description: `Lowest amount a user may bid. ${MINOR}` })
  @IsMinorAmount()
  minBidMinor!: string;

  @ApiProperty({ example: '100000', description: `Highest amount a user may bid. ${MINOR}` })
  @IsMinorAmount()
  maxBidMinor!: string;

  @ApiPropertyOptional({
    example: '100',
    default: '1',
    description: `Allowed amounts are minBid, minBid + step, … up to maxBid. ${MINOR}`,
  })
  @IsOptional()
  @IsMinorAmount()
  bidStepMinor?: string;

  @ApiPropertyOptional({
    minimum: 1,
    nullable: true,
    description: 'Most bids one user may place in this auction. Omit or null for no limit.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxBidsPerUser?: number | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50, description: 'Most amounts in one bid request.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxBidsPerRequest?: number;

  @ApiProperty({ example: '2027-01-31T09:00:00+03:00', description: `When bidding opens. ${INSTANT}` })
  @IsInstant()
  opensAt!: string;

  @ApiProperty({ example: '2027-02-07T21:00:00+03:00', description: `When bidding closes. ${INSTANT}` })
  @IsInstant()
  closesAt!: string;

  @ApiPropertyOptional({ enum: DuplicateBidPolicy, default: DuplicateBidPolicy.REJECT_SAME_USER_SAME_AMOUNT })
  @IsOptional()
  @IsEnum(DuplicateBidPolicy)
  duplicateBidPolicy?: DuplicateBidPolicy;

  @ApiPropertyOptional({ enum: SUPPORTED_NO_UNIQUE_BID_POLICIES, nullable: true, description: NO_UNIQUE_DOC })
  @IsOptional()
  @IsIn(SUPPORTED_NO_UNIQUE_BID_POLICIES)
  noUniqueBidPolicy?: NoUniqueBidPolicy | null;
}

/** Send only the fields to change. `null` clears description, maxBidsPerUser or noUniqueBidPolicy. */
export class UpdateAuctionDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUndefinable()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 200 })
  @IsUndefinable()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 10000, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(10000)
  description?: string | null;

  @ApiPropertyOptional({ example: '7500', description: MINOR })
  @IsUndefinable()
  @IsMinorAmount()
  bidFeeMinor?: string;

  @ApiPropertyOptional({ example: '100', description: MINOR })
  @IsUndefinable()
  @IsMinorAmount()
  minBidMinor?: string;

  @ApiPropertyOptional({ example: '100000', description: MINOR })
  @IsUndefinable()
  @IsMinorAmount()
  maxBidMinor?: string;

  @ApiPropertyOptional({ example: '100', description: MINOR })
  @IsUndefinable()
  @IsMinorAmount()
  bidStepMinor?: string;

  @ApiPropertyOptional({ minimum: 1, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxBidsPerUser?: number | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsUndefinable()
  @IsInt()
  @Min(1)
  @Max(100)
  maxBidsPerRequest?: number;

  @ApiPropertyOptional({ description: INSTANT })
  @IsUndefinable()
  @IsInstant()
  opensAt?: string;

  @ApiPropertyOptional({ description: INSTANT })
  @IsUndefinable()
  @IsInstant()
  closesAt?: string;

  @ApiPropertyOptional({ enum: DuplicateBidPolicy })
  @IsUndefinable()
  @IsEnum(DuplicateBidPolicy)
  duplicateBidPolicy?: DuplicateBidPolicy;

  @ApiPropertyOptional({ enum: SUPPORTED_NO_UNIQUE_BID_POLICIES, nullable: true, description: NO_UNIQUE_DOC })
  @IsOptional()
  @IsIn(SUPPORTED_NO_UNIQUE_BID_POLICIES)
  noUniqueBidPolicy?: NoUniqueBidPolicy | null;
}

export class CancelAuctionDto {
  @ApiProperty({ example: 'Supplier could not deliver the product', minLength: 5, maxLength: 500 })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

export class ListAuctionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: PUBLIC_AUCTION_STATUSES,
    description: 'Omit to list every auction that is upcoming, running or finished.',
  })
  @IsOptional()
  @IsIn(PUBLIC_AUCTION_STATUSES)
  status?: AuctionStatus;

  @ApiPropertyOptional({ enum: ['closesAt', 'opensAt'], default: 'closesAt' })
  @IsOptional()
  @IsIn(['closesAt', 'opensAt'])
  sort?: 'closesAt' | 'opensAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

export class AdminListAuctionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: AuctionStatus })
  @IsOptional()
  @IsEnum(AuctionStatus)
  status?: AuctionStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ description: 'Matches the title (case-insensitive)', maxLength: 100 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class AuctionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({
    enum: AuctionStatus,
    description:
      'SCHEDULED: visible, not open yet. ACTIVE: accepting bids. CLOSING: bidding has ended and the result is ' +
      'being determined. COMPLETED: result published. CANCELLED: called off.',
  })
  status!: AuctionStatus;

  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ example: 2, description: 'Decimal places of the currency' })
  minorUnits!: number;

  @ApiProperty({ example: '7500', description: `Fee charged for each bid amount. ${MINOR}` })
  bidFeeMinor!: string;

  @ApiProperty({ example: '75.00', description: DECIMAL })
  bidFee!: string;

  @ApiProperty({ example: '100', description: MINOR })
  minBidMinor!: string;

  @ApiProperty({ example: '1.00', description: DECIMAL })
  minBid!: string;

  @ApiProperty({ example: '100000', description: MINOR })
  maxBidMinor!: string;

  @ApiProperty({ example: '1000.00', description: DECIMAL })
  maxBid!: string;

  @ApiProperty({ example: '100', description: `Allowed amounts are minBid, minBid + step, … up to maxBid. ${MINOR}` })
  bidStepMinor!: string;

  @ApiProperty({ example: '1.00', description: DECIMAL })
  bidStep!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Most bids one user may place; null = no limit' })
  maxBidsPerUser!: number | null;

  @ApiProperty({ description: 'Most amounts in one bid request' })
  maxBidsPerRequest!: number;

  @ApiProperty({ enum: DuplicateBidPolicy })
  duplicateBidPolicy!: DuplicateBidPolicy;

  @ApiProperty({ enum: NoUniqueBidPolicy, nullable: true, description: NO_UNIQUE_DOC })
  noUniqueBidPolicy!: NoUniqueBidPolicy | null;

  @ApiProperty()
  opensAt!: Date;

  @ApiProperty()
  closesAt!: Date;

  @ApiProperty({ description: 'Number of valid bids placed so far' })
  totalBidCount!: number;

  @ApiProperty({ type: ProductSummaryDto })
  product!: ProductSummaryDto;

  @ApiProperty({
    description: 'Server clock when this response was produced. Deadlines are judged by it; use it for countdowns.',
  })
  serverTime!: Date;
}

export class AuctionPageDto {
  @ApiProperty({ type: [AuctionDto] })
  items!: AuctionDto[];

  @ApiProperty({ description: 'Number of auctions matching the filter' })
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class AdminAuctionDto extends AuctionDto {
  @ApiProperty({ enum: ProductStatus })
  productStatus!: ProductStatus;

  @ApiProperty({ description: 'Increases with every change to the auction' })
  version!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  activatedAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true, description: 'When bidding was closed' })
  closedAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  completedAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  cancelledAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  cancelReason!: string | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'Set once every bid fee of a cancelled auction has been returned to its bidder',
  })
  bidFeesRefundedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class AdminAuctionPageDto {
  @ApiProperty({ type: [AdminAuctionDto] })
  items!: AdminAuctionDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}
