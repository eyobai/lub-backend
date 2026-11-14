import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, RoleName } from '@prisma/client';

export class OtpInfoDto {
  @ApiProperty({ example: 300 })
  expiresInSeconds!: number;

  @ApiProperty({ example: 60, description: 'Seconds to wait before another code can be requested' })
  resendAvailableInSeconds!: number;
}

export class OtpRequestedResponseDto {
  @ApiProperty({ example: 'If the phone number is eligible, a verification code has been sent.' })
  message!: string;

  @ApiProperty({ type: OtpInfoDto })
  otp!: OtpInfoDto;
}

export class MessageResponseDto {
  @ApiProperty({ example: 'Password has been reset. Please sign in with your new password.' })
  message!: string;
}

export class AuthUserDto {
  @ApiProperty({ example: '6a0f5c0e-6f1f-4b0f-9d0a-0d5c1d7a3b11' })
  id!: string;

  @ApiProperty({ example: '+251911234567' })
  phoneNumber!: string;

  @ApiProperty({ example: true })
  phoneVerified!: boolean;

  @ApiProperty({ enum: AccountStatus, example: AccountStatus.ACTIVE })
  status!: AccountStatus;

  @ApiProperty({ enum: RoleName, isArray: true, example: [RoleName.USER] })
  roles!: RoleName[];

  @ApiProperty({
    example: false,
    description: 'true after staff reset the password: call POST /auth/change-password before anything else.',
  })
  mustChangePassword!: boolean;

  @ApiPropertyOptional({ example: 'Abebe Kebede', nullable: true })
  fullName!: string | null;

  @ApiPropertyOptional({ example: 'abebe@example.com', nullable: true })
  email!: string | null;

  @ApiProperty({ example: '2026-01-01T12:00:00.000Z' })
  createdAt!: Date;
}

export class TokenPairDto {
  @ApiProperty({ description: 'Short-lived JWT. Send as "Authorization: Bearer <token>".' })
  accessToken!: string;

  @ApiProperty({ description: 'Single-use JWT used to obtain a new token pair.' })
  refreshToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 900, description: 'Access-token lifetime in seconds' })
  expiresIn!: number;

  @ApiProperty({ example: 2592000, description: 'Refresh-token lifetime in seconds' })
  refreshExpiresIn!: number;
}

export class AuthResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;

  @ApiProperty({ type: TokenPairDto })
  tokens!: TokenPairDto;
}

export class RegisterResponseDto {
  @ApiProperty({ example: '6a0f5c0e-6f1f-4b0f-9d0a-0d5c1d7a3b11' })
  userId!: string;

  @ApiProperty({ example: '+251911234567' })
  phoneNumber!: string;

  @ApiProperty({
    example: false,
    description:
      'false: the account is ready and `user` + `tokens` are returned. ' +
      'true: confirm the SMS code with POST /auth/verify-phone using `verificationToken`.',
  })
  verificationRequired!: boolean;

  @ApiPropertyOptional({ type: AuthUserDto, description: 'Present when verificationRequired is false' })
  user?: AuthUserDto;

  @ApiPropertyOptional({ type: TokenPairDto, description: 'Present when verificationRequired is false' })
  tokens?: TokenPairDto;

  @ApiPropertyOptional({
    example: 'q0J8m1mJ0V8n3zq5yQ0b6Jr5mF4oT2c1x9KpLw7HdEs',
    description: 'Present when verificationRequired is true. Send it to POST /auth/verify-phone with the SMS code.',
  })
  verificationToken?: string;

  @ApiPropertyOptional({ type: OtpInfoDto, description: 'Present when verificationRequired is true' })
  otp?: OtpInfoDto;
}
