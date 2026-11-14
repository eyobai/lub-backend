import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { AuctionResultDto, MyAuctionResultDto } from './dto/result.dto';
import { ResultsService } from './results.service';

const error = (description: string) => ({ description, type: ErrorResponseDto });

@ApiTags('Results')
@Controller('auctions')
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  @Get(':id/result')
  @Public()
  @ApiOperation({
    summary: 'Get the result of a finished auction',
    description:
      'No sign-in needed. Shows the outcome, the winning amount and the number of bids. It never shows who ' +
      'won or what anyone else bid.',
  })
  @ApiOkResponse({ type: AuctionResultDto })
  @ApiNotFoundResponse(error('NOT_FOUND — no such auction, or it is not public'))
  @ApiConflictResponse(error('RESULT_NOT_AVAILABLE — the auction has not finished, or it was cancelled'))
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AuctionResultDto> {
    return this.results.getPublic(id);
  }

  @Get(':id/result/mine')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get my result in a finished auction',
    description: 'The result plus whether I won, and for each of my bids whether it won, was unique or was not unique.',
  })
  @ApiOkResponse({ type: MyAuctionResultDto })
  @ApiUnauthorizedResponse(error('UNAUTHORIZED'))
  @ApiNotFoundResponse(error('NOT_FOUND — no such auction, or it is not public'))
  @ApiConflictResponse(error('RESULT_NOT_AVAILABLE — the auction has not finished, or it was cancelled'))
  getMine(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string): Promise<MyAuctionResultDto> {
    return this.results.getMine(user.id, id);
  }
}
