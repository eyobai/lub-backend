-- Set once every bid fee of a cancelled auction has been returned to its bidder.
ALTER TABLE "auctions" ADD COLUMN "bid_fees_refunded_at" TIMESTAMPTZ(3);
