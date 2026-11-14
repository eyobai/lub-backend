-- Reason or remark recorded when a winner is verified or rejected.
ALTER TABLE "winners" ADD COLUMN "verification_note" TEXT;

-- Only verified winners can be published.
ALTER TABLE "winners" ADD CONSTRAINT "winners_published_chk"
  CHECK ("published_at" IS NULL OR "verification_status" = 'VERIFIED');
