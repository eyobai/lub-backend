import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { paging } from '../../common/dto/page-query.dto';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  AuditLogDto,
  AuditLogPageDto,
  ListAuditLogsQueryDto,
  ListSecurityEventsQueryDto,
  SecurityEventPageDto,
} from './dto/audit.dto';

const auditInclude = {
  actor: { select: { id: true, phoneNumber: true, profile: { select: { fullName: true } } } },
} satisfies Prisma.AuditLogInclude;
type AuditRow = Prisma.AuditLogGetPayload<{ include: typeof auditInclude }>;

const period = (from?: string, to?: string): Prisma.DateTimeFilter | undefined =>
  from || to ? { gte: from ? new Date(from) : undefined, lt: to ? new Date(to) : undefined } : undefined;

/** Read-only views of the audit log and of security events. Neither can be changed through the API. */
@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async listAuditLogs(query: ListAuditLogsQueryDto): Promise<AuditLogPageDto> {
    const { page, limit, skip } = paging(query);
    const where: Prisma.AuditLogWhereInput = {
      actorId: query.actorId,
      action: query.action ? { startsWith: query.action } : undefined,
      entityType: query.entityType,
      entityId: query.entityId,
      createdAt: period(query.from, query.to),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: auditInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items: rows.map((row) => this.toAuditDto(row)), total, page, limit };
  }

  async getAuditLog(id: string): Promise<AuditLogDto> {
    const row = await this.prisma.auditLog.findUnique({ where: { id }, include: auditInclude });
    if (!row) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Audit record not found');
    return this.toAuditDto(row);
  }

  async listSecurityEvents(query: ListSecurityEventsQueryDto): Promise<SecurityEventPageDto> {
    const { page, limit, skip } = paging(query);
    const where: Prisma.SecurityEventWhereInput = {
      type: query.type,
      userId: query.userId,
      phoneNumber: query.phoneNumber,
      createdAt: period(query.from, query.to),
    };
    const [items, total] = await Promise.all([
      this.prisma.securityEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.securityEvent.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  private toAuditDto(row: AuditRow): AuditLogDto {
    return {
      id: row.id,
      actorType: row.actorType,
      actor: row.actor
        ? { id: row.actor.id, phoneNumber: row.actor.phoneNumber, fullName: row.actor.profile?.fullName ?? null }
        : null,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      before: row.before,
      after: row.after,
      metadata: row.metadata,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      requestId: row.requestId,
      createdAt: row.createdAt,
    };
  }
}
