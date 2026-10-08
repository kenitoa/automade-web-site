import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/store";
import { createAccount } from "../server/platform/auth";
import { applyPaymentEvent, checkout, createOrder, reconcileOrder, refundOrder, saveProduct } from "../server/platform/business";
import { saveConnection } from "../server/platform/connections";
import { assertFinancialReady, compareOperationalData, persistReconciliation } from "../server/expansion/reconciliation";
import { BookingExpansion } from "../server/expansion/bookings";
import { one } from "../server/platform/common";

test("restored payments preserve prior watermarks and hold new charge/refund/fulfillment until real provider reconciliation", async () => {
  const hosts = process.env.PLATFORM_ALLOWED_HOSTS, key = process.env.RECONCILE_TEST_KEY, webhook = process.env.RECONCILE_TEST_WEBHOOK;
  process.env.PLATFORM_ALLOWED_HOSTS = "provider.example.org"; process.env.RECONCILE_TEST_KEY = "test-only"; process.env.RECONCILE_TEST_WEBHOOK = "test-only";
  const root = await mkdtemp(path.join(tmpdir(), "automade-reconciliation-")), source = new Store(":memory:"); let restored: Store | undefined;
  try {
    const visitor = await createAccount(source.db, { email: "person@example.org", password: "visitor-password-2026", displayName: "Visitor" }), product = saveProduct(source.db, "site", { name: "Product", priceMinor: 1000, currency: "KRW", inventory: 10 }), order = createOrder(source.db, "site", String(visitor.id), { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: "order" }), connection = saveConnection(source.db, "site", { name: "Provider", kind: "payment", endpoint: "https://provider.example.org/api", allowedHost: "provider.example.org", secretRef: "RECONCILE_TEST_KEY", webhookSecretRef: "RECONCILE_TEST_WEBHOOK" });
    source.snapshot(path.join(root, "old.sqlite")); restored = new Store(path.join(root, "old.sqlite")); assert.equal(compareOperationalData(source.db, restored.db).status, "consistent");
    await checkout(source.db, String(order.id), String(connection.id), async () => ({ checkoutUrl: "https://provider.example.org/checkout", paymentId: "payment-id" }));
    const event = { eventId: "paid", orderId: order.id, paymentId: "payment-id", amountMinor: 1000, currency: "KRW", status: "paid", sequence: 1 }; applyPaymentEvent(source.db, String(connection.id), event);
    const report = compareOperationalData(source.db, restored.db); assert.equal(report.status, "requires-review"); assert.ok(!JSON.stringify(report).includes("person@example.org")); assert.ok(report.unresolvedOrderIds.includes(String(order.id))); persistReconciliation(restored.db, report, source.db);
    await assert.rejects(checkout(restored.db, String(order.id), String(connection.id), async () => { throw new Error("must not send"); }), /원장/);
    await assert.rejects(refundOrder(restored.db, String(order.id), { amountMinor: 1, idempotencyKey: "blocked" }), /원장/); assert.throws(() => new BookingExpansion(restored!.db).fulfill("site", "operator", String(order.id), { status: "fulfilled" }), /원장/);
    const stale = { ...event, eventId: "old-event", sequence: 0 }; assert.throws(() => applyPaymentEvent(restored!.db, String(connection.id), stale), /오래/);
    const result = await reconcileOrder(restored.db, String(order.id), async () => ({ ...event, eventId: "provider-status", sequence: 2 })); assert.equal(result.applied, true); assert.equal(one(restored.db, "SELECT status FROM platform_orders WHERE id=?", String(order.id))?.status, "paid"); assert.doesNotThrow(() => assertFinancialReady(restored!.db, String(order.id)));
  } finally { restored?.close(); source.close(); assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), "automade-reconciliation-"))); await rm(root, { recursive: true, force: true }); for (const [name, value] of [["PLATFORM_ALLOWED_HOSTS", hosts], ["RECONCILE_TEST_KEY", key], ["RECONCILE_TEST_WEBHOOK", webhook]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});
test("lost pending refund commands remain held until provider confirms matching command and cumulative amount", async () => {
  const saved = Object.fromEntries(["PLATFORM_ALLOWED_HOSTS", "RECONCILE_TEST_KEY", "RECONCILE_TEST_WEBHOOK"].map(key => [key, process.env[key]])); process.env.PLATFORM_ALLOWED_HOSTS = "provider.example.org"; process.env.RECONCILE_TEST_KEY = "test-only"; process.env.RECONCILE_TEST_WEBHOOK = "test-only";
  const root = await mkdtemp(path.join(tmpdir(), "automade-reconciliation-")), source = new Store(":memory:"); let restored: Store | undefined;
  try {
    const visitor = await createAccount(source.db, { email: "refund@example.org", password: "visitor-password-2026", displayName: "Visitor" }), product = saveProduct(source.db, "site", { name: "Product", priceMinor: 1000, currency: "KRW", inventory: 5 }), order = createOrder(source.db, "site", String(visitor.id), { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: "paid-order" }), provider = saveConnection(source.db, "site", { name: "Payment", kind: "payment", endpoint: "https://provider.example.org/api", allowedHost: "provider.example.org", secretRef: "RECONCILE_TEST_KEY", webhookSecretRef: "RECONCILE_TEST_WEBHOOK" });
    await checkout(source.db, String(order.id), String(provider.id), async () => ({ checkoutUrl: "https://provider.example.org/checkout", paymentId: "payment-refund" }));
    const paid = { eventId: "paid", orderId: order.id, paymentId: "payment-refund", amountMinor: 1000, currency: "KRW", status: "paid", sequence: 1 }; applyPaymentEvent(source.db, String(provider.id), paid); source.snapshot(path.join(root, "before-refund.sqlite")); restored = new Store(path.join(root, "before-refund.sqlite"));
    const command = await refundOrder(source.db, String(order.id), { amountMinor: 400, idempotencyKey: "refund-request" }, async () => ({})), report = compareOperationalData(source.db, restored.db); assert.ok(report.differences.some(item => item.kind === "payment-command" && item.id === command.commandId)); persistReconciliation(restored.db, report, source.db);
    const refunded = { ...paid, status: "partially_refunded", refundedMinor: 400 };
    await reconcileOrder(restored.db, String(order.id), async () => ({ ...refunded, eventId: "status-without-command", sequence: 2 })); assert.throws(() => assertFinancialReady(restored!.db, String(order.id)), /대사/); assert.equal(one(restored.db, "SELECT id FROM platform_payment_commands"), null);
    await assert.rejects(reconcileOrder(restored.db, String(order.id), async () => ({ ...refunded, eventId: "status-mismatched-command", sequence: 3, commands: [{ id: command.commandId, status: "verified", amountMinor: 500 }] })), /명령|환불/); assert.throws(() => assertFinancialReady(restored!.db, String(order.id)), /대사/);
    await reconcileOrder(restored.db, String(order.id), async () => ({ ...refunded, eventId: "status-verified-command", sequence: 4, commands: [{ id: command.commandId, status: "verified", amountMinor: 400 }] })); assert.equal(one(restored.db, "SELECT status FROM platform_payment_commands WHERE id=?", String(command.commandId))?.status, "verified"); assert.doesNotThrow(() => assertFinancialReady(restored!.db, String(order.id)));
    await assert.rejects(refundOrder(restored.db, String(order.id), { amountMinor: 500, idempotencyKey: "refund-request" }, async () => ({})), /금액/);
  } finally { source.close(); restored?.close(); assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), "automade-reconciliation-"))); await rm(root, { recursive: true, force: true }); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
