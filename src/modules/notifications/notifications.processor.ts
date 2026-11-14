import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { NotificationDispatcher } from './notification-dispatcher.service';
import type { DispatchRun } from './notification-dispatcher.service';

export const NOTIFICATIONS_QUEUE = 'notifications';
const DISPATCH = 'dispatch';

/** Sends pending SMS/email/push notifications on a fixed interval. Idle unless a provider is registered. */
@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    private readonly dispatcher: NotificationDispatcher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const seconds = this.config.notifications.dispatchIntervalSeconds;
    if (seconds <= 0 || !this.dispatcher.enabled) {
      await this.queue.removeJobScheduler(DISPATCH);
      return;
    }
    await this.queue.upsertJobScheduler(
      DISPATCH,
      { every: seconds * 1000 },
      { name: DISPATCH, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
  }

  async process(): Promise<DispatchRun> {
    const run = await this.dispatcher.dispatchPending();
    if (run.sent > 0 || run.failed > 0) this.logger.log(run, 'Notifications dispatched');
    return run;
  }
}
