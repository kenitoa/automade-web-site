import type { DatabaseSync } from "node:sqlite";
import type { Row, TableColumn } from "../src/domain/types";
import { parseRows } from "../src/domain/validation";
import { validateTableRows } from "../src/domain/content";
import { HttpError } from "./http";
import { audit, integer, now, one, transaction } from "./platform/common";
export const TABLE_HISTORY_MIGRATION = `CREATE TABLE IF NOT EXISTS table_history(block_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),previous_body TEXT NOT NULL CHECK(json_valid(previous_body)),body TEXT NOT NULL CHECK(json_valid(body)),actor_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(block_id,version));
CREATE INDEX IF NOT EXISTS table_history_created ON table_history(block_id,created_at DESC);`;
export function saveTableWithHistory(db: DatabaseSync, blockId: string, columns: TableColumn[], initialRows: Row[], rows: Row[], expectedVersion: number, actorId: string, assertWritable: () => void): number {
  return transaction(db, () => {
    assertWritable();
    const existing = one(db, "SELECT version,body FROM table_data WHERE block_id=?", blockId), version = Number(existing?.version ?? 0);
    if (version !== expectedVersion) throw new HttpError(409, "CONFLICT", "다른 창에서 표를 수정했습니다. 최신 데이터를 확인하세요.");
    const previousRows = existing ? parseRows(JSON.parse(String(existing.body)) as unknown, columns.length) : initialRows;
    const errors = validateTableRows(columns, rows, previousRows);
    if (errors.length) throw new HttpError(400, "TABLE_VALIDATION", errors.map((error) => error.message).join(" "));
    const serialized = JSON.stringify(rows), time = now();
    db.prepare("INSERT INTO table_data VALUES(?,?,?) ON CONFLICT(block_id) DO UPDATE SET version=excluded.version,body=excluded.body").run(blockId, version + 1, serialized);
    db.prepare("INSERT INTO table_history VALUES(?,?,?,?,?,?)").run(blockId, version + 1, JSON.stringify(previousRows), serialized, actorId, time);
    audit(db, "table.save", blockId); return version + 1;
  });
}
export interface TableHistoryEntry { version: number; rows: Row[]; previousRows: Row[]; actorId: string; createdAt: string }
export function tableHistory(db: DatabaseSync, blockId: string, columns: number, limit = 10, beforeVersion = Number.MAX_SAFE_INTEGER): { items: TableHistoryEntry[]; nextCursor: number | null; limit: number } {
  integer(limit, "이력 조회 개수", 1, 50); integer(beforeVersion, "이력 커서", 1, Number.MAX_SAFE_INTEGER);
  const raw = db.prepare("SELECT * FROM table_history WHERE block_id=? AND version<? ORDER BY version DESC LIMIT ?").all(blockId, beforeVersion, limit + 1);
  const items: TableHistoryEntry[] = []; let bytes = 0;
  for (const row of raw.slice(0, limit)) {
    const size = Buffer.byteLength(String(row.body)) + Buffer.byteLength(String(row.previous_body));
    if (items.length && bytes + size > 8_000_000) break;
    bytes += size;
    items.push({ version: Number(row.version), rows: parseRows(JSON.parse(String(row.body)) as unknown, columns), previousRows: parseRows(JSON.parse(String(row.previous_body)) as unknown, columns), actorId: String(row.actor_id), createdAt: String(row.created_at) });
  }
  return { items, nextCursor: raw.length > items.length ? items.at(-1)?.version ?? null : null, limit };
}
