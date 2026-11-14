import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AccountStatus, RoleName } from '@prisma/client';
import { Client } from '../../common/decorators/client-info.decorator';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { AdminUsersService } from './admin-users.service';
import {
  AdminListUsersQueryDto,
  AdminUserDetailDto,
  AdminUserPageDto,
  PasswordResetResultDto,
  ReasonDto,
  SessionsRevokedDto,
  SetRolesDto,
} from './dto/admin-user.dto';

const error = (description: string) => ({ description, type: ErrorResponseDto });
const MANAGE_RULES =
  'Nobody can do this to their own account, and only a SUPER_ADMIN can do it to a staff account (403 FORBIDDEN).';

/**
 * Reading is open to back-office staff. Account status is changed by ADMIN, passwords and sessions by
 * SUPPORT and ADMIN, roles by SUPER_ADMIN only.
 */
@ApiTags('Admin: Users')
@ApiBearerAuth()
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@ApiForbiddenResponse(error('FORBIDDEN — the signed-in user lacks the required role, or may not manage this account'))
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({
    summary: 'List users',
    description: 'Roles: SUPPORT, FINANCE, ADMIN. Newest first. Search by phone number, name or email.',
  })
  @ApiOkResponse({ type: AdminUserPageDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  list(@Query() query: AdminListUsersQueryDto): Promise<AdminUserPageDto> {
    return this.users.list(query);
  }

  @Get(':id')
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({ summary: 'Get a user', description: 'Roles: SUPPORT, FINANCE, ADMIN.' })
  @ApiOkResponse({ type: AdminUserDetailDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminUserDetailDto> {
    return this.users.get(id);
  }

  @Post(':id/suspend')
  @Roles(RoleName.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend an account',
    description: `Role: ADMIN. A temporary measure: the user is signed out everywhere and cannot sign in. ${MANAGE_RULES}`,
  })
  @ApiOkResponse({ type: AdminUserDetailDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('ACCOUNT_INVALID_STATE (already suspended)'))
  suspend(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @Client() client: ClientInfo,
  ): Promise<AdminUserDetailDto> {
    return this.users.setStatus(actor, id, AccountStatus.SUSPENDED, dto.reason, client);
  }

  @Post(':id/block')
  @Roles(RoleName.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Block an account',
    description: `Role: ADMIN. For fraud or abuse: the user is signed out everywhere and cannot sign in. ${MANAGE_RULES}`,
  })
  @ApiOkResponse({ type: AdminUserDetailDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('ACCOUNT_INVALID_STATE (already blocked)'))
  block(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @Client() client: ClientInfo,
  ): Promise<AdminUserDetailDto> {
    return this.users.setStatus(actor, id, AccountStatus.BLOCKED, dto.reason, client);
  }

  @Post(':id/reactivate')
  @Roles(RoleName.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reactivate a suspended or blocked account',
    description: `Role: ADMIN. The user can sign in again. ${MANAGE_RULES}`,
  })
  @ApiOkResponse({ type: AdminUserDetailDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('ACCOUNT_INVALID_STATE (already active)'))
  reactivate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @Client() client: ClientInfo,
  ): Promise<AdminUserDetailDto> {
    return this.users.setStatus(actor, id, AccountStatus.ACTIVE, dto.reason, client);
  }

  @Put(':id/roles')
  @Roles(RoleName.SUPER_ADMIN)
  @ApiOperation({
    summary: "Set an account's back-office roles",
    description:
      'Role: SUPER_ADMIN only. Send the complete list of SUPPORT, FINANCE, ADMIN and SUPER_ADMIN roles the account ' +
      'should hold; an empty list makes it an ordinary user. The account is signed out everywhere. ' +
      'You cannot change your own roles, so there is always at least one SUPER_ADMIN.',
  })
  @ApiOkResponse({ type: AdminUserDetailDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND'))
  setRoles(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRolesDto,
    @Client() client: ClientInfo,
  ): Promise<AdminUserDetailDto> {
    return this.users.setRoles(actor, id, dto.roles, dto.reason, client);
  }

  @Post(':id/reset-password')
  @Roles(RoleName.SUPPORT, RoleName.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Reset a user's password",
    description:
      'Roles: SUPPORT, ADMIN. Confirm who the user is first. Returns a random temporary password once; it is not ' +
      'stored in readable form anywhere. The user is signed out everywhere and, after signing in with it, must ' +
      `choose a new password before doing anything else. ${MANAGE_RULES}`,
  })
  @ApiOkResponse({ type: PasswordResetResultDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND'))
  resetPassword(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @Client() client: ClientInfo,
  ): Promise<PasswordResetResultDto> {
    return this.users.resetPassword(actor, id, dto.reason, client);
  }

  @Post(':id/revoke-sessions')
  @Roles(RoleName.SUPPORT, RoleName.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign a user out of every device',
    description: `Roles: SUPPORT, ADMIN. For a lost or stolen phone. The password is unchanged. ${MANAGE_RULES}`,
  })
  @ApiOkResponse({ type: SessionsRevokedDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND'))
  revokeSessions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @Client() client: ClientInfo,
  ): Promise<SessionsRevokedDto> {
    return this.users.revokeSessions(actor, id, dto.reason, client);
  }
}
