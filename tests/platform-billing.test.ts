import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { Store } from "../server/store";
import { applyBillingEvent, billingAction, billingState, configureBilling, publicBillingState } from "../server/platform/billing";
import { saveConnection } from "../server/platform/connections";
import { handlePlatformRequest } from "../server/platform";
import { fail, HttpError } from "../server/http";
function setup(store: Store): { connectionId: string; restore: () => void } {
  const names = ["PLATFORM_ALLOWED_HOSTS", "TEST_BILLING_KEY", "TEST_BILLING_WEBHOOK"] as const, previous = names.map((name) => process.env[name]);
  process.env.PLATFORM_ALLOWED_HOSTS = "billing.example.org"; process.env.TEST_BILLING_KEY = "test-key"; process.env.TEST_BILLING_WEBHOOK = "test-webhook";
  const connectionId = String(saveConnection(store.db, "project", { name: "Platform billing", kind: "payment", endpoint: "https://billing.example.org/api", allowedHost: "billing.example.org", secretRef: "TEST_BILLING_KEY", webhookSecretRef: "TEST_BILLING_WEBHOOK" }).id);
  configureBilling(store.db, "project", { connectionId, planCode: "team", priceMinor: 1000, currency: "KRW", periodDays: 30 });
  return { connectionId, restore: () => names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }) };
}
function paid(store: Store) {
  const subscription = billingState(store.db, "project").subscription!;
  return { namespace: "platform.subscription", eventId: "paid", sequence: 1, subscriptionId: subscription.id, providerSubscriptionId: "remote-subscription", amountMinor: 1000, currency: "KRW", status: "active", invoiceStatus: "paid", providerInvoiceId: "invoice-1", refundedMinor: 0, validUntil: new Date(Date.now() + 30 * 86400_000).toISOString() };
}
test("platform subscription is distinct from customer orders and requires authoritative paid invoice", async () => {
  const store = new Store(":memory:"), { connectionId, restore } = setup(store);
  try {
    assert.throws(() => configureBilling(store.db, "other", { connectionId, planCode: "team", priceMinor: 1000, currency: "KRW", periodDays: 30 }), /결제 연결/);
    await billingAction(store.db, "project", { action: "start", idempotencyKey: "start" }, async (_connection, _method, payload) => { assert.equal((payload as Record<string, unknown>).operation, "platform.subscription.start"); return { status: "active", providerSubscriptionId: "remote-subscription", checkoutUrl: "https://billing.example.org/checkout" }; });
    assert.equal(publicBillingState(store.db, "project").remoteBillingVerified, false); assert.equal(billingState(store.db, "project").subscription?.status, "pending");
    const event = paid(store);
    assert.throws(() => applyBillingEvent(store.db, "project", connectionId, { ...event, invoiceStatus: undefined }), /청구서 납부/);
    assert.throws(() => applyBillingEvent(store.db, "project", connectionId, { ...event, amountMinor: 1 }), /계약/);
    assert.throws(() => applyBillingEvent(store.db, "project", connectionId, { ...event, namespace: "customer.order" }), /구분/);
    assert.equal(applyBillingEvent(store.db, "project", connectionId, event).applied, true); assert.equal(publicBillingState(store.db, "project").remoteBillingVerified, true);
    assert.equal(applyBillingEvent(store.db, "project", connectionId, event).duplicate, true);
    assert.throws(() => applyBillingEvent(store.db, "project", connectionId, { ...event, validUntil: new Date(Date.now() + 31 * 86400_000).toISOString() }), /내용/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM platform_orders").get()?.n, 0);
  } finally { store.close(); restore(); }
});
test("subscription refunds are cumulative, stale events cannot regress, and cancel waits confirmation", async () => {
  const store = new Store(":memory:"), { connectionId, restore } = setup(store);
  try {
    await billingAction(store.db, "project", { action: "start", idempotencyKey: "start" }, async () => ({})); const event = paid(store); applyBillingEvent(store.db, "project", connectionId, event);
    applyBillingEvent(store.db, "project", connectionId, { ...event, eventId: "refund", sequence: 3, invoiceStatus: "partially_refunded", refundedMinor: 400 });
    assert.equal(applyBillingEvent(store.db, "project", connectionId, { ...event, eventId: "late", sequence: 2 }).applied, false);
    assert.throws(() => applyBillingEvent(store.db, "project", connectionId, { ...event, eventId: "decrease", sequence: 4 }), /되돌릴/);
    await billingAction(store.db, "project", { action: "cancel", idempotencyKey: "cancel" }, async () => ({ status: "cancelled" })); assert.equal(billingState(store.db, "project").subscription?.status, "cancel_pending");
    await billingAction(store.db, "project", { action: "reconcile", idempotencyKey: "verify" }, async (_connection, _method, payload) => { assert.equal((payload as Record<string, unknown>).operation, "platform.subscription.status"); return { ...event, eventId: "cancelled", sequence: 4, status: "cancelled", invoiceStatus: "refunded", refundedMinor: 1000 }; });
    assert.equal(publicBillingState(store.db, "project").remoteBillingVerified, false); assert.equal(billingState(store.db, "project").invoices[0]?.refundedMinor, 1000);
    assert.throws(() => applyBillingEvent(store.db, "project", connectionId, { ...event, eventId: "revive", sequence: 5 }), /다시 활성화/);
  } finally { store.close(); restore(); }
});
test("unknown provider effects retain same idempotency key and fail closed without configuration", async () => {
  const store = new Store(":memory:"), { restore } = setup(store);
  try {
    await assert.rejects(billingAction(store.db, "unconfigured", { action: "start", idempotencyKey: "start" }, async () => ({})), /먼저 설정/);
    const keys: Array<string | undefined> = [];
    await assert.rejects(billingAction(store.db, "project", { action: "start", idempotencyKey: "start" }, async (_connection, _method, _payload, key) => { keys.push(key); throw new HttpError(502, "TIMEOUT", "unknown"); }), /unknown/);
    assert.equal(billingState(store.db, "project").subscription?.status, "unknown"); assert.equal(publicBillingState(store.db, "project").pendingAction?.idempotencyKey, "start");
    await billingAction(store.db, "project", { action: "start", idempotencyKey: "start" }, async (_connection, _method, _payload, key) => { keys.push(key); return {}; }); assert.equal(keys[0], keys[1]); assert.equal(billingState(store.db, "project").invoices.length, 1);
    assert.equal(publicBillingState(store.db, "project").remoteBillingVerified, false);
  } finally { store.close(); restore(); }
});
test("billing HTTP is owner only and signed webhook uses distinct billing namespace", async () => {
  const store = new Store(":memory:"), { connectionId, restore } = setup(store); let origin = "";
  const server = createServer((req, res) => { void handlePlatformRequest(req, res, new URL(req.url ?? "/", origin), { db: store.db, origin, requestId: "billing", projectId: "project", localOwner: false }).catch((error: unknown) => fail(res, error, "billing")); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string"); origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/platform/billing/subscription`)).status, 401);
    await billingAction(store.db, "project", { action: "start", idempotencyKey: "start" }, async () => ({}));
    const raw = JSON.stringify(paid(store)), timestamp = String(Date.now()), signature = createHmac("sha256", "test-webhook").update(`${timestamp}.${raw}`).digest("hex");
    const call = (sign: string) => fetch(`${origin}/api/platform/billing/webhooks/${connectionId}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Timestamp": timestamp, "X-Webhook-Signature": sign }, body: raw });
    assert.equal((await call("invalid")).status, 401); assert.equal((await call(signature)).status, 200); assert.equal(publicBillingState(store.db, "project").remoteBillingVerified, true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); restore(); }
});
test("webhook received during provider await is preserved and late response cannot mutate replacement subscription", async () => {
  const store = new Store(":memory:"), { connectionId, restore } = setup(store);
  try {
    await billingAction(store.db, "project", { action: "start", idempotencyKey: "start" }, async () => {
      applyBillingEvent(store.db, "project", connectionId, paid(store));
      return { status: "pending", providerSubscriptionId: "remote-subscription" };
    });
    assert.equal(billingState(store.db, "project").subscription?.status, "active"); assert.equal(billingState(store.db, "project").invoices[0]?.status, "paid"); assert.equal(billingState(store.db, "project").events.length, 1);
    const oldEvent = paid(store), oldId = oldEvent.subscriptionId;
    await assert.rejects(billingAction(store.db, "project", { action: "cancel", idempotencyKey: "cancel" }, async () => {
      applyBillingEvent(store.db, "project", connectionId, { ...oldEvent, eventId: "cancel", sequence: 2, status: "cancelled", invoiceStatus: undefined });
      await billingAction(store.db, "project", { action: "start", idempotencyKey: "new-subscription" }, async () => ({}));
      return { status: "cancelled", providerSubscriptionId: "remote-subscription" };
    }), /구독이 교체/);
    const latest = billingState(store.db, "project"); assert.notEqual(latest.subscription?.id, oldId); assert.equal(latest.subscription?.status, "pending"); assert.equal(latest.subscription?.providerSubscriptionId, null); assert.equal(latest.events.length, 2); assert.equal(latest.invoices[0]?.status, "paid");
  } finally { store.close(); restore(); }
});
