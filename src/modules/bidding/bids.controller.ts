import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
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
import type { Response } from 'express';
import { Client } from '../../common/decorators/client-info.decorator';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { BiddingService } from './bidding.service';
import { BidSubmissionDto, ListMyBidsQueryDto, MyBidPageDto, PlaceBidsDto } from './dto/bid.dto';

const error = (description: string) => ({ description, type: ErrorResponseDto });
const REPLAYED_HEADER = 'Idempotent-Replayed';

@ApiTags('Bids')
@ApiBearerAuth()
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@Controller()
export class BidsController {
  constructor(private readonly bidding: BiddingService) {}

  @Post('auctions/:id/bids')
  @ApiOperation({
    summary: 'Place one or several bids',
    description:
      'Charges one bid fee per amount from the wallet and records one bid per amount, all or nothing: if ' +
      'anything is wrong (an invalid or repeated amount, not enough balance, bidding closed) no bid is ' +
      'recorded and nothing is charged. The fee, the allowed range and the deadline are taken from the ' +
      'server, never from the request. Bids cannot be changed or withdrawn.',
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'Unique key for this bid request (e.g. a UUID). Retrying with the same key returns the original result ' +
      `with the response header \`${REPLAYED_HEADER}: true\` and charges nothing.`,
  })
  @ApiCreatedResponse({ type: BidSubmissionDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, IDEMPOTENCY_KEY_REQUIRED'))
  @ApiForbiddenResponse(error('WALLET_FROZEN, or FORBIDDEN for staff accounts'))
  @ApiNotFoundResponse(error('NOT_FOUND — no such auction, or it is not public'))
  @ApiConflictResponse(
    error('AUCTION_NOT_OPEN, AUCTION_CLOSED, DUPLICATE_BID — `details.amountsMinor` lists the amounts already bid'),
  )
  @ApiUnprocessableEntityResponse(
    error('BID_AMOUNT_INVALID, BID_LIMIT_EXCEEDED, INSUFFICIENT_FUNDS, IDEMPOTENCY_KEY_REUSED'),
  )
  async place(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) auctionId: string,
    @Body() dto: PlaceBidsDto,
    @IdempotencyKey() idempotencyKey: string,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BidSubmissionDto> {
    const { submission, replayed } = await this.bidding.place(
      user,
      auctionId,
      dto.amountsMinor,
      idempotencyKey,
      client,
    );
    if (replayed) res.setHeader(REPLAYED_HEADER, 'true');
    res.status(HttpStatus.CREATED);
    return submission;
  }

  @Get('bids/mine')
  @ApiOperation({
    summary: 'List my bids',
    description: 'My own bids, newest first, across all auctions or in one. Other users’ bids are never shown.',
  })
  @ApiOkResponse({ type: MyBidPageDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  listMine(@CurrentUser() user: AuthenticatedUser, @Query() query: ListMyBidsQueryDto): Promise<MyBidPageDto> {
    return this.bidding.listMine(user.id, query);
  }
}
