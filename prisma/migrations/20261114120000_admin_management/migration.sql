-- Set when staff reset a password: the user must choose a new one before doing anything else.
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;

-- Newest-first listing in the back office.
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
CREATE INDEX "security_events_created_at_idx" ON "security_events"("created_at");
