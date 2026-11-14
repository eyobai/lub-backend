import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { AuctionsService } from './auctions.service';
import { AuctionDto, AuctionPageDto, ListAuctionsQueryDto } from './dto/auction.dto';

const error = (description: string) => ({ description, type: ErrorResponseDto });

@ApiTags('Auctions')
@Public()
@Controller('auctions')
export class AuctionsController {
  constructor(private readonly auctions: AuctionsService) {}

  @Get()
  @ApiOperation({
    summary: 'List auctions',
    description:
      'No sign-in needed. Shows upcoming, running and finished auctions; drafts are never listed. ' +
      'Each item carries the bid fee, the allowed bid range and the number of bids so far.',
  })
  @ApiOkResponse({ type: AuctionPageDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  list(@Query() query: ListAuctionsQueryDto): Promise<AuctionPageDto> {
    return this.auctions.listPublic(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get an auction',
    description: 'No sign-in needed. A cancelled auction stays visible here only if it had been open for bidding.',
  })
  @ApiOkResponse({ type: AuctionDto })
  @ApiNotFoundResponse(error('NOT_FOUND — no such auction, or it is not public'))
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AuctionDto> {
    return this.auctions.getPublic(id);
  }
}
