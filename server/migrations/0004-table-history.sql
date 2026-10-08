CREATE TABLE IF NOT EXISTS table_history(block_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),previous_body TEXT NOT NULL CHECK(json_valid(previous_body)),body TEXT NOT NULL CHECK(json_valid(body)),actor_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(block_id,version));
CREATE INDEX IF NOT EXISTS table_history_created ON table_history(block_id,created_at DESC);
