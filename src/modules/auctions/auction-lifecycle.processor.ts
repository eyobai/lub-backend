import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { AuctionLifecycleService } from './auction-lifecycle.service';
import type { LifecycleSweep } from './auction-lifecycle.service';

export const AUCTION_LIFECYCLE_QUEUE = 'auction-lifecycle';
const SWEEP = 'sweep';

/** Runs the open/close sweep on a fixed interval. The schedule lives in Redis, so instances do not duplicate it. */
@Processor(AUCTION_LIFECYCLE_QUEUE)
export class AuctionLifecycleProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuctionLifecycleProcessor.name);

  constructor(
    @InjectQueue(AUCTION_LIFECYCLE_QUEUE) private readonly queue: Queue,
    private readonly lifecycle: AuctionLifecycleService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const seconds = this.config.auctions.sweepIntervalSeconds;
    if (seconds <= 0) {
      await this.queue.removeJobScheduler(SWEEP);
      return;
    }
    await this.queue.upsertJobScheduler(
      SWEEP,
      { every: seconds * 1000 },
      { name: SWEEP, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
  }

  async process(): Promise<LifecycleSweep> {
    const result = await this.lifecycle.syncDue();
    if (result.activated.length > 0 || result.closing.length > 0) {
      this.logger.log({ activated: result.activated, closing: result.closing }, 'Auction lifecycle sweep');
    }
    return result;
  }
}
