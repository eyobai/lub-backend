import type { NotificationChannel, NotificationType, Prisma } from '@prisma/client';

/** What happened, in words. Built by the functions in `notification-templates.ts`. */
export interface NotificationMessage {
  type: NotificationType;
  title: string;
  body: string;
  /** Identifiers a client can use to link to the right screen (auction, winner, transaction). */
  data?: Prisma.InputJsonObject;
}

export type ExternalChannel = Exclude<NotificationChannel, 'IN_APP'>;

export interface OutboundNotification extends NotificationMessage {
  id: string;
  recipient: { userId: string; phoneNumber: string; email: string | null; locale: string };
}

/**
 * One way of reaching a user outside the app (an SMS gateway, an email service, a push service).
 * To add one, implement this interface and list the class under NOTIFICATION_PROVIDERS in NotificationsModule;
 * nothing else changes. None is registered by default, so nothing leaves the system.
 */
export interface NotificationProvider {
  readonly channel: ExternalChannel;
  /** Whether this channel should carry this kind of notification (e.g. SMS only for wins). */
  accepts(type: NotificationType): boolean;
  /** Delivers the message. Throw to have it retried later. */
  send(notification: OutboundNotification): Promise<void>;
}

export const NOTIFICATION_PROVIDERS = Symbol('NOTIFICATION_PROVIDERS');
