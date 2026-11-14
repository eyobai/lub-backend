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
import { BiddingService } from './bidding.service';
import { AdminBidPageDto, AdminListBidsQueryDto } from './dto/bid.dto';

const error = (description: string) => ({ description, type: ErrorResponseDto });

@ApiTags('Admin: Auctions')
@ApiBearerAuth()
@ApiBadRequestResponse(error('VALIDATION_FAILED — a malformed id, query parameter or body'))
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@ApiForbiddenResponse(error('FORBIDDEN — the signed-in user lacks the required role'))
@Controller('admin/auctions')
export class AdminBidsController {
  constructor(private readonly bidding: BiddingService) {}

  @Get(':id/bids')
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({
    summary: 'List the bids of an auction',
    description: 'Roles: SUPPORT, FINANCE, ADMIN. In the order the bids were accepted.',
  })
  @ApiOkResponse({ type: AdminBidPageDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  list(@Param('id', ParseUUIDPipe) id: string, @Query() query: AdminListBidsQueryDto): Promise<AdminBidPageDto> {
    return this.bidding.listForAuction(id, query);
  }
}
