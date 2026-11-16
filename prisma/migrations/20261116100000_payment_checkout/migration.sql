-- Deposits through a payment provider: where the user pays, when the provider was last asked, and a flag for finance staff.
ALTER TABLE "payment_transactions"
  ADD COLUMN "checkout_url" VARCHAR(1024),
  ADD COLUMN "last_checked_at" TIMESTAMPTZ(3),
  ADD COLUMN "review_reason" TEXT;

-- A user's own deposit history, newest first.
CREATE INDEX "payment_transactions_user_id_created_at_idx" ON "payment_transactions"("user_id", "created_at");
