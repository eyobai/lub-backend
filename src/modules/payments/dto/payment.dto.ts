import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
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
}

export class StartDepositDto {
  @ApiProperty({ example: '50000', description: MINOR })
  @IsString()
  @Matches(/^[1-9][0-9]{0,14}$/, { message: 'amountMinor must be a positive whole number of minor units' })
  amountMinor!: string;
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
    description: 'Why no money was added, when the deposit did not succeed.',
  })
  failureReason!: string | null;

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
