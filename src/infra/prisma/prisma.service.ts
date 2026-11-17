import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * How long a transaction may wait for a connection, and run. Prisma's own defaults (2 s and 5 s) are too tight for a
 * database that is far away or busy: a password change of four quick queries was cancelled after 7 s on a remote
 * database. Transactions that may take longer still pass their own options.
 */
export const TX_DEFAULTS = { maxWait: 10_000, timeout: 20_000 } as const;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ transactionOptions: TX_DEFAULTS });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
