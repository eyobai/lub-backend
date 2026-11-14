import { ApiProperty } from '@nestjs/swagger';
import { AuctionOutcome, NoUniqueBidPolicy, WinnerVerificationStatus } from '@prisma/client';

const MINOR = 'Integer amount in minor units (santim for ETB), as a string so large values keep full precision.';
const DECIMAL = 'The same amount formatted in major units for display. Do not use it for arithmetic.';

export enum MyBidOutcome {
  /** The lowest amount that nobody else bid: this bid won. */
  WINNING = 'WINNING',
  /** Nobody else bid this amount, but a lower unique bid exists. */
  UNIQUE_NOT_LOWEST = 'UNIQUE_NOT_LOWEST',
  /** This amount was bid more than once, so it cannot win. */
  NOT_UNIQUE = 'NOT_UNIQUE',
}

export class AuctionResultDto {
  @ApiProperty({ format: 'uuid' })
  auctionId!: string;

  @ApiProperty({
    enum: AuctionOutcome,
    description:
      'WINNER_FOUND: one bid was the lowest unique amount. NO_UNIQUE_BID: every amount was bid more than once. ' +
      'NO_BIDS: nobody bid.',
  })
  outcome!: AuctionOutcome;

  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ example: 2 })
  minorUnits!: number;

  @ApiProperty({ type: String, nullable: true, example: '400', description: `The winning bid. ${MINOR}` })
  winningAmountMinor!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '4.00', description: DECIMAL })
  winningAmount!: string | null;

  @ApiProperty({ example: 12 })
  totalBids!: number;

  @ApiProperty({
    enum: NoUniqueBidPolicy,
    nullable: true,
    description: 'What was done because there was no unique bid; null for any other outcome',
  })
  appliedNoUniquePolicy!: NoUniqueBidPolicy | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'When every bid fee had been returned, if the applied policy refunds them',
  })
  bidFeesRefundedAt!: Date | null;

  @ApiProperty()
  computedAt!: Date;
}

export class MyResultBidDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '500', description: MINOR })
  amountMinor!: string;

  @ApiProperty({ example: '5.00', description: DECIMAL })
  amount!: string;

  @ApiProperty({ enum: MyBidOutcome })
  outcome!: MyBidOutcome;

  @ApiProperty()
  createdAt!: Date;
}

export class MyAuctionResultDto extends AuctionResultDto {
  @ApiProperty({ description: 'True if one of my bids won this auction' })
  won!: boolean;

  @ApiProperty({ type: [MyResultBidDto], description: 'My bids in this auction, lowest amount first' })
  bids!: MyResultBidDto[];
}

export class ResultHistogramEntryDto {
  @ApiProperty({ example: '400', description: MINOR })
  amountMinor!: string;

  @ApiProperty({ example: '4.00', description: DECIMAL })
  amount!: string;

  @ApiProperty({ example: 1, description: 'Number of bids at exactly this amount' })
  count!: number;
}

export class ResultWinnerDto {
  @ApiProperty({ format: 'uuid', description: 'Winner record' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: '+251911234567' })
  phoneNumber!: string;

  @ApiProperty({ format: 'uuid', description: 'The winning bid' })
  bidId!: string;

  @ApiProperty({ enum: WinnerVerificationStatus })
  verificationStatus!: WinnerVerificationStatus;
}

export class AdminAuctionResultDto extends AuctionResultDto {
  @ApiProperty({ example: 5, description: 'Number of different amounts that were bid' })
  distinctAmounts!: number;

  @ApiProperty({ example: 2, description: 'Number of amounts that were bid exactly once' })
  uniqueAmounts!: number;

  @ApiProperty({ type: String, nullable: true, description: 'Sequence number of the last bid that was counted' })
  lastBidSequence!: string | null;

  @ApiProperty({ example: 'lub-1' })
  algorithmVersion!: string;

  @ApiProperty({ description: 'SHA-256 fingerprint of the bid counts the result was computed from' })
  inputHash!: string;

  @ApiProperty({
    type: [ResultHistogramEntryDto],
    description: 'How many bids each amount received, lowest amount first: the full input to the calculation',
  })
  histogram!: ResultHistogramEntryDto[];

  @ApiProperty({ type: ResultWinnerDto, nullable: true })
  winner!: ResultWinnerDto | null;
}

export class ResultSnapshotDto {
  @ApiProperty({ enum: AuctionOutcome })
  outcome!: AuctionOutcome;

  @ApiProperty({ type: String, nullable: true })
  winningAmountMinor!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  winningBidId!: string | null;

  @ApiProperty()
  totalBids!: number;

  @ApiProperty()
  inputHash!: string;
}

export class ResultAuditDto {
  @ApiProperty({ format: 'uuid' })
  auctionId!: string;

  @ApiProperty({ description: 'True if recomputing from the stored bids gives exactly the recorded result' })
  matches!: boolean;

  @ApiProperty({ type: ResultSnapshotDto, description: 'The result recorded when the auction was finalized' })
  recorded!: ResultSnapshotDto;

  @ApiProperty({ type: ResultSnapshotDto, description: 'The result computed just now from the bids on record' })
  recomputed!: ResultSnapshotDto;

  @ApiProperty()
  checkedAt!: Date;
}
