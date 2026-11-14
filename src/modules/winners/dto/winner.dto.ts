import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PrizeDeliveryStatus, WinnerVerificationStatus } from '@prisma/client';
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
import { PageQueryDto } from '../../../common/dto/page-query.dto';
import { Trim } from '../../../common/utils/trim.transform';
import { IsUndefinable } from '../../../common/validators/validators';

const MINOR = 'Integer amount in minor units (santim for ETB), as a string so large values keep full precision.';
const DECIMAL = 'The same amount formatted in major units for display. Do not use it for arithmetic.';
const PHONE = /^\+?[0-9]{9,15}$/;

// ── Requests ────────────────────────────────────────────────────────────────

export class DeliveryAddressDto {
  @ApiPropertyOptional({ example: 'Addis Ababa', maxLength: 100 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  region?: string;

  @ApiProperty({ example: 'Addis Ababa', maxLength: 100 })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  city!: string;

  @ApiPropertyOptional({ example: 'Bole', maxLength: 100 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  subCity?: string;

  @ApiPropertyOptional({ example: '03', maxLength: 50 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(50)
  woreda?: string;

  @ApiPropertyOptional({ example: '1234', maxLength: 50 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(50)
  houseNumber?: string;

  @ApiPropertyOptional({ example: 'Behind Edna Mall', maxLength: 255 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  landmark?: string;
}

/** What the winner sends: who receives the prize and where. */
export class SubmitDeliveryDetailsDto {
  @ApiProperty({ example: 'Abebe Kebede', maxLength: 150 })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  recipientName!: string;

  @ApiProperty({ example: '+251911234567', description: 'Digits with an optional leading +' })
  @Trim()
  @Matches(PHONE, { message: 'recipientPhone must be 9-15 digits with an optional leading +' })
  recipientPhone!: string;

  @ApiProperty({ type: DeliveryAddressDto })
  @ValidateNested()
  @Type(() => DeliveryAddressDto)
  address!: DeliveryAddressDto;
}

/** Send only the fields to change. */
export class UpdateDeliveryDto {
  @ApiPropertyOptional({ example: 'Abebe Kebede', maxLength: 150 })
  @IsUndefinable()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  recipientName?: string;

  @ApiPropertyOptional({ example: '+251911234567' })
  @IsUndefinable()
  @Trim()
  @Matches(PHONE, { message: 'recipientPhone must be 9-15 digits with an optional leading +' })
  recipientPhone?: string;

  @ApiPropertyOptional({ type: DeliveryAddressDto })
  @IsUndefinable()
  @ValidateNested()
  @Type(() => DeliveryAddressDto)
  address?: DeliveryAddressDto;

  @ApiPropertyOptional({ example: 'Courier: EMS, waybill 123456', maxLength: 500, description: 'Shown to the winner' })
  @IsUndefinable()
  @Trim()
  @IsString()
  @MaxLength(500)
  trackingInfo?: string;

  @ApiPropertyOptional({ maxLength: 2000, description: 'Internal notes; never shown to the winner' })
  @IsUndefinable()
  @Trim()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class SetDeliveryStatusDto {
  @ApiProperty({ enum: PrizeDeliveryStatus })
  @IsEnum(PrizeDeliveryStatus)
  status!: PrizeDeliveryStatus;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Required when raising or settling a dispute' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class VerifyWinnerDto {
  @ApiPropertyOptional({ maxLength: 1000, description: 'Optional remark, e.g. how the identity was checked' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class RejectWinnerDto {
  @ApiProperty({ minLength: 5, maxLength: 1000 })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;
}

export class AdminListWinnersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: WinnerVerificationStatus })
  @IsOptional()
  @IsEnum(WinnerVerificationStatus)
  verificationStatus?: WinnerVerificationStatus;

  @ApiPropertyOptional({ enum: PrizeDeliveryStatus })
  @IsOptional()
  @IsEnum(PrizeDeliveryStatus)
  deliveryStatus?: PrizeDeliveryStatus;

  @ApiPropertyOptional({ description: 'true: only published winners; false: only unpublished ones' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  published?: boolean;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

// ── Responses ───────────────────────────────────────────────────────────────

class WinnerBaseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  auctionId!: string;

  @ApiProperty()
  auctionTitle!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty({ type: String, nullable: true })
  productImageUrl!: string | null;

  @ApiProperty({ example: '400', description: `The winning bid. ${MINOR}` })
  amountMinor!: string;

  @ApiProperty({ example: '4.00', description: DECIMAL })
  amount!: string;

  @ApiProperty({ example: 'ETB' })
  currency!: string;
}

export class PublicWinnerDto extends WinnerBaseDto {
  @ApiProperty({ example: '+2519*****67', description: 'The winner’s phone number with the middle digits hidden' })
  winnerLabel!: string;

  @ApiProperty()
  publishedAt!: Date;
}

export class PublicWinnerPageDto {
  @ApiProperty({ type: [PublicWinnerDto] })
  items!: PublicWinnerDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class DeliveryDto {
  @ApiProperty({ enum: PrizeDeliveryStatus })
  status!: PrizeDeliveryStatus;

  @ApiProperty({ type: String, nullable: true })
  recipientName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  recipientPhone!: string | null;

  @ApiProperty({ type: DeliveryAddressDto, nullable: true })
  address!: DeliveryAddressDto | null;

  @ApiProperty({ type: String, nullable: true })
  trackingInfo!: string | null;

  @ApiProperty()
  updatedAt!: Date;
}

export class MyWinDto extends WinnerBaseDto {
  @ApiProperty({ enum: WinnerVerificationStatus })
  verificationStatus!: WinnerVerificationStatus;

  @ApiProperty({ type: Date, nullable: true })
  publishedAt!: Date | null;

  @ApiProperty({ description: 'True while I can still send or change my delivery details' })
  canEditDeliveryDetails!: boolean;

  @ApiProperty({ type: DeliveryDto, nullable: true, description: 'Null until the win has been verified' })
  delivery!: DeliveryDto | null;

  @ApiProperty()
  createdAt!: Date;
}

export class MyWinPageDto {
  @ApiProperty({ type: [MyWinDto] })
  items!: MyWinDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class DeliveryEventDto {
  @ApiProperty({ enum: PrizeDeliveryStatus, nullable: true })
  fromStatus!: PrizeDeliveryStatus | null;

  @ApiProperty({ enum: PrizeDeliveryStatus })
  toStatus!: PrizeDeliveryStatus;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  actorId!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class AdminDeliveryDto extends DeliveryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Internal notes' })
  notes!: string | null;

  @ApiProperty({ enum: PrizeDeliveryStatus, isArray: true, description: 'Statuses this delivery can move to next' })
  allowedNextStatuses!: PrizeDeliveryStatus[];

  @ApiProperty({ type: [DeliveryEventDto], description: 'Status history, oldest first' })
  events!: DeliveryEventDto[];
}

export class AdminWinnerDto extends WinnerBaseDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: '+251911234567' })
  phoneNumber!: string;

  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;

  @ApiProperty({ format: 'uuid' })
  bidId!: string;

  @ApiProperty({ enum: WinnerVerificationStatus })
  verificationStatus!: WinnerVerificationStatus;

  @ApiProperty({ type: String, nullable: true, description: 'Remark on verification, or the reason for rejection' })
  verificationNote!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  verifiedById!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  verifiedAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  publishedAt!: Date | null;

  @ApiProperty({ type: AdminDeliveryDto, nullable: true, description: 'Null until the winner has been verified' })
  delivery!: AdminDeliveryDto | null;

  @ApiProperty()
  createdAt!: Date;
}

export class AdminWinnerPageDto {
  @ApiProperty({ type: [AdminWinnerDto] })
  items!: AdminWinnerDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}
