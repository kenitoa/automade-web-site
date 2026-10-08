export const EXPANSION_SECURITY_MIGRATION = `
ALTER TABLE expansion_credentials ADD COLUMN issuer_id TEXT REFERENCES creator_accounts(id);
ALTER TABLE expansion_credentials ADD COLUMN webhook_secret TEXT;
ALTER TABLE expansion_workflow_runs ADD COLUMN definition TEXT CHECK(definition IS NULL OR json_valid(definition));
ALTER TABLE expansion_workflow_runs ADD COLUMN actor_id TEXT;
ALTER TABLE expansion_workflow_runs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
`;
