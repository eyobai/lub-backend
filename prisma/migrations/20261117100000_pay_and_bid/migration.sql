-- Pay and bid: a deposit can pay for bids in one auction. The bids are placed from the wallet once the payment is
-- confirmed; if they cannot be, the money stays in the wallet and the reason is kept.
ALTER TABLE "payment_transactions"
  ADD COLUMN "bid_auction_id" UUID,
  ADD COLUMN "bid_amounts_minor" BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  ADD COLUMN "bid_submission_id" UUID,
  ADD COLUMN "bid_error" TEXT;

CREATE UNIQUE INDEX "payment_transactions_bid_submission_id_key" ON "payment_transactions"("bid_submission_id");

ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "payment_transactions_bid_auction_id_fkey" FOREIGN KEY ("bid_auction_id") REFERENCES "auctions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payment_transactions_bid_submission_id_fkey" FOREIGN KEY ("bid_submission_id") REFERENCES "bid_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
