import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'VALIDATION_FAILED', description: 'Stable machine-readable error code' })
  error!: string;

  @ApiProperty({ example: 'Request validation failed' })
  message!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { fields: ['password must be longer than or equal to 8 characters'] },
    description: 'Extra context, e.g. validation messages or retryAfterSeconds',
  })
  details?: Record<string, unknown>;

  @ApiProperty({ example: '/api/v1/auth/login' })
  path!: string;

  @ApiProperty({ example: '0b9c4a53-5f0e-4f0a-8a3e-0c1d1c6f2f1e' })
  requestId!: string;

  @ApiProperty({ example: '2026-01-01T12:00:00.000Z' })
  timestamp!: string;
}
