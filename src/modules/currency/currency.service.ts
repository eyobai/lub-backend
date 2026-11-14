import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Currency, Prisma } from '@prisma/client';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class CurrencyService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Looks up a currency by code (default: the platform currency). Inactive currencies are rejected unless allowed.
   * Inside a database transaction pass its client: reading through the pool there would need a second connection
   * while holding the first, which stalls every request once all connections are held that way.
   */
  async resolve(
    code?: string,
    allowInactive = false,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Currency> {
    const wanted = (code ?? this.config.defaultCurrency).toUpperCase();
    const currency = await client.currency.findUnique({ where: { code: wanted } });
    if (!currency || (!currency.isActive && !allowInactive)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.CURRENCY_NOT_SUPPORTED,
        `Currency ${wanted} is not supported`,
      );
    }
    return currency;
  }
}
