import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { Store } from "../server/store";
import { createAccount, invite, acceptInvite, issueReset, resetPassword, authorize, type Identity } from "../server/platform/auth";
import { applyPaymentEvent, cancelBooking, cancelOrder, checkout, createBooking, createOrder, refundOrder, saveProduct, saveResource, saveSlot, verifyWebhook } from "../server/platform/business";
import { connectionInfo, enqueue, externalData, outboxInfo, processOutbox, retryOutbox, saveConnection, validateEndpoint } from "../server/platform/connections";
import { AdapterPolicyService } from "../server/advancement/adapters";
import { handlePlatformRequest } from "../server/platform";
import { hash, one } from "../server/platform/common";
import { fail, HttpError } from "../server/http";
const owner: Identity = { accountId: null, csrf: "", tokenHash: "", localOwner: true };
const visitor = (id: string): Identity => ({ ...owner, accountId: id, localOwner: false });
async function account(store: Store, name = "person"): Promise<string> { return String((await createAccount(store.db, { email: `${name}@example.org`, password: "long-password-2026", displayName: name })).id); }
function environment(): () => void {
  const before = { hosts: process.env.PLATFORM_ALLOWED_HOSTS, key: process.env.TEST_PLATFORM_KEY, webhook: process.env.TEST_PLATFORM_WEBHOOK };
  process.env.PLATFORM_ALLOWED_HOSTS = "provider.example.org"; process.env.TEST_PLATFORM_KEY = "test-only-key"; process.env.TEST_PLATFORM_WEBHOOK = "test-only-webhook";
  return () => { for (const [name, value] of [["PLATFORM_ALLOWED_HOSTS", before.hosts], ["TEST_PLATFORM_KEY", before.key], ["TEST_PLATFORM_WEBHOOK", before.webhook]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
}
function connection(store: Store, kind = "payment"): string { return String(saveConnection(store.db, "site", { name: kind, kind, endpoint: "https://provider.example.org/api", allowedHost: "provider.example.org", secretRef: "TEST_PLATFORM_KEY", webhookSecretRef: kind === "payment" ? "TEST_PLATFORM_WEBHOOK" : "", mapping: kind === "data" ? { title: "name", count: "nested.count" } : {} }).id); }
test("accounts hash passwords; scoped invitations enforce recipient, expiry, revocation and roles", async () => {
  const store = new Store(":memory:");
  try {
    const alice = await account(store, "alice"), bob = await account(store, "bob");
    assert.ok(!String(one(store.db, "SELECT password_hash FROM platform_accounts WHERE id=?", alice)?.password_hash).includes("long-password"));
    await assert.rejects(createAccount(store.db, { email: "bad@example.org", password: "short", displayName: "bad" }), /12자/);
    const invitation = invite(store.db, "site", "alice@example.org", "editor");
    assert.throws(() => acceptInvite(store.db, visitor(bob), invitation.token), /계정과 일치/);
    acceptInvite(store.db, visitor(alice), invitation.token);
    authorize(store.db, visitor(alice), "site", ["editor"]);
    assert.throws(() => authorize(store.db, visitor(alice), "other", ["editor"]), /권한/);
    assert.throws(() => authorize(store.db, visitor(alice), "site", ["operator"]), /권한/);
    assert.throws(() => acceptInvite(store.db, visitor(alice), invitation.token), /만료/);
    const expired = invite(store.db, "site", "bob@example.org", "reviewer"); store.db.prepare("UPDATE platform_invites SET expires_at=0 WHERE id=?").run(String(expired.id)); assert.throws(() => acceptInvite(store.db, visitor(bob), expired.token), /만료/);
    const revoked = invite(store.db, "site", "bob@example.org", "operator"); store.db.prepare("UPDATE platform_invites SET status='revoked' WHERE id=?").run(String(revoked.id)); assert.throws(() => acceptInvite(store.db, visitor(bob), revoked.token), /만료/);
  } finally { store.close(); }
});
test("password recovery expires, is single use, and revokes all existing account sessions", async () => {
  const store = new Store(":memory:");
  try {
    const id = await account(store); store.db.prepare("INSERT INTO platform_sessions VALUES(?,?,?,?)").run(hash("old-session"), id, "csrf", Date.now() + 10000);
    const expired = issueReset(store.db, "person@example.org")!; store.db.prepare("UPDATE platform_reset_tokens SET expires_at=0 WHERE token_hash=?").run(hash(expired.token));
    await assert.rejects(resetPassword(store.db, expired.token, "new-long-password"), /만료/);
    const reset = issueReset(store.db, "person@example.org")!; await resetPassword(store.db, reset.token, "new-long-password");
    assert.equal(one(store.db, "SELECT COUNT(*) AS n FROM platform_sessions WHERE account_id=?", id)?.n, 0);
    await assert.rejects(resetPassword(store.db, reset.token, "another-long-password"), /이미 사용/);
    assert.equal(issueReset(store.db, "unknown@example.org"), null);
  } finally { store.close(); }
});
test("orders use server prices, atomic inventory, durable idempotency and reservation restoration", async () => {
  const store = new Store(":memory:");
  try {
    const buyer = await account(store), product = saveProduct(store.db, "site", { name: "Item", priceMinor: 1200, currency: "KRW", inventory: 2 });
    const input = { items: [{ productId: product.id, quantity: 2 }], idempotencyKey: "order-key", amountMinor: 1 };
    const order = createOrder(store.db, "site", buyer, input);
    assert.equal(order.amount_minor, 2400); assert.equal(createOrder(store.db, "site", buyer, input).id, order.id);
    assert.equal(one(store.db, "SELECT inventory FROM platform_products WHERE id=?", String(product.id))?.inventory, 0);
    assert.throws(() => createOrder(store.db, "site", buyer, { ...input, items: [{ productId: product.id, quantity: 1 }] }), /같은 주문/);
    assert.throws(() => createOrder(store.db, "site", buyer, { ...input, idempotencyKey: "another" }), /재고/);
    assert.equal(one(store.db, "SELECT COUNT(*) AS n FROM platform_orders")?.n, 1);
    cancelOrder(store.db, String(order.id)); cancelOrder(store.db, String(order.id));
    assert.equal(one(store.db, "SELECT inventory FROM platform_products WHERE id=?", String(product.id))?.inventory, 2);
  } finally { store.close(); }
});
test("usage limits reject orders with rollback of inventory and expose no paid subscription fiction", async () => {
  const store = new Store(":memory:");
  try {
    const buyer = await account(store), product = saveProduct(store.db, "site", { name: "Item", priceMinor: 500, currency: "KRW", inventory: 5 });
    store.db.prepare("INSERT INTO platform_billing VALUES(?,?,?,?)").run("site", "local", JSON.stringify({ orders: 0 }), new Date().toISOString());
    assert.throws(() => createOrder(store.db, "site", buyer, { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: "limit" }), /한도/);
    assert.equal(one(store.db, "SELECT inventory FROM platform_products WHERE id=?", String(product.id))?.inventory, 5);
    assert.equal(one(store.db, "SELECT COUNT(*) AS n FROM platform_orders")?.n, 0);
  } finally { store.close(); }
});
test("checkout remains unpaid until authoritative provider events; duplicate and stale events cannot regress refunds", async () => {
  const restore = environment(), store = new Store(":memory:");
  try {
    const buyer = await account(store), product = saveProduct(store.db, "site", { name: "Item", priceMinor: 1000, currency: "KRW", inventory: 3 });
    const order = createOrder(store.db, "site", buyer, { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: "order" }), id = String(order.id), provider = connection(store);
    const started = await checkout(store.db, id, provider, async (_provider, _method, payload) => { assert.equal((payload as Record<string, unknown>).amountMinor, 1000); return { checkoutUrl: "https://provider.example.org/checkout", paymentId: "payment" }; });
    assert.equal(started.verifiedPaid, false); assert.equal(one(store.db, "SELECT status FROM platform_orders WHERE id=?", id)?.status, "checkout_pending");
    const paid = { eventId: "paid", orderId: id, paymentId: "payment", amountMinor: 1000, currency: "KRW", status: "paid", sequence: 1, refundedMinor: 0 };
    assert.equal(applyPaymentEvent(store.db, provider, paid).applied, true); assert.equal(applyPaymentEvent(store.db, provider, paid).duplicate, true);
    assert.throws(() => applyPaymentEvent(store.db, provider, { ...paid, amountMinor: 999 }), /같은 이벤트/);
    await refundOrder(store.db, id, { amountMinor: 400, idempotencyKey: "refund" }, async () => ({ accepted: true }));
    assert.equal(one(store.db, "SELECT refunded_minor FROM platform_orders WHERE id=?", id)?.refunded_minor, 0);
    applyPaymentEvent(store.db, provider, { ...paid, eventId: "refund", status: "partially_refunded", refundedMinor: 400, sequence: 3 });
    assert.equal(applyPaymentEvent(store.db, provider, { ...paid, eventId: "late-paid", sequence: 2 }).applied, false);
    assert.equal(one(store.db, "SELECT status FROM platform_orders WHERE id=?", id)?.status, "partially_refunded");
    assert.throws(() => applyPaymentEvent(store.db, provider, { ...paid, eventId: "decrease", sequence: 4 }), /감소/);
    assert.throws(() => applyPaymentEvent(store.db, provider, { ...paid, eventId: "wrong", currency: "USD", sequence: 4 }), /일치/);
  } finally { store.close(); restore(); }
});
test("webhook HMAC binds original body and timestamp, rejects replay window and malformed signatures", () => {
  const secret = "test-secret", raw = '{"eventId":"one"}', timestamp = String(Date.now()), sign = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  assert.doesNotThrow(() => verifyWebhook(secret, timestamp, raw, sign));
  assert.throws(() => verifyWebhook(secret, timestamp, raw + " ", sign), /인증/);
  assert.throws(() => verifyWebhook(secret, String(Date.now() - 600_000), raw, sign), /만료/);
  assert.throws(() => verifyWebhook(secret, timestamp, raw, "bad"), /인증/);
});
test("booking capacity and time overlap checks are transactional; cancellation frees capacity", async () => {
  const store = new Store(":memory:");
  try {
    const buyer = await account(store), resource = saveResource(store.db, "site", { name: "Room", capacity: 2 });
    const startsAt = new Date(Date.now() + 86400_000).toISOString(), endsAt = new Date(Date.now() + 90000_000).toISOString();
    const slot = saveSlot(store.db, "site", { resourceId: resource.id, startsAt, endsAt });
    assert.throws(() => saveSlot(store.db, "site", { resourceId: resource.id, startsAt, endsAt }), /겹치는/);
    const first = createBooking(store.db, "site", buyer, { slotId: slot.id, quantity: 2, idempotencyKey: "first" });
    assert.equal(createBooking(store.db, "site", buyer, { slotId: slot.id, quantity: 2, idempotencyKey: "first" }).id, first.id);
    assert.throws(() => createBooking(store.db, "site", buyer, { slotId: slot.id, quantity: 1, idempotencyKey: "second" }), /정원/);
    cancelBooking(store.db, String(first.id)); const second = createBooking(store.db, "site", buyer, { slotId: slot.id, quantity: 1, idempotencyKey: "second" }); assert.equal(second.status, "confirmed");
    assert.throws(() => createBooking(store.db, "other", buyer, { slotId: slot.id, quantity: 1, idempotencyKey: "cross" }), /예약 가능한/);
  } finally { store.close(); }
});
test("connection setup restricts hosts and keeps environment secrets outside public configuration", () => {
  const restore = environment(), store = new Store(":memory:");
  try {
    assert.throws(() => validateEndpoint("http://provider.example.org/", "provider.example.org"), /HTTPS/);
    assert.throws(() => validateEndpoint("https://127.0.0.1/", "127.0.0.1"), /허용 호스트/);
    assert.throws(() => validateEndpoint("https://provider.example.org@evil.example.org/", "provider.example.org"), /HTTPS/);
    connection(store, "mail"); assert.ok(!JSON.stringify(connectionInfo(store.db, "site")).includes("test-only-key"));
    assert.throws(() => saveConnection(store.db, "site", { name: "bad", kind: "data", endpoint: "https://provider.example.org/api", allowedHost: "provider.example.org", mapping: { x: "__proto__.x" } }), /매핑/);
  } finally { store.close(); restore(); }
});
test("outbox is durable and idempotent, respects pause and bounded failures; data mapping cache refreshes", async () => {
  const restore = environment(), store = new Store(":memory:");
  try {
    const mail = connection(store, "mail"), id = enqueue(store.db, "site", mail, "event", { message: "hello" });
    new AdapterPolicyService(store.db).save('site',mail,{baseRevision:0,capabilities:{idempotentWrites:true}});
    assert.equal(enqueue(store.db, "site", mail, "event", { message: "hello" }), id); assert.throws(() => enqueue(store.db, "site", mail, "event", { message: "different" }), /같은 이벤트/);
    store.db.prepare("UPDATE platform_connections SET paused=1 WHERE id=?").run(mail); assert.equal(await processOutbox(store.db, async () => ({ accepted: true })), 0);
    store.db.prepare("UPDATE platform_connections SET paused=0 WHERE id=?").run(mail);
    await processOutbox(store.db, async () => { throw new HttpError(503, "PROVIDER_RETRYABLE", "test failure"); }); assert.equal(outboxInfo(store.db, "site")[0]?.status, "pending");
    store.db.prepare("UPDATE platform_outbox SET attempts=4,next_at=0 WHERE id=?").run(id); await processOutbox(store.db, async () => { throw new HttpError(503, "PROVIDER_RETRYABLE", "test failure"); }); assert.equal(outboxInfo(store.db, "site")[0]?.status, "failed");
    const data = connection(store, "data"); let calls = 0;
    const transport = async () => { calls++; return { data: [{ name: "Mapped", nested: { count: 2 } }] }; };
    assert.deepEqual((await externalData(store.db, data, false, transport)).rows, [{ title: "Mapped", count: 2 }]); await externalData(store.db, data, false, transport); assert.equal(calls, 1); await externalData(store.db, data, true, transport); assert.equal(calls, 2);
  } finally { store.close(); restore(); }
});
test("platform HTTP requires CSRF, prevents cross-owner reads, authenticates private content and one-person approval", async () => {
  const store = new Store(":memory:"); let origin = "";
  const server = createServer((req, res) => { void handlePlatformRequest(req, res, new URL(req.url ?? "/", origin), { db: store.db, origin, requestId: "test", projectId: "site", localOwner: false, memberProject: () => ({ protected: "private" }) }).catch((error: unknown) => fail(res, error, "test")); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string"); origin = `http://127.0.0.1:${address.port}`;
  let cookie = "", csrf = "";
  async function request(path: string, method = "GET", payload?: unknown, includeCsrf = true): Promise<{ status: number; data: Record<string, unknown> | null }> {
    const response = await fetch(`${origin}/api/platform/${path}?projectId=site`, { method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie, ...(includeCsrf ? { "X-Platform-CSRF": csrf } : {}) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const envelope = await response.json() as { data: Record<string, unknown> | null }; if (envelope.data && typeof envelope.data.csrf === "string") csrf = envelope.data.csrf;
    return { status: response.status, data: envelope.data };
  }
  try {
    await request("session"); assert.equal((await request("member-project")).status, 401);
    assert.equal((await request("accounts", "POST", { email: "reader@example.org", password: "long-test-password", displayName: "Reader" }, false)).status, 403);
    assert.equal((await request("accounts", "POST", { email: "reader@example.org", password: "long-test-password", displayName: "Reader" })).status, 201);
    assert.equal((await request("login", "POST", { email: "reader@example.org", password: "long-test-password" })).status, 200);
    assert.equal((await request("member-project")).data?.protected, "private"); assert.equal((await request("connections")).status, 403);
    const accountId = String(one(store.db, "SELECT id FROM platform_accounts WHERE email='reader@example.org'")?.id); store.db.prepare("INSERT INTO platform_memberships VALUES('site',?,'owner')").run(accountId);
    const review = await request("reviews", "POST", { revision: 1 }); assert.equal(review.status, 201);
    assert.equal((await request(`reviews/${review.data?.id}/decision`, "POST", { status: "approved" })).status, 403);
    assert.equal((await request("logout", "POST", {})).status, 200); assert.equal((await request("member-project")).status, 401);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); }
});
test("checkout and refund responses preserve webhook truth during provider await and recheck write leases", async () => {
  const restore = environment(), store = new Store(":memory:");
  try {
    const buyer = await account(store), product = saveProduct(store.db, "site", { name: "Item", priceMinor: 1000, currency: "KRW", inventory: 3 }), provider = connection(store);
    const current = createOrder(store.db, "site", buyer, { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: "race" }), id = String(current.id);
    const paid = { eventId: "paid-race", orderId: id, paymentId: "payment", amountMinor: 1000, currency: "KRW", status: "paid", sequence: 1, refundedMinor: 0 };
    const response = await checkout(store.db, id, provider, async () => { applyPaymentEvent(store.db, provider, paid); return { checkoutUrl: "https://provider.example.org/checkout", paymentId: "payment" }; });
    assert.equal(response.verifiedPaid, true); assert.equal(response.status, "paid");
    const refunded = await refundOrder(store.db, id, { amountMinor: 400, idempotencyKey: "refund-race" }, async () => { applyPaymentEvent(store.db, provider, { ...paid, eventId: "refund-race", status: "partially_refunded", refundedMinor: 400, sequence: 2 }); return {}; });
    assert.equal(refunded.status, "verified"); assert.equal(one(store.db, "SELECT refunded_minor FROM platform_orders WHERE id=?", id)?.refunded_minor, 400);
    const next = createOrder(store.db, "site", buyer, { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: "lease" });
    await assert.rejects(checkout(store.db, String(next.id), provider, async () => ({ checkoutUrl: "https://provider.example.org/checkout", paymentId: "late-payment" }), () => { throw new HttpError(409, "SITE_REPLACED", "replaced"); }), /replaced/);
    assert.equal(one(store.db, "SELECT provider_payment_id FROM platform_orders WHERE id=?", String(next.id))?.provider_payment_id, null);
  } finally { store.close(); restore(); }
});
test("password recovery outbox scrubs terminal tokens and rejects expired or removed recovery retries", async () => {
  const restore = environment(), store = new Store(":memory:");
  try {
    await account(store); const provider = connection(store, "mail"), reset = issueReset(store.db, "person@example.org")!;
    const sent = enqueue(store.db, "site", provider, "reset-sent", { type: "account.password_reset", token: reset.token });
    await processOutbox(store.db, async (_connection, _method, request) => { assert.equal(((request as Record<string, unknown>).payload as Record<string, unknown>).token, reset.token); return {}; });
    assert.ok(!String(one(store.db, "SELECT body FROM platform_outbox WHERE id=?", sent)?.body).includes(reset.token));
    const failedReset = issueReset(store.db, "person@example.org")!, failed = enqueue(store.db, "site", provider, "reset-failed", { type: "account.password_reset", token: failedReset.token });
    await processOutbox(store.db, async () => { throw new HttpError(502, "PROVIDER_REJECTED", "rejected"); });
    assert.ok(!String(one(store.db, "SELECT body FROM platform_outbox WHERE id=?", failed)?.body).includes(failedReset.token)); assert.throws(() => retryOutbox(store.db, "site", failed), /새 복구 요청/);
    const expiredReset = issueReset(store.db, "person@example.org")!, expired = enqueue(store.db, "site", provider, "reset-expired", { type: "account.password_reset", token: expiredReset.token });
    store.db.prepare("UPDATE platform_reset_tokens SET expires_at=0 WHERE token_hash=?").run(hash(expiredReset.token)); store.db.prepare("UPDATE platform_connections SET paused=1 WHERE id=?").run(provider);
    let calls = 0; await processOutbox(store.db, async () => { calls++; return {}; }); assert.equal(calls, 0);
    assert.equal(one(store.db, "SELECT error_code FROM platform_outbox WHERE id=?", expired)?.error_code, "RESET_TOKEN_EXPIRED"); assert.ok(!String(one(store.db, "SELECT body FROM platform_outbox WHERE id=?", expired)?.body).includes(expiredReset.token));
  } finally { store.close(); restore(); }
});
test("pausing during an outbox batch preserves unstarted messages and their retry budget", async () => {
  const restore = environment(), store = new Store(":memory:");
  try {
    const provider = connection(store, "mail"), first = enqueue(store.db, "site", provider, "first", { message: "one" }), second = enqueue(store.db, "site", provider, "second", { message: "two" });
    // Make the batch order explicit without depending on millisecond insertion timestamps.
    store.db.prepare("UPDATE platform_outbox SET created_at=? WHERE id=?").run("2026-01-01T00:00:00.000Z", first); store.db.prepare("UPDATE platform_outbox SET created_at=? WHERE id=?").run("2026-01-02T00:00:00.000Z", second);
    let calls = 0; await processOutbox(store.db, async () => { calls++; store.db.prepare("UPDATE platform_connections SET paused=1 WHERE id=?").run(provider); return { accepted: true }; });
    assert.equal(calls, 1); assert.equal(one(store.db, "SELECT status FROM platform_outbox WHERE id=?", first)?.status, "sent"); assert.equal(one(store.db, "SELECT attempts FROM platform_outbox WHERE id=?", first)?.attempts, 1);
    assert.equal(one(store.db, "SELECT status FROM platform_outbox WHERE id=?", second)?.status, "pending"); assert.equal(one(store.db, "SELECT attempts FROM platform_outbox WHERE id=?", second)?.attempts, 0); assert.equal(one(store.db, "SELECT lease_until FROM platform_outbox WHERE id=?", second)?.lease_until, 0);
    store.db.prepare("UPDATE platform_connections SET paused=0 WHERE id=?").run(provider); await processOutbox(store.db, async () => { calls++; return {}; }); assert.equal(calls, 2); assert.equal(one(store.db, "SELECT status FROM platform_outbox WHERE id=?", second)?.status, "sent");
  } finally { store.close(); restore(); }
});
test("outbox claims individually and late responses cannot overwrite a newer worker lease or delivery", async () => {
  const restore = environment();
  try {
    for (const outcome of ["failure", "success"] as const) {
      const store = new Store(":memory:");
      try {
        const provider = connection(store, "mail"), first = enqueue(store.db, "site", provider, "first", { message: "one" }), second = enqueue(store.db, "site", provider, "second", { message: "two" });
        store.db.prepare("UPDATE platform_outbox SET created_at=? WHERE id=?").run("2026-01-01T00:00:00.000Z", first); store.db.prepare("UPDATE platform_outbox SET created_at=? WHERE id=?").run("2026-01-02T00:00:00.000Z", second);
        let finish: (() => void) | undefined, started: (() => void) | undefined;
        const entered = new Promise<void>((resolve) => { started = resolve; }), release = new Promise<void>((resolve) => { finish = resolve; });
        const sending = processOutbox(store.db, async () => { started!(); await release; if (outcome === "failure") throw new HttpError(503, "PROVIDER_RETRYABLE", "late failure"); return {}; });
        await entered;
        assert.equal(one(store.db, "SELECT status FROM platform_outbox WHERE id=?", second)?.status, "pending"); assert.equal(one(store.db, "SELECT attempts FROM platform_outbox WHERE id=?", second)?.attempts, 0); assert.equal(one(store.db, "SELECT lease_until FROM platform_outbox WHERE id=?", second)?.lease_until, 0);
        const oldLease = Number(one(store.db, "SELECT lease_until FROM platform_outbox WHERE id=?", first)?.lease_until), newLease = oldLease + 60_000, newStatus = outcome === "failure" ? "sent" : "sending";
        store.db.prepare("UPDATE platform_outbox SET status=?,lease_until=?,attempts=3,body=?,error_code=NULL WHERE id=?").run(newStatus, newLease, JSON.stringify({ message: "newer worker" }), first);
        store.db.prepare("UPDATE platform_connections SET paused=1 WHERE id=?").run(provider);
        finish!(); assert.equal(await sending, 1);
        const latest = one(store.db, "SELECT status,lease_until,attempts,body,error_code FROM platform_outbox WHERE id=?", first)!;
        assert.equal(latest.status, newStatus); assert.equal(latest.lease_until, newLease); assert.equal(latest.attempts, 3); assert.equal(latest.body, JSON.stringify({ message: "newer worker" })); assert.equal(latest.error_code, null);
        assert.equal(one(store.db, "SELECT status FROM platform_outbox WHERE id=?", second)?.status, "pending"); assert.equal(one(store.db, "SELECT attempts FROM platform_outbox WHERE id=?", second)?.attempts, 0);
      } finally { store.close(); }
    }
  } finally { restore(); }
});
