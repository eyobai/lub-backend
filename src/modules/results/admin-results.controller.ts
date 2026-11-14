import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Client } from '../../common/decorators/client-info.decorator';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { AdminAuctionResultDto, ResultAuditDto } from './dto/result.dto';
import { ResultsService } from './results.service';

const error = (description: string) => ({ description, type: ErrorResponseDto });

@ApiTags('Admin: Auctions')
@ApiBearerAuth()
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@ApiForbiddenResponse(error('FORBIDDEN — the signed-in user lacks the required role'))
@Controller('admin/auctions')
export class AdminResultsController {
  constructor(private readonly results: ResultsService) {}

  @Get(':id/result')
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({
    summary: 'Get the full result of an auction',
    description:
      'Roles: SUPPORT, FINANCE, ADMIN. Includes the winner and everything the calculation used: how many ' +
      'bids each amount received, and a fingerprint of that input.',
  })
  @ApiOkResponse({ type: AdminAuctionResultDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('RESULT_NOT_AVAILABLE'))
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminAuctionResultDto> {
    return this.results.getForAdmin(id);
  }

  @Get(':id/result/audit')
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({
    summary: 'Re-check the result of an auction',
    description:
      'Roles: SUPPORT, FINANCE, ADMIN. Recomputes the result from the bids on record and compares it with ' +
      'the recorded one. Changes nothing.',
  })
  @ApiOkResponse({ type: ResultAuditDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('RESULT_NOT_AVAILABLE'))
  audit(@Param('id', ParseUUIDPipe) id: string): Promise<ResultAuditDto> {
    return this.results.auditResult(id);
  }

  @Post(':id/finalize')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Compute the result of an auction now',
    description:
      'Role: ADMIN. Normally the background job does this within seconds of the closing time; use this if ' +
      'it has not. Only works once bidding has closed. Calling it on a finished auction returns the ' +
      'existing result and changes nothing.',
  })
  @ApiOkResponse({ type: AdminAuctionResultDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('AUCTION_INVALID_STATE — bidding has not closed, or the auction is a draft or cancelled'))
  @ApiUnprocessableEntityResponse(error('AUCTION_NOT_READY — no usable no-unique-bid policy is set'))
  async finalize(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ): Promise<AdminAuctionResultDto> {
    await this.results.finalize(id, { id: user.id, client });
    return this.results.getForAdmin(id);
  }
}
