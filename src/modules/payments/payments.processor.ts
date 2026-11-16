import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { PaymentsService } from './payments.service';
import type { SweepResult } from './payments.service';

export const PAYMENTS_QUEUE = 'payments';
const SWEEP = 'sweep';

/** Confirms deposits whose webhook never arrived and whose payer never came back. The schedule lives in Redis, so instances do not duplicate it. */
@Processor(PAYMENTS_QUEUE)
export class PaymentsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentsProcessor.name);

  constructor(
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
    private readonly payments: PaymentsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const { provider, sweepIntervalSeconds: seconds } = this.config.payments;
    if (provider === 'none' || seconds <= 0) {
      await this.queue.removeJobScheduler(SWEEP);
      return;
    }
    await this.queue.upsertJobScheduler(
      SWEEP,
      { every: seconds * 1000 },
      { name: SWEEP, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
  }

  async process(): Promise<SweepResult> {
    const result = await this.payments.sweep();
    if (result.succeeded > 0 || result.closed > 0) this.logger.log(result, 'Deposit sweep');
    return result;
  }
}
