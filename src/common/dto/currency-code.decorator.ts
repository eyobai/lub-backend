import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { Trim } from '../utils/trim.transform';

/** Optional ISO-4217 currency code on a request DTO. */
export function CurrencyCode() {
  return function (target: object, key: string) {
    ApiPropertyOptional({ example: 'ETB', description: 'ISO-4217 code. Defaults to the platform currency.' })(
      target,
      key,
    );
    IsOptional()(target, key);
    Trim()(target, key);
    Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a 3-letter ISO-4217 code' })(target, key);
  };
}
