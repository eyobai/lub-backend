import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto';

export class ListNotificationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'true: only notifications not read yet' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  unreadOnly?: boolean;

  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;
}

export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: NotificationType })
  type!: NotificationType;

  @ApiProperty({ example: 'You won!' })
  title!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Identifiers for linking to the right screen, e.g. `auctionId`, `winnerId`, `transactionId`.',
    example: { auctionId: 'b7d1c2de-0f0a-4a53-9b1e-5d6f6f1c2a10', outcome: 'WINNER_FOUND' },
  })
  data!: Record<string, unknown> | null;

  @ApiProperty()
  read!: boolean;

  @ApiProperty({ type: Date, nullable: true })
  readAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationDto] })
  items!: NotificationDto[];

  @ApiProperty({ description: 'Notifications matching the filters' })
  total!: number;

  @ApiProperty({ description: 'All my unread notifications, whatever the filters' })
  unread!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class UnreadCountDto {
  @ApiProperty()
  unread!: number;
}

export class MarkAllReadDto {
  @ApiProperty({ description: 'How many notifications were marked as read' })
  updated!: number;
}
