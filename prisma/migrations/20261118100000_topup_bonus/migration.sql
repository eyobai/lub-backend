-- Top-up bonus: a per-wallet bonus balance (spent on bid fees before cash, never withdrawable), the platform account
-- that funds it, and one row per bonus granted so each can expire on its own date.
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'USER_WALLET_BONUS';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'PROMOTIONS';

ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'BONUS';
ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'BONUS_EXPIRY';

-- AlterTable
ALTER TABLE "payment_transactions" ADD COLUMN     "bonus_minor" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "wallet_bonus_grants" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "remaining_minor" BIGINT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "payment_transaction_id" UUID,
    "grant_transaction_id" UUID NOT NULL,
    "expiry_transaction_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_bonus_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_bonus_grants_payment_transaction_id_key" ON "wallet_bonus_grants"("payment_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_bonus_grants_grant_transaction_id_key" ON "wallet_bonus_grants"("grant_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_bonus_grants_expiry_transaction_id_key" ON "wallet_bonus_grants"("expiry_transaction_id");

-- CreateIndex
CREATE INDEX "wallet_bonus_grants_wallet_id_expires_at_idx" ON "wallet_bonus_grants"("wallet_id", "expires_at");

-- CreateIndex
CREATE INDEX "wallet_bonus_grants_expires_at_idx" ON "wallet_bonus_grants"("expires_at");

-- AddForeignKey
ALTER TABLE "wallet_bonus_grants" ADD CONSTRAINT "wallet_bonus_grants_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_bonus_grants" ADD CONSTRAINT "wallet_bonus_grants_payment_transaction_id_fkey" FOREIGN KEY ("payment_transaction_id") REFERENCES "payment_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_bonus_grants" ADD CONSTRAINT "wallet_bonus_grants_grant_transaction_id_fkey" FOREIGN KEY ("grant_transaction_id") REFERENCES "wallet_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_bonus_grants" ADD CONSTRAINT "wallet_bonus_grants_expiry_transaction_id_fkey" FOREIGN KEY ("expiry_transaction_id") REFERENCES "wallet_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "wallet_bonus_grants"
  ADD CONSTRAINT "wallet_bonus_grants_amounts_chk" CHECK ("amount_minor" > 0 AND "remaining_minor" BETWEEN 0 AND "amount_minor");

-- A wallet now has three accounts of its own. Compared as text: an enum value added in this transaction cannot be used yet.
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_wallet_chk";
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_wallet_chk"
  CHECK (("type"::text IN ('USER_WALLET', 'USER_WALLET_HOLD', 'USER_WALLET_BONUS')) = ("wallet_id" IS NOT NULL));
