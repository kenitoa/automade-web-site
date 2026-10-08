import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "../http";
import { many, now, one, type SqlRow } from "../platform/common";
export interface ReconciliationDifference { kind: "order" | "payment-event" | "payment-command" | "booking" | "inventory"; id: string; orderId?: string; beforeStatus: string | null; restoredStatus: string | null; reasons: string[] }
export interface ReconciliationReport { createdAt: string; counts: { beforeOrders: number; restoredOrders: number; beforePaymentEvents: number; restoredPaymentEvents: number; beforeBookings: number; restoredBookings: number; beforeProducts: number; restoredProducts: number }; differences: ReconciliationDifference[]; unresolvedOrderIds: string[]; status: "consistent" | "requires-review" }
export function compareOperationalData(before: DatabaseSync, restored: DatabaseSync): ReconciliationReport {
  const counts = { beforeOrders: 0, restoredOrders: 0, beforePaymentEvents: 0, restoredPaymentEvents: 0, beforeBookings: 0, restoredBookings: 0, beforeProducts: 0, restoredProducts: 0 }, differences: ReconciliationDifference[] = [];
  const tables: Array<{ table: string; kind: ReconciliationDifference["kind"]; status: string; fields: string[]; beforeCount: keyof typeof counts; restoredCount: keyof typeof counts }> = [
    { table: "platform_orders", kind: "order", status: "status", fields: ["project_id", "status", "amount_minor", "currency", "refunded_minor", "provider_id", "provider_payment_id", "provider_sequence"], beforeCount: "beforeOrders", restoredCount: "restoredOrders" },
    { table: "platform_payment_events", kind: "payment-event", status: "status", fields: ["provider_id", "event_id", "body_hash", "status"], beforeCount: "beforePaymentEvents", restoredCount: "restoredPaymentEvents" },
    { table: "platform_bookings", kind: "booking", status: "status", fields: ["project_id", "slot_id", "quantity", "status"], beforeCount: "beforeBookings", restoredCount: "restoredBookings" },
    { table: "platform_products", kind: "inventory", status: "active", fields: ["project_id", "price_minor", "currency", "inventory", "active"], beforeCount: "beforeProducts", restoredCount: "restoredProducts" }
  ];
  for (const definition of tables) {
    const source = many(before, `SELECT * FROM ${definition.table}`), candidate = many(restored, `SELECT * FROM ${definition.table}`); counts[definition.beforeCount] = source.length; counts[definition.restoredCount] = candidate.length;
    const key = (row: SqlRow): string => definition.kind === "payment-event" ? String(row.provider_id) + ":" + String(row.event_id) : String(row.id);
    const previous = new Map(source.map(row => [key(row), row])), next = new Map(candidate.map(row => [key(row), row]));
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      const a = previous.get(id), b = next.get(id), reasons = !a ? ["absent-before"] : !b ? ["absent-restored"] : definition.fields.filter(field => a[field] !== b[field]).map(field => field + "-changed");
      if (reasons.length) differences.push({ kind: definition.kind, id, ...(definition.kind === "payment-event" ? { orderId: String(a?.order_id ?? b?.order_id) } : {}), beforeStatus: a ? String(a[definition.status] ?? "") : null, restoredStatus: b ? String(b[definition.status] ?? "") : null, reasons });
    }
  }
  const beforeCommands = new Map(many(before, "SELECT * FROM platform_payment_commands").map(row => [String(row.id), row])), restoredCommands = new Map(many(restored, "SELECT * FROM platform_payment_commands").map(row => [String(row.id), row]));
  for (const id of new Set([...beforeCommands.keys(), ...restoredCommands.keys()])) { const a = beforeCommands.get(id), b = restoredCommands.get(id); if (!a || !b || a.status !== b.status || a.fingerprint !== b.fingerprint) differences.push({ kind: "payment-command", id, orderId: String(a?.order_id ?? b?.order_id), beforeStatus: a ? String(a.status) : null, restoredStatus: b ? String(b.status) : null, reasons: !a ? ["absent-before"] : !b ? ["absent-restored"] : ["command-changed"] }); }
  const unresolvedOrderIds = [...new Set(differences.flatMap(item => item.kind === "order" ? [item.id] : item.orderId ? [item.orderId] : []))]; return { createdAt: now(), counts, differences, unresolvedOrderIds, status: differences.length ? "requires-review" : "consistent" };
}
export function persistReconciliation(restored: DatabaseSync, report: ReconciliationReport, before?: DatabaseSync): void {
  restored.prepare("INSERT INTO runtime_state VALUES('restore:reconciliation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(report));
  if (before) {
    const watermarks = many(before, "SELECT id,provider_id,provider_payment_id,provider_sequence FROM platform_orders WHERE provider_id IS NOT NULL");
    restored.prepare("INSERT INTO runtime_state VALUES('restore:payment-watermarks',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(watermarks));
    const commands = many(before, "SELECT * FROM platform_payment_commands WHERE status IN('pending','requested')");
    restored.prepare("INSERT INTO runtime_state VALUES('restore:pending-payment-commands',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(commands));
  }
}
export function assertFinancialReady(db: DatabaseSync, orderId: string): void {
  const row = one(db, "SELECT value FROM runtime_state WHERE key='restore:reconciliation'"); if (!row) return;
  const report = JSON.parse(String(row.value)) as ReconciliationReport;
  if (report.unresolvedOrderIds.includes(orderId)) throw new HttpError(409, "RESTORE_RECONCILIATION_REQUIRED", "복구 전 결제 원장과 상태가 다릅니다. 공급자 상태 대사 후 진행하세요.");
}
export function assertPaymentWatermark(db: DatabaseSync, orderId: string, providerId: string, paymentId: string, sequence: number): void {
  const row = one(db, "SELECT value FROM runtime_state WHERE key='restore:payment-watermarks'"); if (!row) return;
  const values = JSON.parse(String(row.value)) as SqlRow[], watermark = values.find(item => item.id === orderId);
  if (watermark && (watermark.provider_id !== providerId || watermark.provider_payment_id && watermark.provider_payment_id !== paymentId || sequence < Number(watermark.provider_sequence))) throw new HttpError(409, "RESTORE_PAYMENT_WATERMARK", "복구 전 원장보다 오래되거나 다른 거래의 이벤트입니다.");
}
export function confirmReconciledOrder(db: DatabaseSync, orderId: string): void {
  const row = one(db, "SELECT value FROM runtime_state WHERE key='restore:reconciliation'"); if (!row) return;
  const report = JSON.parse(String(row.value)) as ReconciliationReport; report.unresolvedOrderIds = report.unresolvedOrderIds.filter(id => id !== orderId);
  if (report.differences.some(item => item.kind === "payment-command" && item.orderId === orderId && ["pending", "requested"].includes(item.beforeStatus ?? "") && one(db, "SELECT status FROM platform_payment_commands WHERE id=? AND order_id=?", item.id, orderId)?.status !== "verified")) return;
  // Booking and inventory divergences still require operator review; do not claim complete recovery.
  db.prepare("UPDATE runtime_state SET value=? WHERE key='restore:reconciliation'").run(JSON.stringify(report));
}
export function retainedPayment(db: DatabaseSync, orderId: string): SqlRow | null { const row = one(db, "SELECT value FROM runtime_state WHERE key='restore:payment-watermarks'"); return row ? (JSON.parse(String(row.value)) as SqlRow[]).find(item => item.id === orderId) ?? null : null; }
export function applyVerifiedRetainedCommands(db: DatabaseSync, orderId: string, input: Record<string, unknown>): void {
  const row = one(db, "SELECT value FROM runtime_state WHERE key='restore:pending-payment-commands'"); if (!row || input.commands === undefined) return;
  if (!Array.isArray(input.commands) || input.commands.length > 100) throw new HttpError(502, "RECONCILIATION_COMMANDS", "공급자 명령 원장을 확인하세요.");
  const retained = (JSON.parse(String(row.value)) as SqlRow[]).filter(item => item.order_id === orderId), confirmed: SqlRow[] = [];
  for (const command of input.commands) {
    if (!command || typeof command !== "object" || Array.isArray(command)) throw new HttpError(502, "RECONCILIATION_COMMANDS", "공급자 명령 원장 형식을 확인하세요.");
    const value = command as Record<string, unknown>, prior = retained.find(item => item.id === value.id);
    if (!prior) continue;
    if (value.status !== "verified" || value.amountMinor !== prior.amount_minor) throw new HttpError(409, "RECONCILIATION_COMMAND_PENDING", "이전 환불 명령의 결과가 아직 확인되지 않았습니다."); confirmed.push(prior);
  }
  if (confirmed.reduce((sum, item) => sum + Number(item.amount_minor), 0) > Number(input.refundedMinor ?? 0)) throw new HttpError(409, "RECONCILIATION_REFUND_TOTAL", "명령 원장과 누적 환불 금액이 다릅니다.");
  for (const prior of confirmed) db.prepare("INSERT INTO platform_payment_commands VALUES(?,?, 'refund',?,?,?,'verified',?) ON CONFLICT(id) DO UPDATE SET status='verified'").run(String(prior.id), orderId, Number(prior.amount_minor), String(prior.idempotency_key), String(prior.fingerprint), String(prior.created_at));
}
