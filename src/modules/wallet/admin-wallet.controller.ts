import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { Response } from 'express';
import { Client } from '../../common/decorators/client-info.decorator';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { ReconciliationService } from '../ledger/reconciliation.service';
import {
  AdjustWalletDto,
  ListWalletTransactionsQueryDto,
  ReasonDto,
  ReconciliationReportDto,
  WalletDto,
  WalletQueryDto,
  WalletTransactionDto,
  WalletTransactionPageDto,
} from './dto/wallet.dto';
import { WalletService } from './wallet.service';

const error = (description: string) => ({ description, type: ErrorResponseDto });
const REPLAYED_HEADER = 'Idempotent-Replayed';
const idempotencyHeader = () =>
  ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'Unique key for this operation (e.g. a UUID). Retrying with the same key returns the original result ' +
      `with the response header \`${REPLAYED_HEADER}: true\` and moves no money.`,
  });

/** Reading wallets is open to back-office staff; moving money or freezing is limited to FINANCE (and SUPER_ADMIN). */
@ApiTags('Admin: Wallets')
@ApiBearerAuth()
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@ApiForbiddenResponse(error('FORBIDDEN — the signed-in user lacks the required role'))
@Controller('admin')
export class AdminWalletController {
  constructor(
    private readonly wallets: WalletService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Get('wallets/:userId')
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({ summary: "Get a user's wallet balance", description: 'Roles: SUPPORT, FINANCE, ADMIN.' })
  @ApiOkResponse({ type: WalletDto })
  @ApiNotFoundResponse(error('NOT_FOUND — no such user'))
  getWallet(@Param('userId', ParseUUIDPipe) userId: string, @Query() query: WalletQueryDto): Promise<WalletDto> {
    return this.wallets.getWalletForAdmin(userId, query.currency);
  }

  @Get('wallets/:userId/transactions')
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({ summary: "List a user's wallet transactions", description: 'Roles: SUPPORT, FINANCE, ADMIN.' })
  @ApiOkResponse({ type: WalletTransactionPageDto })
  @ApiNotFoundResponse(error('NOT_FOUND — no such user'))
  listTransactions(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: ListWalletTransactionsQueryDto,
  ): Promise<WalletTransactionPageDto> {
    return this.wallets.listTransactionsForAdmin(userId, query);
  }

  @Post('wallets/:userId/adjustments')
  @Roles(RoleName.FINANCE)
  @idempotencyHeader()
  @ApiOperation({
    summary: "Manually credit or debit a user's wallet",
    description:
      'Role: FINANCE. Posts a balanced ADJUSTMENT journal and an audit-log record in one database transaction. ' +
      'Staff cannot adjust their own wallet. A debit can never take the balance below zero.',
  })
  @ApiCreatedResponse({ type: WalletTransactionDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, IDEMPOTENCY_KEY_REQUIRED, CURRENCY_NOT_SUPPORTED'))
  @ApiNotFoundResponse(error('NOT_FOUND — no such user'))
  @ApiUnprocessableEntityResponse(error('INSUFFICIENT_FUNDS, IDEMPOTENCY_KEY_REUSED'))
  async adjust(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdjustWalletDto,
    @IdempotencyKey() idempotencyKey: string,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WalletTransactionDto> {
    const { transaction, replayed } = await this.wallets.adjust(actor.id, userId, dto, idempotencyKey, client);
    if (replayed) res.setHeader(REPLAYED_HEADER, 'true');
    return transaction;
  }

  @Post('wallet-transactions/:id/reverse')
  @Roles(RoleName.FINANCE)
  @idempotencyHeader()
  @ApiOperation({
    summary: 'Reverse a manual adjustment',
    description:
      'Role: FINANCE. Posts a mirror-image journal and marks the original REVERSED; nothing is edited or deleted. ' +
      'Only ADJUSTMENT transactions can be reversed here, and only once.',
  })
  @ApiCreatedResponse({ type: WalletTransactionDto, description: 'The new reversing transaction' })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, IDEMPOTENCY_KEY_REQUIRED'))
  @ApiNotFoundResponse(error('NOT_FOUND — no such transaction'))
  @ApiConflictResponse(error('TRANSACTION_ALREADY_REVERSED, TRANSACTION_NOT_REVERSIBLE'))
  @ApiUnprocessableEntityResponse(error('INSUFFICIENT_FUNDS — the credited money has already been spent'))
  async reverse(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @IdempotencyKey() idempotencyKey: string,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WalletTransactionDto> {
    const { transaction, replayed } = await this.wallets.reverseAdjustment(
      actor.id,
      id,
      dto.reason,
      idempotencyKey,
      client,
    );
    if (replayed) res.setHeader(REPLAYED_HEADER, 'true');
    return transaction;
  }

  @Post('wallets/:userId/freeze')
  @Roles(RoleName.FINANCE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Freeze a user's wallet",
    description: 'Role: FINANCE. A frozen wallet still receives money but cannot spend or withdraw it. Audited.',
  })
  @ApiOkResponse({ type: WalletDto })
  @ApiNotFoundResponse(error('NOT_FOUND — no such user'))
  freeze(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReasonDto,
    @Query() query: WalletQueryDto,
    @Client() client: ClientInfo,
  ): Promise<WalletDto> {
    return this.wallets.setFrozen(actor.id, userId, true, dto.reason, client, query.currency);
  }

  @Post('wallets/:userId/unfreeze')
  @Roles(RoleName.FINANCE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Unfreeze a user's wallet", description: 'Role: FINANCE. Audited.' })
  @ApiOkResponse({ type: WalletDto })
  @ApiNotFoundResponse(error('NOT_FOUND — no such user'))
  unfreeze(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReasonDto,
    @Query() query: WalletQueryDto,
    @Client() client: ClientInfo,
  ): Promise<WalletDto> {
    return this.wallets.setFrozen(actor.id, userId, false, dto.reason, client, query.currency);
  }

  @Get('ledger/reconciliation')
  @Roles(RoleName.FINANCE)
  @ApiOperation({
    summary: 'Reconcile the ledger',
    description:
      'Role: FINANCE. Recomputes every account balance from the immutable ledger lines and compares it with the ' +
      'cached balance; also checks that every journal balances and that the books net to zero per currency.',
  })
  @ApiOkResponse({ type: ReconciliationReportDto })
  async reconcile(): Promise<ReconciliationReportDto> {
    const report = await this.reconciliation.reconcile();
    return {
      ...report,
      totals: report.totals.map((t) => ({ ...t, balanceMinor: t.balanceMinor.toString() })),
    };
  }
}
