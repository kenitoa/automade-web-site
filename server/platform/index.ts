import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { body, ensureOrigin, HttpError, RateLimit, reply } from "../http";
import { record } from "../../src/domain/validation";
import { acceptInvite, accessList, accountInfo, authorize, checkCsrf, createAccount, invite, issueReset, login, logout, requireAccount, resetPassword, role, session } from "./auth";
import { audit, hash, integer, many, now, one, period, projectId, text, transaction } from "./common";
import { connectionInfo, connectionSecret, enqueue, externalData, getConnection, outboxInfo, processOutbox, retryOutbox, saveConnection, testConnection } from "./connections";
import { applyPaymentEvent, cancelBooking, cancelOrder, catalog, checkout, createBooking, createOrder, orders, reconcileOrder, refundOrder, saveProduct, saveResource, saveSlot, slots, verifyWebhook } from "./business";
import { applyBillingEvent, billingAction, configureBilling, publicBillingState } from "./billing";
import { BookingExpansion } from "../expansion/bookings";
export { PLATFORM_MIGRATION } from "./schema";
export { bootstrapAdmin } from "./auth";
export { startPlatformWorker, enqueueSubmission } from "./connections";
export interface PlatformContext { db: DatabaseSync; requestId: string; projectId?: string; localOwner: boolean; origin: string; trustedCsrf?: boolean; assertWritable?: () => void; memberProject?: () => unknown; }
const rates = new RateLimit();
async function webhookBody(req: IncomingMessage): Promise<string> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "CONTENT_TYPE", "JSON 웹훅이 필요합니다.");
  let size = 0; const chunks: Buffer[] = [];
  for await (const value of req) { const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array); size += chunk.length; if (size > 1_000_000) throw new HttpError(413, "WEBHOOK_SIZE", "웹훅 크기 한도를 초과했습니다."); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}
export async function handlePlatformRequest(req: IncomingMessage, res: ServerResponse, url: URL, context: PlatformContext): Promise<boolean> {
  if (!url.pathname.startsWith("/api/platform/")) return false;
  const { db, origin, requestId } = context, route = url.pathname.slice("/api/platform/".length), method = req.method ?? "GET";
  const send = (data: unknown, status = 200): void => reply(res, status, data, undefined, requestId);
  ensureOrigin(req, origin);
  rates.check(`platform:${req.socket.remoteAddress}`, 240);
  if ((route.startsWith("webhooks/") || route.startsWith("billing/webhooks/")) && method === "POST") {
    rates.check(`webhook:${req.socket.remoteAddress}`, 120);
    const billingWebhook = route.startsWith("billing/webhooks/");
    const id = text(route.slice(billingWebhook ? 17 : 9), "연결 ID", 100), connection = getConnection(db, id);
    const secret = connectionSecret(connection, connection.webhookSecretRef);
    if (connection.kind !== "payment" || !secret || connection.paused) throw new HttpError(503, "WEBHOOK_CONFIG", "웹훅 연결이 준비되지 않았습니다.");
    const raw = await webhookBody(req);
    verifyWebhook(secret, String(req.headers["x-webhook-timestamp"] ?? ""), raw, String(req.headers["x-webhook-signature"] ?? ""));
    let parsed: unknown; try { parsed = JSON.parse(raw) as unknown; } catch { throw new HttpError(400, "JSON", "웹훅 JSON을 확인하세요."); }
    if (context.projectId && connection.projectId !== context.projectId) throw new HttpError(404, "CONNECTION", "이 사이트의 연결이 아닙니다.");
    context.assertWritable?.(); send(billingWebhook ? applyBillingEvent(db, connection.projectId, id, record(parsed)) : applyPaymentEvent(db, id, record(parsed))); return true;
  }
  const cookieScope = context.projectId ?? url.searchParams.get("projectId") ?? "local";
  const identity = session(db, req, res, origin, context.localOwner, route === "session" && method === "GET", cookieScope);
  if (!["GET", "HEAD"].includes(method)) { ensureOrigin(req, origin, true); if (!context.trustedCsrf) checkCsrf(req, identity); }
  if (route === "session" && method === "GET") { send({ account: accountInfo(db, identity), csrf: identity.csrf, localOwner: identity.localOwner }); return true; }
  if (route === "member-project" && method === "GET") { requireAccount(identity); if (!context.memberProject) throw new HttpError(404, "MEMBER_PROJECT", "회원 콘텐츠를 찾을 수 없습니다."); send(context.memberProject()); return true; }
  let input: Record<string, unknown> = {};
  if (!["GET", "HEAD"].includes(method)) input = record(await body(req, 1_000_000));
  const project = projectId(context.projectId ?? input.projectId ?? url.searchParams.get("projectId") ?? "local");
  const manage = (): void => authorize(db, identity, project, ["operator"]);
  const own = (table: "platform_orders" | "platform_bookings", id: string): void => {
    const current = one(db, `SELECT account_id,project_id FROM ${table} WHERE id=?`, id);
    if (!current || current.project_id !== project) throw new HttpError(404, "RESOURCE", "이 사이트의 항목을 찾을 수 없습니다.");
    if (!identity.localOwner && current.account_id !== identity.accountId) manage();
  };
  if (["accounts", "login", "password-reset/request", "password-reset/confirm"].includes(route)) rates.check(`auth:${req.socket.remoteAddress}`, 10, 60_000);
  if (route === "accounts" && method === "POST") { send(await createAccount(db, { email: input.email, password: input.password, displayName: input.displayName }), 201); return true; }
  if (route === "login" && method === "POST") { send(await login(db, req, res, origin, { email: input.email, password: input.password }, cookieScope)); return true; }
  if (route === "logout" && method === "POST") { logout(db, identity, res, origin, cookieScope); send({ loggedOut: true }); return true; }
  if (route === "password-reset/request" && method === "POST") {
    const reset = issueReset(db, input.email);
    const delivery = connectionInfo(db, project).find((connection) => connection.kind === "mail" && connection.configured && !connection.paused);
    if (reset && delivery) enqueue(db, project, String(delivery.id), `reset:${randomUUID()}`, { type: "account.password_reset", email: text(input.email, "이메일", 254), token: reset.token, expiresMinutes: 15, expiresAt: new Date(Number(one(db, "SELECT expires_at FROM platform_reset_tokens WHERE token_hash=?", hash(reset.token))?.expires_at)).toISOString() });
    send({ message: "등록된 계정과 발송 연결이 있으면 복구 안내를 전달합니다.", ...(identity.localOwner && reset ? { localRecoveryToken: reset.token, delivery: delivery ? "queued" : "local-only" } : {}) }); return true;
  }
  if (route === "password-reset/confirm" && method === "POST") { await resetPassword(db, input.token, input.password); send({ reset: true, sessionsRevoked: true }); return true; }
  if (route === "capabilities" && method === "GET") {
    const current = role(db, identity, project), connections = connectionInfo(db, project);
    const payment = connections.find((connection) => connection.kind === "payment" && connection.configured && !connection.paused);
    send({ role: current, canManage: identity.localOwner || (identity.accountId !== null && (current === "owner" || current === "operator")), commerce: catalog(db, project).length > 0, booking: slots(db, project).length > 0, paymentConfigured: Boolean(payment), paymentConnectionId: payment?.id ?? null, member: true }); return true;
  }
  if (route === "invites/accept" && method === "POST") { acceptInvite(db, identity, input.token); send({ accepted: true }); return true; }
  if (!method.match(/^(GET|HEAD)$/)) context.assertWritable?.();
  if (route === "access" && method === "GET") { authorize(db, identity, project, []); send(accessList(db, project)); return true; }
  if (route === "invites" && method === "POST") { authorize(db, identity, project, []); send(invite(db, project, input.email, input.role), 201); return true; }
  const revokeInvite = route.match(/^invites\/([^/]+)\/revoke$/);
  if (revokeInvite && method === "POST") { authorize(db, identity, project, []); db.prepare("UPDATE platform_invites SET status='revoked' WHERE id=? AND project_id=? AND status='pending'").run(revokeInvite[1]!, project); audit(db, "invite.revoke", revokeInvite[1]!); send({ revoked: true }); return true; }
  const memberRoute = route.match(/^access\/([^/]+)$/);
  if (memberRoute && method === "DELETE") {
    authorize(db, identity, project, []);
    transaction(db, () => { const membership = one(db, "SELECT role FROM platform_memberships WHERE project_id=? AND account_id=?", project, memberRoute[1]!); if (membership?.role === "owner" && Number(one(db, "SELECT COUNT(*) AS n FROM platform_memberships WHERE project_id=? AND role='owner'", project)?.n) <= 1) throw new HttpError(409, "LAST_OWNER", "마지막 소유자는 제거할 수 없습니다."); db.prepare("DELETE FROM platform_memberships WHERE project_id=? AND account_id=?").run(project, memberRoute[1]!); audit(db, "membership.revoke", memberRoute[1]!); }); send({ revoked: true }); return true;
  }
  if (route === "reviews" && method === "GET") { authorize(db, identity, project, ["editor", "reviewer", "operator"]); send(many(db, "SELECT * FROM platform_reviews WHERE project_id=? ORDER BY created_at DESC LIMIT 100", project).map((review) => ({ ...review, comments: many(db, "SELECT id,author_id AS authorId,body,created_at AS createdAt FROM platform_comments WHERE review_id=? ORDER BY created_at LIMIT 200", String(review.id)) }))); return true; }
  if (route === "reviews" && method === "POST") { authorize(db, identity, project, ["editor"]); const id = randomUUID(); db.prepare("INSERT INTO platform_reviews(id,project_id,revision,status,created_by,created_at) VALUES(?,?,?,'pending',?,?)").run(id, project, integer(input.revision, "원본 revision"), identity.accountId ?? "local-owner", now()); audit(db, "review.request", id); send({ id, status: "pending" }, 201); return true; }
  const reviewRoute = route.match(/^reviews\/([^/]+)\/(comments|decision)$/);
  if (reviewRoute && method === "POST") {
    const review = one(db, "SELECT * FROM platform_reviews WHERE id=? AND project_id=?", reviewRoute[1]!, project);
    if (!review) throw new HttpError(404, "REVIEW", "검토 요청을 찾을 수 없습니다.");
    if (reviewRoute[2] === "comments") { authorize(db, identity, project, ["editor", "reviewer", "operator"]); const id = randomUUID(); db.prepare("INSERT INTO platform_comments VALUES(?,?,?,?,?)").run(id, String(review.id), identity.accountId ?? "local-owner", text(input.body, "검토 의견", 2000), now()); audit(db, "review.comment", String(review.id)); send({ id }, 201); }
    else { authorize(db, identity, project, ["reviewer"]); if (review.status !== "pending") throw new HttpError(409, "REVIEW_STATUS", "이미 결정한 검토입니다."); const actor = identity.accountId ?? "local-owner"; if (review.created_by === actor) throw new HttpError(403, "SELF_APPROVAL", "다른 검토자가 승인해야 합니다."); const status = text(input.status, "검토 결정", 30); if (!["approved", "changes_requested"].includes(status)) throw new HttpError(400, "REVIEW_STATUS", "검토 결정을 확인하세요."); db.prepare("UPDATE platform_reviews SET status=?,decided_by=?,decided_at=? WHERE id=?").run(status, actor, now(), String(review.id)); audit(db, "review.decision", String(review.id), status); send({ status }); }
    return true;
  }
  if (route === "connections" && method === "GET") { manage(); send(connectionInfo(db, project)); return true; }
  if (route === "connections" && method === "PUT") { manage(); send(saveConnection(db, project, input)); return true; }
  const connectionRoute = route.match(/^connections\/([^/]+)\/(test|pause|data)$/);
  if (connectionRoute) {
    const connection = getConnection(db, connectionRoute[1]!); if (connection.projectId !== project) throw new HttpError(404, "CONNECTION", "이 사이트의 연결이 아닙니다."); manage();
    if (connectionRoute[2] === "test" && method === "POST") { send(await testConnection(db, connection.id)); return true; }
    if (connectionRoute[2] === "pause" && method === "POST") { if (typeof input.paused !== "boolean") throw new HttpError(400, "PAUSED", "일시 중지 상태를 확인하세요."); db.prepare("UPDATE platform_connections SET paused=? WHERE id=?").run(input.paused ? 1 : 0, connection.id); audit(db, "connection.pause", connection.id); send({ paused: input.paused }); return true; }
    if (connectionRoute[2] === "data" && method === "GET") { send(await externalData(db, connection.id, url.searchParams.get("refresh") === "true")); return true; }
  }
  if (route === "outbox" && method === "GET") { manage(); send(outboxInfo(db, project)); return true; }
  if (route === "outbox" && method === "POST") { manage(); send({ id: enqueue(db, project, text(input.connectionId, "연결 ID", 100), text(input.eventKey, "이벤트 키", 200), input.payload) }, 201); return true; }
  if (route === "outbox/process" && method === "POST") { manage(); send({ processed: await processOutbox(db) }); return true; }
  const retry = route.match(/^outbox\/([^/]+)\/retry$/);
  if (retry && method === "POST") { manage(); retryOutbox(db, project, retry[1]!); send({ retried: true }); return true; }
  if (route === "catalog" && method === "GET") { send(catalog(db, project, identity.localOwner || ["owner", "operator"].includes(role(db, identity, project) ?? ""))); return true; }
  if (route === "catalog" && method === "PUT") { manage(); send(saveProduct(db, project, input)); return true; }
  if (route === "orders" && method === "GET") { const admin = identity.localOwner || ["owner", "operator"].includes(role(db, identity, project) ?? ""); send(orders(db, project, admin ? undefined : requireAccount(identity))); return true; }
  if (route === "orders" && method === "POST") { send(createOrder(db, project, requireAccount(identity), input), 201); return true; }
  const orderRoute = route.match(/^orders\/([^/]+)\/(cancel|checkout|refund|reconcile)$/);
  if (orderRoute && method === "POST") { own("platform_orders", orderRoute[1]!); if (orderRoute[2] === "cancel") { cancelOrder(db, orderRoute[1]!); send({ cancelled: true }); } else if (orderRoute[2] === "checkout") send(await checkout(db, orderRoute[1]!, text(input.connectionId, "결제 연결 ID", 100), undefined, context.assertWritable)); else { manage(); send(orderRoute[2] === "refund" ? await refundOrder(db, orderRoute[1]!, input, undefined, context.assertWritable) : await reconcileOrder(db, orderRoute[1]!, undefined, context.assertWritable)); } return true; }
  if (route === "booking/resources" && method === "GET") { send(many(db, "SELECT id,name,capacity,active FROM platform_resources WHERE project_id=? ORDER BY name LIMIT 500", project)); return true; }
  if (route === "booking/resources" && method === "PUT") { manage(); send(saveResource(db, project, input)); return true; }
  if (route === "booking/slots" && method === "GET") { send(slots(db, project)); return true; }
  if (route === "booking/slots" && method === "POST") { manage(); send(saveSlot(db, project, input), 201); return true; }
  if (route === "bookings" && method === "GET") { const admin = identity.localOwner || ["owner", "operator"].includes(role(db, identity, project) ?? ""); send(many(db, `SELECT b.id,b.slot_id AS slotId,b.account_id AS accountId,b.quantity,b.status,b.created_at AS createdAt,s.starts_at AS startsAt,s.ends_at AS endsAt,r.name FROM platform_bookings b JOIN platform_slots s ON s.id=b.slot_id JOIN platform_resources r ON r.id=s.resource_id WHERE b.project_id=?${admin ? "" : " AND b.account_id=?"} ORDER BY b.created_at DESC LIMIT 100`, ...admin ? [project] : [project, requireAccount(identity)])); return true; }
  if (route === "bookings" && method === "POST") { send(createBooking(db, project, requireAccount(identity), input), 201); return true; }
  const expandedBooking = new BookingExpansion(db);
  if (route === "bookings/waitlist" && method === "GET") { send(expandedBooking.waitlist(project, requireAccount(identity))); return true; }
  if (route === "bookings/waitlist" && method === "POST") { send(expandedBooking.join(project, requireAccount(identity), input), 201); return true; }
  const waitlist = route.match(/^bookings\/waitlist\/([^/]+)\/(accept|cancel)$/);
  if (waitlist && method === "POST") { const accountId = requireAccount(identity); if (waitlist[2] === "accept") send(expandedBooking.accept(project, accountId, waitlist[1]!)); else { expandedBooking.cancel(project, accountId, waitlist[1]!); send({ cancelled: true }); } return true; }
  const bookingRoute = route.match(/^bookings\/([^/]+)\/cancel$/);
  if (bookingRoute && method === "POST") { own("platform_bookings", bookingRoute[1]!); cancelBooking(db, bookingRoute[1]!); send({ cancelled: true }); return true; }
  if (["billing/connection", "billing/subscription"].includes(route) && method === "GET") { authorize(db, identity, project, []); send(publicBillingState(db, project)); return true; }
  if (route === "billing/connection" && method === "PUT") { authorize(db, identity, project, []); configureBilling(db, project, input); send(publicBillingState(db, project)); return true; }
  if (route === "billing/subscription" && method === "POST") { authorize(db, identity, project, []); send(await billingAction(db, project, input, undefined, context.assertWritable)); return true; }
  if (route === "billing/invoices" && method === "GET") { authorize(db, identity, project, []); send(publicBillingState(db, project).invoices); return true; }
  if (route === "billing" && method === "GET") { manage(); const row = one(db, "SELECT * FROM platform_billing WHERE project_id=?", project), subscription = publicBillingState(db, project); send({ plan: row?.plan ?? "local", limits: row ? JSON.parse(String(row.limits)) as unknown : {}, paymentSubscription: subscription.subscription?.status ?? (subscription.connection ? "configured" : "not-configured"), remoteBillingVerified: subscription.remoteBillingVerified }); return true; }
  if (route === "billing" && method === "PUT") { authorize(db, identity, project, []); const limits = record(input.limits); if (Object.keys(limits).some((key) => !["orders", "bookings", "generations", "submissions", "storageBytes"].includes(key))) throw new HttpError(400, "LIMIT", "지원하지 않는 사용량 항목입니다."); for (const [key, value] of Object.entries(limits)) integer(value, key, 0, Number.MAX_SAFE_INTEGER); db.prepare("INSERT INTO platform_billing VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET plan=excluded.plan,limits=excluded.limits,updated_at=excluded.updated_at").run(project, text(input.plan, "로컬 플랜 이름", 80), JSON.stringify(limits), now()); audit(db, "billing.configure", project); send({ configured: true, remoteBillingVerified: false }); return true; }
  if (route === "usage" && method === "GET") { manage(); send({ period: period(), metrics: many(db, "SELECT metric,value FROM platform_usage WHERE project_id=? AND period=?", project, period()) }); return true; }
  throw new HttpError(404, "PLATFORM_ROUTE", "플랫폼 기능 경로를 찾을 수 없습니다.");
}
