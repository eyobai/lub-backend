-- A wallet has one ledger account per type (available balance, withdrawal hold).
DROP INDEX "ledger_accounts_wallet_id_key";
CREATE UNIQUE INDEX "ledger_accounts_wallet_id_type_key" ON "ledger_accounts"("wallet_id", "type");

-- Wallet-type accounts always belong to a wallet; system accounts never do.
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_wallet_chk";
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_wallet_chk"
  CHECK (("type" IN ('USER_WALLET', 'USER_WALLET_HOLD')) = ("wallet_id" IS NOT NULL));
