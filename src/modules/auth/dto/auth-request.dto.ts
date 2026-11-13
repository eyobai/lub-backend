import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsJWT, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Trim } from '../../../common/utils/trim.transform';

const PHONE_DESCRIPTION =
  'Ethiopian mobile number. Accepted formats: +251911234567, 251911234567, 0911234567, 911234567. Stored as E.164.';

function Phone() {
  return function (target: object, key: string) {
    ApiProperty({ example: '+251911234567', description: PHONE_DESCRIPTION })(target, key);
    Trim()(target, key);
    IsString()(target, key);
    Matches(/^\+?[0-9][0-9 ()-]{6,19}$/, { message: 'phoneNumber must be a valid phone number' })(target, key);
  };
}

function Password(name: string, description = 'At least 8 characters, with at least one letter and one digit.') {
  return function (target: object, key: string) {
    ApiProperty({ example: 'Str0ngPassw0rd', minLength: 8, maxLength: 128, description })(target, key);
    IsString()(target, key);
    MinLength(8)(target, key);
    MaxLength(128)(target, key);
    Matches(/[A-Za-z]/, { message: `${name} must contain at least one letter` })(target, key);
    Matches(/[0-9]/, { message: `${name} must contain at least one digit` })(target, key);
  };
}

function OtpCode() {
  return function (target: object, key: string) {
    ApiProperty({ example: '123456', description: 'One-time code sent by SMS' })(target, key);
    Trim()(target, key);
    IsString()(target, key);
    Matches(/^[0-9]{4,8}$/, { message: 'code must be a 4 to 8 digit number' })(target, key);
  };
}

export class RegisterDto {
  @Phone()
  phoneNumber!: string;

  @Password('password')
  password!: string;

  @ApiPropertyOptional({ example: 'Abebe Kebede', maxLength: 150 })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  @Matches(/^[^<>]*$/, { message: 'fullName must not contain < or >' })
  fullName?: string;

  @ApiPropertyOptional({ example: 'abebe@example.com', description: 'Optional. Never used to sign in.' })
  @IsOptional()
  @Trim()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

export class VerifyPhoneDto {
  @Phone()
  phoneNumber!: string;

  @OtpCode()
  code!: string;

  @ApiProperty({
    example: 'q0J8m1mJ0V8n3zq5yQ0b6Jr5mF4oT2c1x9KpLw7HdEs',
    description:
      'Token returned by POST /auth/register (or in the PHONE_NOT_VERIFIED error of POST /auth/login). ' +
      'Ties the SMS code to the password chosen in that registration.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'verificationToken is malformed' })
  verificationToken!: string;
}

export class PhoneOnlyDto {
  @Phone()
  phoneNumber!: string;
}

export class LoginDto {
  @Phone()
  phoneNumber!: string;

  @ApiProperty({ example: 'Str0ngPassw0rd' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token returned by login, verify-phone or a previous refresh' })
  @IsJWT()
  refreshToken!: string;
}

export class ResetPasswordDto {
  @Phone()
  phoneNumber!: string;

  @OtpCode()
  code!: string;

  @Password('newPassword')
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ example: 'Str0ngPassw0rd' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  @Password('newPassword')
  newPassword!: string;
}
