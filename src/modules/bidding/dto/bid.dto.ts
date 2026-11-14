import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuctionStatus } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto';
import { IsMinorAmount } from '../../../common/validators/validators';

const MINOR = 'Integer amount in minor units (santim for ETB), as a string so large values keep full precision.';
const DECIMAL = 'The same amount formatted in major units for display. Do not use it for arithmetic.';

export class PlaceBidsDto {
  @ApiProperty({
    type: [String],
    example: ['500', '1000', '1500', '2000'],
    minItems: 1,
    maxItems: 100,
    description:
      `One or several different bid amounts. ${MINOR} Each amount costs one bid fee. ` +
      'Either every amount is accepted and charged, or none is.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique({ message: 'amountsMinor must not contain the same amount twice' })
  @IsMinorAmount({ each: true })
  amountsMinor!: string[];
}

export class ListMyBidsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only my bids in this auction' })
  @IsOptional()
  @IsUUID()
  auctionId?: string;
}

export class AdminListBidsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only bids placed by this user' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ example: '500', description: `Only bids of exactly this amount. ${MINOR}` })
  @IsOptional()
  @IsMinorAmount()
  amountMinor?: string;
}

export class BidDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '500', description: MINOR })
  amountMinor!: string;

  @ApiProperty({ example: '5.00', description: DECIMAL })
  amount!: string;

  @ApiProperty()
  createdAt!: Date;
}

export class BidSubmissionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  auctionId!: string;

  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ example: 2 })
  minorUnits!: number;

  @ApiProperty({ example: 4, description: 'Number of bids recorded by this request' })
  bidCount!: number;

  @ApiProperty({ example: '7500', description: `Fee charged per bid. ${MINOR}` })
  bidFeeMinor!: string;

  @ApiProperty({ example: '75.00', description: DECIMAL })
  bidFee!: string;

  @ApiProperty({ example: '30000', description: `Total charged to the wallet: bidCount × bidFee. ${MINOR}` })
  totalFeeMinor!: string;

  @ApiProperty({ example: '300.00', description: DECIMAL })
  totalFee!: string;

  @ApiProperty({ format: 'uuid', description: 'Wallet transaction that charged the fee' })
  transactionId!: string;

  @ApiProperty({ example: 'TX-20261113-7K2M9QXA4T' })
  transactionReference!: string;

  @ApiProperty({ example: '70000', description: `Spendable wallet balance right after this charge. ${MINOR}` })
  walletAvailableMinor!: string;

  @ApiProperty({ example: '700.00', description: DECIMAL })
  walletAvailable!: string;

  @ApiProperty({ type: [BidDto], description: 'The recorded bids, in the order they were sent' })
  bids!: BidDto[];

  @ApiProperty()
  createdAt!: Date;
}

export class MyBidDto extends BidDto {
  @ApiProperty({ format: 'uuid' })
  auctionId!: string;

  @ApiProperty()
  auctionTitle!: string;

  @ApiProperty({ enum: AuctionStatus })
  auctionStatus!: AuctionStatus;

  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ format: 'uuid', description: 'The request this bid was part of' })
  submissionId!: string;

  @ApiProperty({ example: '7500', description: `Fee paid for this bid. ${MINOR}` })
  bidFeeMinor!: string;

  @ApiProperty({ example: '75.00', description: DECIMAL })
  bidFee!: string;
}

export class MyBidPageDto {
  @ApiProperty({ type: [MyBidDto] })
  items!: MyBidDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class AdminBidDto extends BidDto {
  @ApiProperty({ example: '1042', description: 'Platform-wide order in which bids were accepted' })
  sequence!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: '+251911234567' })
  phoneNumber!: string;

  @ApiProperty({ format: 'uuid' })
  submissionId!: string;
}

export class AdminBidPageDto {
  @ApiProperty({ type: [AdminBidDto] })
  items!: AdminBidDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}
