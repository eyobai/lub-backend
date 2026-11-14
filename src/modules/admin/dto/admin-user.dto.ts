import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, RoleName } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto';
import { STAFF_ROLES } from '../../../common/roles';
import { Trim } from '../../../common/utils/trim.transform';

export class AdminListUsersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    description: 'Part of a phone number, name or email address. Phone numbers are matched on their digits.',
    example: '0911',
    maxLength: 100,
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: AccountStatus })
  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @ApiPropertyOptional({ enum: RoleName, description: 'Only accounts holding this role' })
  @IsOptional()
  @IsEnum(RoleName)
  role?: RoleName;
}

export class ReasonDto {
  @ApiProperty({
    example: 'Identity confirmed by phone call; user forgot the password',
    minLength: 5,
    maxLength: 500,
    description: 'Why this is done. Kept in the audit log.',
  })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

export class SetRolesDto extends ReasonDto {
  @ApiProperty({
    enum: STAFF_ROLES,
    isArray: true,
    example: [RoleName.SUPPORT],
    description:
      'The complete set of back-office roles the account should hold. An empty list makes it an ordinary user.',
  })
  @IsArray()
  @ArrayMaxSize(STAFF_ROLES.length)
  @ArrayUnique()
  @IsIn(STAFF_ROLES, { each: true })
  roles!: RoleName[];
}

export class AdminUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+251911234567' })
  phoneNumber!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Abebe Kebede' })
  fullName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'abebe@example.com' })
  email!: string | null;

  @ApiProperty({ enum: AccountStatus })
  status!: AccountStatus;

  @ApiProperty({ type: String, nullable: true, description: 'Why the account is suspended or blocked' })
  statusReason!: string | null;

  @ApiProperty({ enum: RoleName, isArray: true })
  roles!: RoleName[];

  @ApiProperty()
  phoneVerified!: boolean;

  @ApiProperty({ description: 'Staff reset the password and the user has not chosen a new one yet' })
  mustChangePassword!: boolean;

  @ApiProperty({ type: Date, nullable: true })
  lastLoginAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}

export class AdminUserDetailDto extends AdminUserDto {
  @ApiProperty({ type: Date, nullable: true })
  passwordChangedAt!: Date | null;

  @ApiProperty({ description: 'Devices currently signed in' })
  activeSessions!: number;

  @ApiProperty()
  bidCount!: number;

  @ApiProperty()
  winCount!: number;
}

export class AdminUserPageDto {
  @ApiProperty({ type: [AdminUserDto] })
  items!: AdminUserDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class PasswordResetResultDto {
  @ApiProperty({
    example: 'kT7vQp3mWz8RcN',
    description: 'Shown once and stored nowhere. Give it to the user; they must replace it at their next sign-in.',
  })
  temporaryPassword!: string;

  @ApiProperty({ type: AdminUserDetailDto })
  user!: AdminUserDetailDto;
}

export class SessionsRevokedDto {
  @ApiProperty({ description: 'Devices that were signed out' })
  revoked!: number;
}
