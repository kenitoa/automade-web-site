import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../http";
export type SqlRow = Record<string, unknown>;
export function one(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): SqlRow | null {
  return db.prepare(sql).get(...args) ?? null;
}
export function many(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): SqlRow[] {
  return db.prepare(sql).all(...args);
}
export const now = (): string => new Date().toISOString();
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export function text(value: unknown, name: string, maximum = 200, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim()))
    throw new HttpError(400, "INPUT", `${name} 입력을 확인하세요.`);
  return value.trim();
}
export function integer(value: unknown, name: string, min = 0, max = 1_000_000_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new HttpError(400, "INPUT", `${name} 범위를 확인하세요.`);
  return value;
}
export function boolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new HttpError(400, "INPUT", `${name} 값은 참 또는 거짓이어야 합니다.`);
  return value;
}
export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function audit(db: DatabaseSync, operation: string, id: string, status = "success"): void {
  db.prepare("INSERT INTO audit(id,operation,resource_id,status,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), operation, id, status, now());
}
export function projectId(value: unknown): string {
  const id = text(value, "프로젝트 ID", 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400, "PROJECT", "프로젝트 ID를 확인하세요.");
  return id;
}
export const period = (): string => now().slice(0, 7);
export function checkUsageLimit(db: DatabaseSync, project: string, metric: string, projectedValue: number): void {
  const billing = one(db, "SELECT limits FROM platform_billing WHERE project_id=?", project);
  const limits: unknown = billing ? JSON.parse(String(billing.limits)) : {};
  const limit = limits && typeof limits === "object" && metric in limits ? Number((limits as Record<string, unknown>)[metric]) : undefined;
  if (!Number.isSafeInteger(projectedValue) || projectedValue < 0) throw new HttpError(400, "USAGE", "사용량을 확인하세요.");
  if (limit !== undefined && projectedValue > limit) throw new HttpError(429, "PLAN_LIMIT", "설정한 사용량 한도를 초과했습니다.");
}
export function setUsage(db: DatabaseSync, project: string, metric: string, value: number): void {
  checkUsageLimit(db, project, metric, value);
  db.prepare("INSERT INTO platform_usage VALUES(?,?,?,?) ON CONFLICT(project_id,metric,period) DO UPDATE SET value=excluded.value").run(project, metric, period(), value);
}
export function consumeUsage(db: DatabaseSync, project: string, metric: string, amount = 1): void {
  const used = Number(one(db, "SELECT value FROM platform_usage WHERE project_id=? AND metric=? AND period=?", project, metric, period())?.value ?? 0);
  checkUsageLimit(db, project, metric, used + amount);
  db.prepare("INSERT INTO platform_usage VALUES(?,?,?,?) ON CONFLICT(project_id,metric,period) DO UPDATE SET value=value+excluded.value").run(project, metric, period(), amount);
}
