import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import {
  ListWalletTransactionsQueryDto,
  WalletDto,
  WalletQueryDto,
  WalletTransactionDto,
  WalletTransactionPageDto,
} from './dto/wallet.dto';
import { WalletService } from './wallet.service';

const error = (description: string) => ({ description, type: ErrorResponseDto });

@ApiTags('Wallet')
@ApiBearerAuth()
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get()
  @ApiOperation({
    summary: 'Get my wallet balance',
    description: 'The wallet is created automatically the first time it is needed.',
  })
  @ApiOkResponse({ type: WalletDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, CURRENCY_NOT_SUPPORTED'))
  getWallet(@CurrentUser() user: AuthenticatedUser, @Query() query: WalletQueryDto): Promise<WalletDto> {
    return this.wallets.getWallet(user.id, query.currency);
  }

  @Get('transactions')
  @ApiOperation({
    summary: 'List my wallet transactions',
    description: 'Newest first. Every change to the balance appears here with the balance it left behind.',
  })
  @ApiOkResponse({ type: WalletTransactionPageDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, CURRENCY_NOT_SUPPORTED'))
  listTransactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListWalletTransactionsQueryDto,
  ): Promise<WalletTransactionPageDto> {
    return this.wallets.listTransactions(user.id, query);
  }

  @Get('transactions/:id')
  @ApiOperation({ summary: 'Get one of my wallet transactions' })
  @ApiOkResponse({ type: WalletTransactionDto })
  @ApiNotFoundResponse(error('NOT_FOUND — no such transaction in my wallet'))
  getTransaction(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WalletTransactionDto> {
    return this.wallets.getTransaction(user.id, id);
  }
}
