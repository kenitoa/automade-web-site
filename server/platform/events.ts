import type { DatabaseSync } from "node:sqlite";
import type { WorkflowTrigger } from "../../src/domain/expansion";
import { hash, now } from "./common";
/** Called within the business transaction; no process-local callback can lose the event. */
export function recordPlatformEvent(db: DatabaseSync, projectId: string, trigger: Exclude<WorkflowTrigger, "manual">, id: string, payload: unknown): void {
  const key = "workflow:event:" + hash(JSON.stringify([projectId, trigger, id]));
  db.prepare("INSERT INTO runtime_state VALUES(?,?) ON CONFLICT DO NOTHING").run(key, JSON.stringify({ projectId, trigger, id, payload, createdAt: now() }));
}
