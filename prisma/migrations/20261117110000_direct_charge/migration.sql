-- Direct charge: a payment the payer approves on their phone (telebirr, M-Pesa, …) without leaving the site.
ALTER TABLE "payment_transactions" ADD COLUMN "charge_method" VARCHAR(32);
