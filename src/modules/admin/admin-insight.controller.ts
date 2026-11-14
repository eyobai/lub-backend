import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { AdminAuditService } from './admin-audit.service';
import { AdminDashboardService } from './admin-dashboard.service';
import {
  AuditLogDto,
  AuditLogPageDto,
  ListAuditLogsQueryDto,
  ListSecurityEventsQueryDto,
  SecurityEventPageDto,
} from './dto/audit.dto';
import { AuctionStatisticsDto, DashboardDto } from './dto/dashboard.dto';

const error = (description: string) => ({ description, type: ErrorResponseDto });

/** Read-only back-office views: dashboard figures, auction statistics, the audit log and security events. */
@ApiTags('Admin: Monitoring')
@ApiBearerAuth()
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@ApiForbiddenResponse(error('FORBIDDEN — the signed-in user lacks the required role'))
@Controller('admin')
export class AdminInsightController {
  constructor(
    private readonly dashboards: AdminDashboardService,
    private readonly audits: AdminAuditService,
  ) {}

  @Get('dashboard')
  @Roles(RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({
    summary: 'Dashboard figures',
    description:
      'Roles: FINANCE, ADMIN. Users, auctions, bids, winners and deliveries by status, and per currency the ' +
      'revenue from bid fees and the money held in user wallets. Periods are measured by the database clock.',
  })
  @ApiOkResponse({ type: DashboardDto })
  dashboard(): Promise<DashboardDto> {
    return this.dashboards.dashboard();
  }

  @Get('auctions/:id/statistics')
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({
    summary: 'Bidding statistics of one auction',
    description: 'Roles: SUPPORT, FINANCE, ADMIN. Available while the auction is running and afterwards.',
  })
  @ApiOkResponse({ type: AuctionStatisticsDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  auctionStatistics(@Param('id', ParseUUIDPipe) id: string): Promise<AuctionStatisticsDto> {
    return this.dashboards.auctionStatistics(id);
  }

  @Get('audit-logs')
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'List audit records',
    description:
      'Role: ADMIN. Every back-office action with who did it, when, from where, and the values before and after. ' +
      'Newest first. Records cannot be changed or deleted.',
  })
  @ApiOkResponse({ type: AuditLogPageDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  auditLogs(@Query() query: ListAuditLogsQueryDto): Promise<AuditLogPageDto> {
    return this.audits.listAuditLogs(query);
  }

  @Get('audit-logs/:id')
  @Roles(RoleName.ADMIN)
  @ApiOperation({ summary: 'Get an audit record', description: 'Role: ADMIN.' })
  @ApiOkResponse({ type: AuditLogDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  auditLog(@Param('id', ParseUUIDPipe) id: string): Promise<AuditLogDto> {
    return this.audits.getAuditLog(id);
  }

  @Get('security-events')
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'List security events',
    description:
      'Role: ADMIN. Sign-ins, failed sign-ins, lockouts, refresh-token reuse, password changes and resets. Newest first.',
  })
  @ApiOkResponse({ type: SecurityEventPageDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  securityEvents(@Query() query: ListSecurityEventsQueryDto): Promise<SecurityEventPageDto> {
    return this.audits.listSecurityEvents(query);
  }
}
