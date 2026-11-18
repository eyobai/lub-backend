import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PlaceBidsDto } from '../../bidding/dto/bid.dto';
import { PageQueryDto } from '../../../common/dto/page-query.dto';
import { Trim } from '../../../common/utils/trim.transform';

const MINOR = 'Integer amount in minor units (santim for ETB), as a string so large values keep full precision.';
const DECIMAL = 'The same amount formatted in major units for display. Do not use it for arithmetic.';

export class DepositOptionsDto {
  @ApiProperty({ description: 'False when no payment provider is configured: starting a deposit is refused.' })
  enabled!: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'chapa' })
  provider!: string | null;

  @ApiProperty({ description: 'True when the provider runs in test mode: no real money moves.' })
  testMode!: boolean;

  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ example: 2 })
  minorUnits!: number;

  @ApiProperty({ example: '1000', description: `Smallest single deposit. ${MINOR}` })
  minAmountMinor!: string;

  @ApiProperty({ example: '5000000', description: `Largest single deposit. ${MINOR}` })
  maxAmountMinor!: string;

  @ApiProperty({
    type: [String],
    example: ['telebirr', 'mpesa', 'cbebirr', 'ebirr'],
    description:
      'Mobile wallets that can be charged without leaving the site (`charge.method` when starting a deposit). ' +
      "Empty: only Chapa's checkout page.",
  })
  directChargeMethods!: string[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CHAPUBK-xxxxxxxx',
    description:
      'When set, a phone payment is sent from the browser: start the deposit with `charge`, then send the request ' +
      "to Chapa's inline service with this public key and the deposit's `reference` as tx_ref. Null: the server " +
      'sends it.',
  })
  inlinePublicKey!: string | null;

  @ApiProperty({ example: 100, description: 'Top-up bonus, in percent of a wallet top-up. 0: no bonus.' })
  bonusPercent!: number;

  @ApiProperty({ example: '1000000', description: `The most bonus one top-up earns. ${MINOR}` })
  bonusMaxMinor!: string;

  @ApiProperty({ example: 7, description: 'Days a bonus can be spent before it expires.' })
  bonusValidDays!: number;
}

export class ChargeDto {
  @ApiProperty({
    example: 'telebirr',
    description: 'One of `directChargeMethods` from the deposit options.',
  })
  @IsString()
  @Matches(/^[a-z_]{2,32}$/)
  method!: string;

  @ApiPropertyOptional({
    example: '0911223344',
    description: "The wallet's phone number (0911…, +251911…). Defaults to the account's own number.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneNumber?: string;
}

export class BidToPayDto extends PlaceBidsDto {
  @ApiProperty({ format: 'uuid', description: 'The auction to bid in.' })
  @IsUUID()
  auctionId!: string;
}

export class ChargeNotSentDto {
  @ApiPropertyOptional({ example: 'Transaction initiation failed', description: "What Chapa's inline service said." })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class StartDepositDto {
  @ApiProperty({
    example: '50000',
    description: `${MINOR} With \`bid\`, it must equal the bid fee times the number of amounts.`,
  })
  @IsString()
  @Matches(/^[1-9][0-9]{0,14}$/, { message: 'amountMinor must be a positive whole number of minor units' })
  amountMinor!: string;

  @ApiPropertyOptional({
    type: BidToPayDto,
    description:
      'Pay and bid: this payment is for these bids. They are checked before the payment opens; once it is ' +
      'confirmed the money goes into the wallet and the bids are placed from it. If they are refused by then ' +
      '(the auction closed, for example) the money stays in the wallet. The smallest-deposit limit does not apply.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => BidToPayDto)
  bid?: BidToPayDto;

  @ApiPropertyOptional({
    type: ChargeDto,
    description:
      "Pay without leaving the site: instead of opening Chapa's checkout page (`checkoutUrl`), the wallet sends " +
      'the payer a request to approve on their phone. Read the deposit again until it is SUCCEEDED or closed.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ChargeDto)
  charge?: ChargeDto;
}

export class PaidBidDto {
  @ApiProperty({ format: 'uuid' })
  auctionId!: string;

  @ApiProperty({ type: [String], example: ['500', '1250'], description: MINOR })
  amountsMinor!: string[];

  @ApiProperty({ type: [String], example: ['5.00', '12.50'], description: DECIMAL })
  amounts!: string[];

  @ApiProperty({
    enum: ['WAITING', 'PLACED', 'REFUSED'],
    description:
      'WAITING: the payment is not confirmed yet (or the bids are being placed). PLACED: the bids were placed. ' +
      'REFUSED: the bids could not be placed; `error` says why and the money is in the wallet.',
  })
  state!: 'WAITING' | 'PLACED' | 'REFUSED';

  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'The bid submission, once PLACED.' })
  submissionId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Why the bids were refused.' })
  error!: string | null;
}

export class DepositDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: PaymentStatus,
    description:
      'PENDING: waiting for the payer or the provider. SUCCEEDED: the wallet was credited. ' +
      'FAILED, CANCELLED, EXPIRED: no money was added.',
  })
  status!: PaymentStatus;

  @ApiProperty({ example: 'chapa' })
  provider!: string;

  @ApiProperty({
    example: 'LUB-7K2M9Q4T8X1B3N5P6R0V',
    description: 'Our reference for this payment, shown to the payer.',
  })
  reference!: string;

  @ApiProperty({ example: '50000', description: MINOR })
  amountMinor!: string;

  @ApiProperty({ example: '500.00', description: DECIMAL })
  amount!: string;

  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ example: 2 })
  minorUnits!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Provider page where the payer completes the payment. Only present while the deposit is PENDING.',
  })
  checkoutUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'telebirr',
    description:
      "Direct charge: the wallet asked to send a request to the payer's phone. Null for a checkout-page payment.",
  })
  chargeMethod!: string | null;

  @ApiProperty({
    example: '50000',
    description:
      `Top-up bonus this deposit earns, added to the wallet's bonus once the payment is confirmed. ` +
      `0 for bid payments. ${MINOR}`,
  })
  bonusMinor!: string;

  @ApiProperty({ example: '500.00', description: DECIMAL })
  bonus!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why no money was added, when the deposit did not succeed.',
  })
  failureReason!: string | null;

  @ApiProperty({
    description:
      'True when the provider refused to send the payment request at all, so nothing ever reached the phone ' +
      '(for example direct charges are not enabled for this account). False for a declined or cancelled payment.',
  })
  requestNotSent!: boolean;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The wallet transaction that credited the money, once SUCCEEDED.',
  })
  walletTransactionId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the payment was confirmed.' })
  confirmedAt!: Date | null;

  @ApiProperty({ description: 'After this time an unpaid deposit is given up on.' })
  expiresAt!: Date;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ type: PaidBidDto, nullable: true, description: 'Pay and bid: the bids this payment is for.' })
  bid!: PaidBidDto | null;
}

export class DepositPageDto {
  @ApiProperty({ type: [DepositDto] })
  items!: DepositDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class AdminDepositDto extends DepositDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: '+251911223344' })
  phoneNumber!: string;

  @ApiProperty({ type: String, nullable: true, description: "The provider's own reference, known once it confirms." })
  providerReference!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Set when a person must look at this payment: the provider reported something that does not match, ' +
      'or a refund or reversal after the wallet was credited. No money is moved automatically in these cases.',
  })
  reviewReason!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastCheckedAt!: Date | null;

  @ApiProperty()
  updatedAt!: Date;
}

export class AdminDepositPageDto {
  @ApiProperty({ type: [AdminDepositDto] })
  items!: AdminDepositDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class AdminListDepositsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'true: only deposits waiting for a person to review them.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  needsReview?: boolean;

  @ApiPropertyOptional({ description: 'Our reference (LUB-…) or the provider reference, exact match.' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(128)
  reference?: string;
}

export class ResolveReviewDto {
  @ApiProperty({
    example: 'Refund confirmed with Chapa; wallet debited by adjustment WTX-…',
    minLength: 5,
    maxLength: 500,
    description: 'What was found and done. Stored in the audit log.',
  })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  note!: string;
}

export class WebhookAckDto {
  @ApiProperty({ example: true })
  received!: boolean;
}
