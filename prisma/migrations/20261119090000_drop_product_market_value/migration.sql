-- Products no longer carry a market value: it is neither shown to bidders nor kept.
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_market_value_chk";
ALTER TABLE "products" DROP COLUMN "market_value_minor";
