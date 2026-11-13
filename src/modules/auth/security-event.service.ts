import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SecurityEventType } from '@prisma/client';
import { ClientInfo } from '../../common/decorators/client-info.decorator';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class SecurityEventService {
  private readonly logger = new Logger(SecurityEventService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Best-effort: a failure to record must never break the request it describes. */
  async record(
    type: SecurityEventType,
    data: { userId?: string; phoneNumber?: string; client?: ClientInfo; metadata?: Prisma.InputJsonValue },
  ): Promise<void> {
    try {
      await this.prisma.securityEvent.create({
        data: {
          type,
          userId: data.userId,
          phoneNumber: data.phoneNumber,
          ipAddress: data.client?.ipAddress,
          userAgent: data.client?.userAgent,
          metadata: data.metadata,
        },
      });
    } catch (err) {
      this.logger.error({ err, type }, 'Failed to record security event');
    }
  }
}
