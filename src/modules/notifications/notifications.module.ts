import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NOTIFICATION_PROVIDERS } from './notification.types';
import type { NotificationProvider } from './notification.types';
import { NotificationsController } from './notifications.controller';
import { NOTIFICATIONS_QUEUE, NotificationsProcessor } from './notifications.processor';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  controllers: [NotificationsController],
  providers: [
    // SMS, email and push providers go here. With none registered, notifications stay in the app.
    { provide: NOTIFICATION_PROVIDERS, useFactory: (): NotificationProvider[] => [] },
    NotificationsService,
    NotificationDispatcher,
    NotificationsProcessor,
  ],
  exports: [NotificationsService, NotificationDispatcher],
})
export class NotificationsModule {}
