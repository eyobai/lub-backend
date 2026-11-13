-- Monotonic insertion order for ledger lines: stable history paging and "latest balance" lookups.
DROP INDEX "ledger_entries_account_id_created_at_idx";
ALTER TABLE "ledger_entries" ADD COLUMN "sequence" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "ledger_entries_sequence_key" ON "ledger_entries"("sequence");
CREATE INDEX "ledger_entries_account_id_sequence_idx" ON "ledger_entries"("account_id", "sequence");
