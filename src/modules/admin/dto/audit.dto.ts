import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ActorType, SecurityEventType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto';
import { Trim } from '../../../common/utils/trim.transform';
import { IsInstant } from '../../../common/validators/validators';

class PeriodQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ example: '2027-01-01T00:00:00+03:00', description: 'Only entries at or after this time' })
  @IsOptional()
  @IsInstant()
  from?: string;

  @ApiPropertyOptional({ example: '2027-02-01T00:00:00+03:00', description: 'Only entries before this time' })
  @IsOptional()
  @IsInstant()
  to?: string;
}

export class ListAuditLogsQueryDto extends PeriodQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only actions performed by this user' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({
    example: 'user.',
    description: 'An action name or the start of one: `user.` matches `user.suspend`, `user.roles.set`, …',
  })
  @IsOptional()
  @Trim()
  @Matches(/^[A-Za-z0-9_.-]{1,100}$/, {
    message: 'action may only contain letters, digits, dots, dashes and underscores',
  })
  action?: string;

  @ApiPropertyOptional({ example: 'auction', description: 'user, auction, product, wallet or winner' })
  @IsOptional()
  @Trim()
  @Matches(/^[A-Za-z]{1,50}$/, { message: 'entityType must be a word such as user or auction' })
  entityType?: string;

  @ApiPropertyOptional({ description: 'Id of the affected record. Combine with `entityType`.' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  entityId?: string;
}

export class AuditActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+251911234567' })
  phoneNumber!: string;

  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;
}

export class AuditLogDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ActorType })
  actorType!: ActorType;

  @ApiProperty({ type: AuditActorDto, nullable: true, description: 'null for actions of the system itself' })
  actor!: AuditActorDto | null;

  @ApiProperty({ example: 'user.suspend' })
  action!: string;

  @ApiProperty({ example: 'user' })
  entityType!: string;

  @ApiProperty({ type: String, nullable: true })
  entityId!: string | null;

  @ApiProperty({ type: Object, nullable: true, description: 'Relevant values before the action' })
  before!: unknown;

  @ApiProperty({ type: Object, nullable: true, description: 'Relevant values after the action' })
  after!: unknown;

  @ApiProperty({ type: Object, nullable: true, description: 'Extra context, e.g. the reason given' })
  metadata!: unknown;

  @ApiProperty({ type: String, nullable: true })
  ipAddress!: string | null;

  @ApiProperty({ type: String, nullable: true })
  userAgent!: string | null;

  @ApiProperty({ type: String, nullable: true })
  requestId!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class AuditLogPageDto {
  @ApiProperty({ type: [AuditLogDto] })
  items!: AuditLogDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class ListSecurityEventsQueryDto extends PeriodQueryDto {
  @ApiPropertyOptional({ enum: SecurityEventType })
  @IsOptional()
  @IsEnum(SecurityEventType)
  type?: SecurityEventType;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only events of this account' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ example: '+251911234567', description: 'Exact number in international format' })
  @IsOptional()
  @Trim()
  @Matches(/^\+[0-9]{7,15}$/, { message: 'phoneNumber must be in international format, e.g. +251911234567' })
  phoneNumber?: string;
}

export class SecurityEventDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: SecurityEventType })
  type!: SecurityEventType;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  userId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phoneNumber!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ipAddress!: string | null;

  @ApiProperty({ type: String, nullable: true })
  userAgent!: string | null;

  @ApiProperty({ type: Object, nullable: true })
  metadata!: unknown;

  @ApiProperty()
  createdAt!: Date;
}

export class SecurityEventPageDto {
  @ApiProperty({ type: [SecurityEventDto] })
  items!: SecurityEventDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}
