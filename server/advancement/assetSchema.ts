export const ASSET_USAGE_MIGRATION = `
CREATE TABLE advancement_asset_states(ref_id TEXT PRIMARY KEY REFERENCES expansion_blob_refs(id) ON DELETE CASCADE,state TEXT NOT NULL CHECK(state IN('quarantined','approved','rejected')),visibility TEXT NOT NULL CHECK(visibility IN('private','public')),revision INTEGER NOT NULL CHECK(revision>0),inspection TEXT NOT NULL CHECK(json_valid(inspection)),approved_by TEXT,reason TEXT NOT NULL,source_ref TEXT REFERENCES expansion_blob_refs(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
INSERT INTO advancement_asset_states SELECT id,'approved','public',1,'{"kind":"legacy-metadata-validation","malwareScan":"not-configured"}',NULL,'기존 호환 자산',NULL,created_at,created_at FROM expansion_blob_refs;
CREATE INDEX advancement_asset_source ON advancement_asset_states(source_ref,state);
CREATE TABLE advancement_asset_upload_receipts(project_id TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,ref_id TEXT NOT NULL REFERENCES expansion_blob_refs(id) ON DELETE CASCADE,PRIMARY KEY(project_id,request_key));
CREATE TABLE advancement_privacy_markers(project_id TEXT NOT NULL,environment_id TEXT NOT NULL,subject_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,environment_id,subject_id));
INSERT INTO advancement_privacy_markers SELECT project_id,COALESCE((SELECT id FROM expansion_environments e WHERE e.project_id=t.project_id AND e.data_key=e.project_id LIMIT 1),''),subject_id,created_at FROM advancement_privacy_tombstones t;
ALTER TABLE expansion_usage_reservations ADD COLUMN environment_id TEXT;
ALTER TABLE expansion_usage_reservations ADD COLUMN data_key TEXT;
ALTER TABLE expansion_usage_reservations ADD COLUMN operation_id TEXT;
UPDATE expansion_usage_reservations SET environment_id=(SELECT id FROM expansion_environments e WHERE e.project_id=expansion_usage_reservations.project_id AND e.data_key=e.project_id LIMIT 1),data_key=project_id;
CREATE INDEX expansion_usage_environment ON expansion_usage_reservations(organization_id,project_id,environment_id,created_at);
CREATE TABLE advancement_usage_entries(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,organization_id TEXT NOT NULL,project_id TEXT NOT NULL,environment_id TEXT NOT NULL,metric TEXT NOT NULL,unit TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>=0),reservation_id TEXT REFERENCES expansion_usage_reservations(id),fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(operation_id,metric,environment_id));
CREATE TABLE advancement_usage_costs(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,organization_id TEXT NOT NULL,project_id TEXT NOT NULL,environment_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('estimate','provider-invoice')),amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),currency TEXT NOT NULL,source TEXT NOT NULL,evidence_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(environment_id,kind,source));
`;
