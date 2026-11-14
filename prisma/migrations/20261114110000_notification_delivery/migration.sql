-- When a failed external delivery (SMS, email, push) may be tried again.
ALTER TABLE "notifications" ADD COLUMN "next_attempt_at" TIMESTAMPTZ(3);

-- Unread in-app notifications per user (the badge count).
CREATE INDEX "notifications_unread_idx" ON "notifications"("user_id")
  WHERE "channel" = 'IN_APP' AND "read_at" IS NULL;

-- Set once the closing reminder of an auction has been sent, so it is sent only once.
ALTER TABLE "auctions" ADD COLUMN "closing_reminder_sent_at" TIMESTAMPTZ(3);
