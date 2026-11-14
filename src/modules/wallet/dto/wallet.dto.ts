import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntryDirection, LedgerAccountType, WalletTransactionStatus, WalletTransactionType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrencyCode } from '../../../common/dto/currency-code.decorator';
import { Trim } from '../../../common/utils/trim.transform';

const MINOR = 'Integer amount in minor units (santim for ETB), as a string so large values keep full precision.';
const DECIMAL = 'The same amount formatted in major units for display. Do not use it for arithmetic.';

export class WalletQueryDto {
  @CurrencyCode()
  currency?: string;
}

export class ListWalletTransactionsQueryDto extends WalletQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: '`nextCursor` from the previous page. Omit for the newest entries.' })
  @IsOptional()
  @Matches(/^[1-9][0-9]{0,18}$/, { message: 'cursor is invalid' })
  cursor?: string;

  @ApiPropertyOptional({ enum: WalletTransactionType, description: 'Only return transactions of this type' })
  @IsOptional()
  @IsEnum(WalletTransactionType)
  type?: WalletTransactionType;
}

export class AdjustWalletDto {
  @ApiProperty({ enum: EntryDirection, description: 'CREDIT adds money to the wallet, DEBIT removes it' })
  @IsEnum(EntryDirection)
  direction!: EntryDirection;

  @ApiProperty({ example: '5000', description: MINOR })
  @IsString()
  @Matches(/^[1-9][0-9]{0,14}$/, { message: 'amountMinor must be a positive whole number of minor units' })
  amountMinor!: string;

  @CurrencyCode()
  currency?: string;

  @ApiProperty({
    example: 'Goodwill credit for support ticket 1234',
    minLength: 5,
    maxLength: 500,
    description: 'Why the correction is made. Stored in the audit log and shown to the user in their history.',
  })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

export class ReasonDto {
  @ApiProperty({ example: 'Entered against the wrong customer', minLength: 5, maxLength: 500 })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

export class WalletDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ example: 2, description: 'Decimal places of the currency (100 santim = 1 birr)' })
  minorUnits!: number;

  @ApiProperty({ example: '125050', description: `Spendable balance. ${MINOR}` })
  availableMinor!: string;

  @ApiProperty({ example: '1250.50', description: DECIMAL })
  available!: string;

  @ApiProperty({ example: '0', description: `Reserved for pending withdrawals; not spendable. ${MINOR}` })
  heldMinor!: string;

  @ApiProperty({ example: '0.00', description: DECIMAL })
  held!: string;

  @ApiProperty({ description: 'A frozen wallet can receive money but cannot spend or withdraw it' })
  isFrozen!: boolean;

  @ApiProperty()
  updatedAt!: Date;
}

export class WalletTransactionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'TX-20261113-7K2M9QXA4T' })
  reference!: string;

  @ApiProperty({ enum: WalletTransactionType })
  type!: WalletTransactionType;

  @ApiProperty({ enum: WalletTransactionStatus, description: 'REVERSED when a later transaction undid this one' })
  status!: WalletTransactionStatus;

  @ApiProperty({ enum: EntryDirection, description: 'CREDIT = money into the wallet, DEBIT = money out' })
  direction!: EntryDirection;

  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ example: '5000', description: MINOR })
  amountMinor!: string;

  @ApiProperty({ example: '50.00', description: DECIMAL })
  amount!: string;

  @ApiProperty({ example: '125050', description: `Spendable balance right after this transaction. ${MINOR}` })
  balanceAfterMinor!: string;

  @ApiProperty({ example: '1250.50', description: DECIMAL })
  balanceAfter!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  description!: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: null,
    description: 'Reference of the transaction this one reverses, if any',
  })
  reversalOf!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class WalletTransactionPageDto {
  @ApiProperty({ type: [WalletTransactionDto], description: 'Newest first' })
  items!: WalletTransactionDto[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Pass as `cursor` to fetch the next page; null when there are no more entries',
  })
  nextCursor!: string | null;
}

export class ReconciliationTotalDto {
  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ enum: LedgerAccountType })
  accountType!: LedgerAccountType;

  @ApiProperty({ example: 42 })
  accounts!: number;

  @ApiProperty({ example: '1250000', description: MINOR })
  balanceMinor!: string;
}

export class ReconciliationIssueDto {
  @ApiProperty({
    enum: [
      'BALANCE_MISMATCH',
      'RUNNING_BALANCE_MISMATCH',
      'UNBALANCED_TRANSACTION',
      'NEGATIVE_BALANCE',
      'TRIAL_BALANCE_NOT_ZERO',
    ],
  })
  kind!: string;

  @ApiProperty({ description: 'Ledger account code, transaction id or currency the issue is about' })
  subject!: string;

  @ApiProperty()
  detail!: string;
}

export class ReconciliationReportDto {
  @ApiProperty({ description: 'true when every cached balance is proven by the ledger lines' })
  ok!: boolean;

  @ApiProperty()
  checkedAt!: Date;

  @ApiProperty()
  accounts!: number;

  @ApiProperty()
  transactions!: number;

  @ApiProperty()
  entries!: number;

  @ApiProperty({ type: [ReconciliationTotalDto] })
  totals!: ReconciliationTotalDto[];

  @ApiProperty({ type: [ReconciliationIssueDto], description: 'Empty when ok is true; at most 100 per kind' })
  issues!: ReconciliationIssueDto[];
}
