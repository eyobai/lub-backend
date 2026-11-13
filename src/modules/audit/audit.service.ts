import { Injectable } from '@nestjs/common';
import { ActorType, Prisma } from '@prisma/client';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';

export interface AuditRecord {
  actorId?: string;
  actorType: ActorType;
  /** Dotted verb, e.g. "wallet.adjust". */
  action: string;
  entityType: string;
  entityId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
  client?: ClientInfo;
}

@Injectable()
export class AuditService {
  /** Writes inside the caller's transaction, so an action and its audit record commit or roll back together. */
  async record(tx: Prisma.TransactionClient, record: AuditRecord): Promise<void> {
    const { client, ...data } = record;
    await tx.auditLog.create({
      data: { ...data, ipAddress: client?.ipAddress, userAgent: client?.userAgent, requestId: client?.requestId },
    });
  }
}
