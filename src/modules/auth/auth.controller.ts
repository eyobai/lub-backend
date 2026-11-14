import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AllowPendingPasswordChange } from '../../common/decorators/allow-pending-password-change.decorator';
import { AuthThrottle } from '../../common/decorators/auth-throttle.decorator';
import { Client } from '../../common/decorators/client-info.decorator';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  LoginDto,
  PhoneOnlyDto,
  RefreshTokenDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyPhoneDto,
} from './dto/auth-request.dto';
import {
  AuthResponseDto,
  AuthUserDto,
  MessageResponseDto,
  OtpRequestedResponseDto,
  RegisterResponseDto,
  TokenPairDto,
} from './dto/auth-response.dto';

const error = (description: string) => ({ description, type: ErrorResponseDto });

@ApiTags('Authentication')
@ApiTooManyRequestsResponse(error('RATE_LIMITED — too many requests from this IP address'))
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Public()
  @AuthThrottle()
  @ApiOperation({
    summary: 'Register with a phone number and password',
    description:
      'Default (PHONE_VERIFICATION_REQUIRED=false): creates the account and signs the user in; no SMS is sent. ' +
      'With phone verification on: creates an unverified account and sends a code by SMS; registering again ' +
      'with a number that was never verified replaces the pending registration.',
  })
  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, INVALID_PHONE_NUMBER'))
  @ApiConflictResponse(error('PHONE_ALREADY_REGISTERED, EMAIL_ALREADY_IN_USE'))
  @ApiTooManyRequestsResponse(error('RATE_LIMITED, OTP_COOLDOWN, OTP_LIMIT_REACHED'))
  register(@Body() dto: RegisterDto, @Client() client: ClientInfo): Promise<RegisterResponseDto> {
    return this.auth.register(dto, client);
  }

  @Post('verify-phone')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the phone number with the SMS code',
    description: 'Marks the phone number as verified and signs the user in.',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse(
    error('VALIDATION_FAILED, INVALID_PHONE_NUMBER, OTP_INVALID, OTP_ATTEMPTS_EXCEEDED, REGISTRATION_SUPERSEDED'),
  )
  @ApiForbiddenResponse(error('ACCOUNT_SUSPENDED, ACCOUNT_BLOCKED'))
  @ApiConflictResponse(error('PHONE_ALREADY_VERIFIED'))
  verifyPhone(@Body() dto: VerifyPhoneDto, @Client() client: ClientInfo): Promise<AuthResponseDto> {
    return this.auth.verifyPhone(dto, client);
  }

  @Post('resend-verification')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send a new phone verification code',
    description: 'Always returns the same response, whether or not the number is registered.',
  })
  @ApiAcceptedResponse({ type: OtpRequestedResponseDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, INVALID_PHONE_NUMBER'))
  resendVerification(@Body() dto: PhoneOnlyDto, @Client() client: ClientInfo): Promise<OtpRequestedResponseDto> {
    return this.auth.resendVerification(dto, client);
  }

  @Post('login')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with phone number and password' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, INVALID_PHONE_NUMBER'))
  @ApiUnauthorizedResponse(error('INVALID_CREDENTIALS'))
  @ApiForbiddenResponse(
    error('PHONE_NOT_VERIFIED (details.verificationToken is included), ACCOUNT_SUSPENDED, ACCOUNT_BLOCKED'),
  )
  @ApiTooManyRequestsResponse(
    error('RATE_LIMITED, or ACCOUNT_LOCKED after repeated failures (details.retryAfterSeconds is included)'),
  )
  login(@Body() dto: LoginDto, @Client() client: ClientInfo): Promise<AuthResponseDto> {
    return this.auth.login(dto, client);
  }

  @Post('refresh')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'Refresh tokens are single-use. Presenting one that was already used revokes the whole session, ' +
      'so the client must always store the newest pair.',
  })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiUnauthorizedResponse(error('INVALID_REFRESH_TOKEN'))
  @ApiForbiddenResponse(error('ACCOUNT_SUSPENDED, ACCOUNT_BLOCKED'))
  refresh(@Body() dto: RefreshTokenDto, @Client() client: ClientInfo): Promise<TokenPairDto> {
    return this.auth.refresh(dto.refreshToken, client);
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out of the current session',
    description: 'Revokes the refresh token and immediately invalidates the access tokens of that session.',
  })
  @ApiNoContentResponse({ description: 'Signed out (also returned when the token was already invalid)' })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  logout(@Body() dto: RefreshTokenDto): Promise<void> {
    return this.auth.logout(dto.refreshToken);
  }

  @Post('logout-all')
  @AllowPendingPasswordChange()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out of every session on every device' })
  @ApiNoContentResponse({ description: 'All sessions revoked' })
  @ApiUnauthorizedResponse(error('UNAUTHORIZED'))
  logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.auth.logoutAll(user.id);
  }

  @Post('forgot-password')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a password-reset code by SMS',
    description: 'Always returns the same response, whether or not the number is registered.',
  })
  @ApiAcceptedResponse({ type: OtpRequestedResponseDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, INVALID_PHONE_NUMBER'))
  forgotPassword(@Body() dto: PhoneOnlyDto, @Client() client: ClientInfo): Promise<OtpRequestedResponseDto> {
    return this.auth.forgotPassword(dto, client);
  }

  @Post('reset-password')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new password using the SMS code',
    description: 'Signs the user out of every session. The user must sign in again with the new password.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, INVALID_PHONE_NUMBER, OTP_INVALID, OTP_ATTEMPTS_EXCEEDED'))
  resetPassword(@Body() dto: ResetPasswordDto, @Client() client: ClientInfo): Promise<MessageResponseDto> {
    return this.auth.resetPassword(dto, client);
  }

  @Post('change-password')
  @AllowPendingPasswordChange()
  @ApiBearerAuth()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change the password while signed in',
    description:
      'Signs out every existing session and returns tokens for a new one. After staff reset a password ' +
      '(`user.mustChangePassword` is true), every other route answers 403 PASSWORD_CHANGE_REQUIRED until this succeeds.',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, PASSWORD_REUSED'))
  @ApiUnauthorizedResponse(error('UNAUTHORIZED, INVALID_CREDENTIALS (current password is wrong)'))
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Client() client: ClientInfo,
  ): Promise<AuthResponseDto> {
    return this.auth.changePassword(user.id, dto, client);
  }

  @Get('me')
  @AllowPendingPasswordChange()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the signed-in user' })
  @ApiOkResponse({ type: AuthUserDto })
  @ApiUnauthorizedResponse(error('UNAUTHORIZED'))
  @ApiForbiddenResponse(error('ACCOUNT_SUSPENDED, ACCOUNT_BLOCKED'))
  me(@CurrentUser() user: AuthenticatedUser): Promise<AuthUserDto> {
    return this.auth.me(user.id);
  }
}
