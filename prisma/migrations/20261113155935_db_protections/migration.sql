-- Database-level protections that Prisma's schema language cannot express.

-- ── Reference data ──
INSERT INTO "roles" ("name", "description") VALUES
  ('USER', 'Regular bidder'),
  ('SUPPORT', 'Customer support: read users, manage prize delivery'),
  ('FINANCE', 'Finance: review transactions and withdrawals'),
  ('ADMIN', 'Administrator: manage users, products and auctions'),
  ('SUPER_ADMIN', 'Full access, including role management')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "currencies" ("code", "name", "minor_units") VALUES ('ETB', 'Ethiopian Birr', 2)
ON CONFLICT ("code") DO NOTHING;

-- ── Currency foreign keys ──
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "winners" ADD CONSTRAINT "winners_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Check constraints ──
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164_chk" CHECK ("phone_number" ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_minor_units_chk" CHECK ("minor_units" BETWEEN 0 AND 4);
ALTER TABLE "otp_verifications" ADD CONSTRAINT "otp_attempts_chk" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts");

-- Wallet balances can never go negative (system clearing accounts opt out explicitly).
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_non_negative_chk" CHECK ("allow_negative" OR "balance_minor" >= 0);
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_wallet_chk" CHECK (("type" IN ('USER_WALLET', 'USER_WALLET_HOLD')) OR "wallet_id" IS NULL);
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_chk" CHECK ("amount_minor" > 0);
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_amount_chk" CHECK ("amount_minor" > 0);
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_amount_chk" CHECK ("amount_minor" > 0);
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_success_chk" CHECK ("status" <> 'SUCCEEDED' OR "verified_at" IS NOT NULL);
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_amount_chk" CHECK ("amount_minor" > 0);

ALTER TABLE "products" ADD CONSTRAINT "products_market_value_chk" CHECK ("market_value_minor" >= 0);
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_bid_fee_chk" CHECK ("bid_fee_minor" >= 0);
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_bid_range_chk" CHECK ("min_bid_minor" > 0 AND "max_bid_minor" >= "min_bid_minor" AND "bid_step_minor" > 0);
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_window_chk" CHECK ("closes_at" > "opens_at");
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_limits_chk" CHECK ("max_bids_per_request" > 0 AND ("max_bids_per_user" IS NULL OR "max_bids_per_user" > 0));
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_total_bid_count_chk" CHECK ("total_bid_count" >= 0);
ALTER TABLE "bids" ADD CONSTRAINT "bids_amount_chk" CHECK ("amount_minor" > 0);
ALTER TABLE "bids" ADD CONSTRAINT "bids_dedupe_chk" CHECK ("dedupe_amount_minor" IS NULL OR "dedupe_amount_minor" = "amount_minor");
ALTER TABLE "bid_submissions" ADD CONSTRAINT "bid_submissions_totals_chk" CHECK ("bid_count" > 0 AND "bid_fee_minor" >= 0 AND "total_fee_minor" = "bid_fee_minor" * "bid_count");
ALTER TABLE "auction_results" ADD CONSTRAINT "auction_results_outcome_chk" CHECK (
  ("outcome" = 'WINNER_FOUND' AND "winning_bid_id" IS NOT NULL AND "winner_user_id" IS NOT NULL AND "winning_amount_minor" IS NOT NULL)
  OR ("outcome" <> 'WINNER_FOUND' AND "winning_bid_id" IS NULL AND "winner_user_id" IS NULL AND "winning_amount_minor" IS NULL)
);

-- ── Append-only tables ──
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on "%" is not allowed: rows are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bids_immutable BEFORE UPDATE OR DELETE ON "bids"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bid_submissions_immutable BEFORE UPDATE OR DELETE ON "bid_submissions"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER auction_results_immutable BEFORE UPDATE OR DELETE ON "auction_results"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Journal headers: only the status may change (POSTED -> REVERSED); never deleted.
CREATE OR REPLACE FUNCTION wallet_transactions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on "wallet_transactions" is not allowed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW."id", NEW."reference", NEW."type", NEW."currency", NEW."amount_minor", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."reference", OLD."type", OLD."currency", OLD."amount_minor", OLD."created_at")
     OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
     OR NEW."reverses_id" IS DISTINCT FROM OLD."reverses_id" THEN
    RAISE EXCEPTION 'wallet_transactions rows are immutable except for status' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallet_transactions_immutable BEFORE UPDATE OR DELETE ON "wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION wallet_transactions_guard();

-- ── Double-entry invariant: every journal must balance at commit time ──
CREATE OR REPLACE FUNCTION ledger_transaction_balanced() RETURNS trigger AS $$
DECLARE
  debits NUMERIC;
  credits NUMERIC;
BEGIN
  SELECT COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'DEBIT'), 0),
         COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'CREDIT'), 0)
    INTO debits, credits
    FROM "ledger_entries" WHERE "transaction_id" = NEW."transaction_id";
  IF debits <> credits THEN
    RAISE EXCEPTION 'Unbalanced ledger transaction %: debits=% credits=%', NEW."transaction_id", debits, credits
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_transaction_balanced();
