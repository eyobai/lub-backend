import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Client } from '../../common/decorators/client-info.decorator';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { MyWinDto, MyWinPageDto, PublicWinnerPageDto, SubmitDeliveryDetailsDto } from './dto/winner.dto';
import { WinnersService } from './winners.service';

const error = (description: string) => ({ description, type: ErrorResponseDto });

@ApiTags('Winners')
@Controller('winners')
export class WinnersController {
  constructor(private readonly winners: WinnersService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'List recent winners',
    description:
      'No sign-in needed. Only winners an admin has verified and published, newest first. The winner is ' +
      'shown as a phone number with the middle digits hidden.',
  })
  @ApiOkResponse({ type: PublicWinnerPageDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  list(@Query() query: PageQueryDto): Promise<PublicWinnerPageDto> {
    return this.winners.listPublished(query);
  }

  @Get('mine')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List my wins',
    description: 'Auctions I won, with the verification status and the progress of the prize delivery.',
  })
  @ApiOkResponse({ type: MyWinPageDto })
  @ApiUnauthorizedResponse(error('UNAUTHORIZED'))
  listMine(@CurrentUser() user: AuthenticatedUser, @Query() query: PageQueryDto): Promise<MyWinPageDto> {
    return this.winners.listMine(user.id, query);
  }

  @Put('mine/:id/delivery-details')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Send my delivery details',
    description:
      'Who receives the prize and where. Possible once the win is verified and until staff have confirmed ' +
      'the details (delivery status PENDING or CONTACTED). Sending again replaces the earlier details.',
  })
  @ApiOkResponse({ type: MyWinDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiUnauthorizedResponse(error('UNAUTHORIZED'))
  @ApiNotFoundResponse(error('NOT_FOUND — no such win of mine'))
  @ApiConflictResponse(error('WINNER_INVALID_STATE — not verified yet; DELIVERY_INVALID_STATE — already confirmed'))
  submitDeliveryDetails(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitDeliveryDetailsDto,
    @Client() client: ClientInfo,
  ): Promise<MyWinDto> {
    return this.winners.submitMyDeliveryDetails(user.id, id, dto, client);
  }
}
