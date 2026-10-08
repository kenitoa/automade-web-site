import type { DatabaseSync } from "node:sqlite";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { record } from "../../src/domain/validation";
import { HttpError } from "../http";
import { audit, boolean, consumeUsage, hash, integer, many, now, one, text, transaction, type SqlRow } from "./common";
import { configuredHosts, connectionSecret, getConnection, providerRequest, type Transport } from "./connections";
import { holiday, offered } from "../expansion/bookings";
import { recordPlatformEvent } from "./events";
import { recordFinancialEntry } from "../advancement/ledger";
import { assertRuntimeFeature } from "../advancement/config";
import { applyVerifiedRetainedCommands, assertFinancialReady, assertPaymentWatermark, confirmReconciledOrder, retainedPayment } from "../expansion/reconciliation";
export function saveProduct(db: DatabaseSync, project: string, value: Record<string, unknown>): SqlRow {
  const id = value.id ? text(value.id, "상품 ID", 100) : randomUUID();
  const previous = one(db, "SELECT project_id,updated_at FROM platform_products WHERE id=?", id);
  if (previous && previous.project_id !== project) throw new HttpError(403, "OWNERSHIP", "다른 사이트의 상품입니다.");
  if (previous && value.expectedUpdatedAt !== previous.updated_at) throw new HttpError(409, "PRODUCT_VERSION", "상품을 새로 조회한 뒤 수정하세요.");
  const currency = text(value.currency, "통화", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "CURRENCY", "통화 코드를 확인하세요.");
  db.prepare("INSERT INTO platform_products VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,price_minor=excluded.price_minor,currency=excluded.currency,inventory=excluded.inventory,active=excluded.active,updated_at=excluded.updated_at").run(id, project, text(value.name, "상품명", 200), integer(value.priceMinor, "최소 통화 단위 가격"), currency, integer(value.inventory, "재고", 0, 1_000_000), boolean(value.active, "판매 상태", true) ? 1 : 0, now());
  audit(db, "product.save", id); return one(db, "SELECT * FROM platform_products WHERE id=?", id)!;
}
export function catalog(db: DatabaseSync, project: string, admin = false): SqlRow[] { return many(db, `SELECT id,name,price_minor AS priceMinor,currency,inventory,active,updated_at AS updatedAt FROM platform_products WHERE project_id=?${admin ? "" : " AND active=1"} ORDER BY name LIMIT 500`, project); }
interface CartItem { productId: string; quantity: number; }
function cart(value: unknown): CartItem[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new HttpError(400, "CART", "1개 이상 50개 이하 상품을 선택하세요.");
  const result = value.map((item: unknown) => { const row = record(item); return { productId: text(row.productId, "상품 ID", 100), quantity: integer(row.quantity, "수량", 1, 100) }; }).sort((a, b) => a.productId.localeCompare(b.productId));
  if (new Set(result.map((item) => item.productId)).size !== result.length) throw new HttpError(400, "CART", "같은 상품은 하나의 항목으로 합쳐주세요.");
  return result;
}
export function createOrder(db: DatabaseSync, project: string, account: string, input: Record<string, unknown>): SqlRow {
  const items = cart(input.items), key = text(input.idempotencyKey, "요청 키", 100), fingerprint = hash(JSON.stringify(items));
  return transaction(db, () => {
    const existing = one(db, "SELECT * FROM platform_orders WHERE project_id=? AND account_id=? AND idempotency_key=?", project, account, key);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new HttpError(409, "IDEMPOTENCY", "같은 주문 요청 키의 내용이 다릅니다."); return existing; }
    let amount = 0, currency = "";
    const snapshots = items.map((item) => {
      const product = one(db, "SELECT * FROM platform_products WHERE id=? AND project_id=? AND active=1", item.productId, project);
      if (!product || Number(product.inventory) < item.quantity) throw new HttpError(409, "INVENTORY", "선택한 상품이 없거나 재고가 부족합니다.");
      if (currency && currency !== product.currency) throw new HttpError(400, "CURRENCY", "한 주문은 같은 통화의 상품만 담을 수 있습니다.");
      currency = String(product.currency); amount += Number(product.price_minor) * item.quantity;
      if (!Number.isSafeInteger(amount) || amount > 1_000_000_000_000) throw new HttpError(400, "AMOUNT", "주문 금액 한도를 초과합니다.");
      db.prepare("UPDATE platform_products SET inventory=inventory-?,updated_at=? WHERE id=?").run(item.quantity, now(), item.productId);
      return { ...item, name: product.name, priceMinor: product.price_minor };
    });
    consumeUsage(db, project, "orders");
    const id = randomUUID(), time = now();
    db.prepare("INSERT INTO platform_orders(id,project_id,account_id,idempotency_key,fingerprint,items,amount_minor,currency,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)").run(id, project, account, key, fingerprint, JSON.stringify(snapshots), amount, currency, time, time);
    recordFinancialEntry(db,{realm:'orders',projectId:project,targetId:id,key:'order:'+id,kind:'order_created',amountMinor:amount,currency});
    audit(db, "order.create", id); return one(db, "SELECT * FROM platform_orders WHERE id=?", id)!;
  });
}
export function orders(db: DatabaseSync, project: string, account?: string): SqlRow[] { return many(db, `SELECT id,account_id AS accountId,items,amount_minor AS amountMinor,currency,status,refunded_minor AS refundedMinor,created_at AS createdAt,updated_at AS updatedAt FROM platform_orders WHERE project_id=?${account ? " AND account_id=?" : ""} ORDER BY created_at DESC LIMIT 100`, ...account ? [project, account] : [project]).map((row) => ({ ...row, items: JSON.parse(String(row.items)) as unknown })); }
function order(db: DatabaseSync, id: string, project?: string): SqlRow {
  const result = one(db, "SELECT * FROM platform_orders WHERE id=?", id);
  if (!result || (project && result.project_id !== project)) throw new HttpError(404, "ORDER", "주문을 찾을 수 없습니다.");
  return result;
}
export function cancelOrder(db: DatabaseSync, id: string): void {
  transaction(db, () => {
    const current = order(db, id);
    if (current.status === "cancelled") return;
    if (current.status !== "pending" || current.provider_id) throw new HttpError(409, "ORDER_STATUS", "결제 진행·완료 주문은 공급자 확인 또는 환불이 필요합니다.");
    const items: unknown = JSON.parse(String(current.items));
    for (const item of cart(items)) db.prepare("UPDATE platform_products SET inventory=inventory+?,updated_at=? WHERE id=? AND project_id=?").run(item.quantity, now(), item.productId, String(current.project_id));
    db.prepare("UPDATE platform_orders SET status='cancelled',updated_at=? WHERE id=?").run(now(), id); audit(db, "order.cancel", id);
  });
}
export async function checkout(db: DatabaseSync, id: string, providerId: string, transport: Transport = providerRequest, assertWritable?: () => void): Promise<SqlRow> {
  assertRuntimeFeature(db,'paid-actions');
  assertFinancialReady(db, id);
  const current = order(db, id), connection = getConnection(db, providerId);
  if (connection.projectId !== current.project_id || connection.kind !== "payment") throw new HttpError(400, "PAYMENT_PROVIDER", "이 사이트의 결제 연결을 선택하세요.");
  if (!connectionSecret(connection, connection.secretRef) || !connectionSecret(connection, connection.webhookSecretRef)) throw new HttpError(503, "PROVIDER_UNCONFIGURED", "결제 공급자 환경 변수를 설정하세요.");
  if (!["pending", "checkout_pending"].includes(String(current.status)) || (current.provider_id && current.provider_id !== providerId)) throw new HttpError(409, "ORDER_STATUS", "현재 주문은 결제를 시작할 수 없습니다.");
  db.prepare("UPDATE platform_orders SET provider_id=?,status='checkout_pending',updated_at=? WHERE id=?").run(providerId, now(), id);
  const response = record(await transport(connection, "POST", { operation: "checkout", orderId: id, amountMinor: current.amount_minor, currency: current.currency, items: JSON.parse(String(current.items)) as unknown }, `checkout:${id}`));
  assertWritable?.();
  const redirect = new URL(text(response.checkoutUrl, "결제 주소", 2000));
  if (redirect.protocol !== "https:" || redirect.username || redirect.password || (redirect.port && redirect.port !== "443") || !configuredHosts().includes(redirect.hostname)) throw new HttpError(502, "CHECKOUT_URL", "결제 주소가 허용된 HTTPS 호스트가 아닙니다.");
  const paymentId = text(response.paymentId, "거래 ID", 200);
  const latest = order(db, id);
  if (latest.provider_payment_id && latest.provider_payment_id !== paymentId) throw new HttpError(409, "PAYMENT_ID", "결제 공급자가 다른 거래를 반환했습니다. 상태 대사를 실행하세요.");
  db.prepare("UPDATE platform_orders SET provider_payment_id=?,updated_at=? WHERE id=?").run(paymentId, now(), id); audit(db, "payment.checkout", id);
  return { orderId: id, checkoutUrl: redirect.href, status: latest.status, verifiedPaid: ["paid", "partially_refunded", "refunded"].includes(String(latest.status)) };
}
export function verifyWebhook(secret: string, timestamp: string, raw: string, signature: string): void {
  if (!/^\d{10,13}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) throw new HttpError(401, "WEBHOOK_SIGNATURE", "웹훅 인증에 실패했습니다.");
  const millis = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
  if (Math.abs(Date.now() - millis) > 300_000) throw new HttpError(401, "WEBHOOK_TIMESTAMP", "웹훅 인증 시간이 만료되었습니다.");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw new HttpError(401, "WEBHOOK_SIGNATURE", "웹훅 인증에 실패했습니다.");
}
export function applyPaymentEvent(db: DatabaseSync, providerId: string, input: Record<string, unknown>): SqlRow {
  const eventId = text(input.eventId, "이벤트 ID", 200), id = text(input.orderId, "주문 ID", 100), sequence = integer(input.sequence, "공급자 이벤트 순서", 0, Number.MAX_SAFE_INTEGER);
  const fingerprint = hash(JSON.stringify(input));
  assertPaymentWatermark(db, id, providerId, text(input.paymentId, "거래 ID", 200), sequence);
  return transaction(db, () => {
    const old = one(db, "SELECT * FROM platform_payment_events WHERE provider_id=? AND event_id=?", providerId, eventId);
    if (old) { if (old.body_hash !== fingerprint) throw new HttpError(409, "WEBHOOK_DUPLICATE", "같은 이벤트 ID의 내용이 다릅니다."); return { duplicate: true, applied: old.status === "applied" }; }
    const current = order(db, id), connection = getConnection(db, providerId);
    if (current.project_id !== connection.projectId || current.provider_id !== providerId || input.amountMinor !== current.amount_minor || input.currency !== current.currency || (current.provider_payment_id && input.paymentId !== current.provider_payment_id)) throw new HttpError(409, "PAYMENT_MISMATCH", "공급자 거래와 서버 주문이 일치하지 않습니다.");
    const status = text(input.status, "결제 상태", 30);
    if (!["paid", "partially_refunded", "refunded", "cancelled", "failed"].includes(status)) throw new HttpError(400, "PAYMENT_STATUS", "지원하지 않는 결제 상태입니다.");
    const refunded = integer(input.refundedMinor ?? 0, "누적 환불 금액", 0, Number(current.amount_minor));
    if ((status === "paid" && refunded !== 0) || (status === "partially_refunded" && (refunded <= 0 || refunded >= Number(current.amount_minor))) || (status === "refunded" && refunded !== Number(current.amount_minor))) throw new HttpError(400, "REFUND_AMOUNT", "환불 상태와 누적 금액이 일치하지 않습니다.");
    const stale = sequence <= Number(current.provider_sequence);
    if (!stale) {
      if (["paid", "partially_refunded", "refunded"].includes(String(current.status)) && ["failed", "cancelled"].includes(status)) throw new HttpError(409, "PAYMENT_TRANSITION", "결제 완료 후 취소·실패로 변경할 수 없습니다. 환불 이벤트가 필요합니다.");
      if (refunded < Number(current.refunded_minor)) throw new HttpError(409, "PAYMENT_TRANSITION", "누적 환불 금액이 감소할 수 없습니다.");
      if (["failed", "cancelled"].includes(String(current.status)) && ["paid", "partially_refunded", "refunded"].includes(status)) throw new HttpError(409, "PAYMENT_TRANSITION", "종료한 거래의 결제 완료는 수동 대사가 필요합니다.");
      const releaseInventory = ["cancelled", "failed"].includes(status) && !["cancelled", "failed"].includes(String(current.status));
      if (releaseInventory) for (const item of cart(JSON.parse(String(current.items)) as unknown)) db.prepare("UPDATE platform_products SET inventory=inventory+?,updated_at=? WHERE id=? AND project_id=?").run(item.quantity, now(), item.productId, String(current.project_id));
      db.prepare("UPDATE platform_orders SET status=?,refunded_minor=?,provider_payment_id=?,provider_sequence=?,updated_at=? WHERE id=?").run(status, refunded, text(input.paymentId, "거래 ID", 200), sequence, now(), id);
      if(['paid','partially_refunded','refunded'].includes(status)&&!['paid','partially_refunded','refunded'].includes(String(current.status)))recordFinancialEntry(db,{realm:'orders',projectId:String(current.project_id),targetId:id,key:'payment:'+providerId+':'+eventId,kind:'payment_confirmed',amountMinor:Number(current.amount_minor),currency:String(current.currency),eventId});
      if(refunded>Number(current.refunded_minor))recordFinancialEntry(db,{realm:'orders',projectId:String(current.project_id),targetId:id,key:'refund:'+providerId+':'+eventId,kind:'refund_confirmed',amountMinor:refunded-Number(current.refunded_minor),currency:String(current.currency),eventId});
      if (status === "paid") recordPlatformEvent(db, String(current.project_id), "order.paid", id, { id, orderId: id, amountMinor: current.amount_minor, currency: current.currency });
    }
    db.prepare("INSERT INTO platform_payment_events VALUES(?,?,?,?,?,?,?)").run(providerId, eventId, id, sequence, fingerprint, stale ? "ignored_stale" : "applied", now());
    if (!stale && ["partially_refunded", "refunded"].includes(status)) db.prepare("UPDATE platform_payment_commands SET status='verified' WHERE order_id=? AND command='refund' AND status IN('pending','requested')").run(id);
    audit(db, "payment.event", id, stale ? "ignored_stale" : "success");
    return { duplicate: false, applied: !stale, status: stale ? current.status : status };
  });
}
export async function refundOrder(db: DatabaseSync, id: string, input: Record<string, unknown>, transport: Transport = providerRequest, assertWritable?: () => void): Promise<SqlRow> {
  assertFinancialReady(db, id);
  const amount = integer(input.amountMinor, "환불 금액", 1), key = text(input.idempotencyKey, "환불 요청 키", 100);
  const current = order(db, id), providerId = String(current.provider_id ?? ""), connection = getConnection(db, providerId);
  const commandId = transaction(db, () => {
    const fingerprint = hash(JSON.stringify({ amount })), existing = one(db, "SELECT * FROM platform_payment_commands WHERE order_id=? AND idempotency_key=?", id, key);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new HttpError(409, "IDEMPOTENCY", "환불 요청 키의 금액이 다릅니다."); return String(existing.id); }
    if (!["paid", "partially_refunded"].includes(String(current.status)) || amount + Number(current.refunded_minor) > Number(current.amount_minor)) throw new HttpError(409, "REFUND", "현재 상태 또는 환불 가능 금액을 확인하세요.");
    const pending = Number(one(db, "SELECT COALESCE(SUM(amount_minor),0) AS amount FROM platform_payment_commands WHERE order_id=? AND command='refund' AND status IN('pending','requested')", id)?.amount ?? 0);
    if (pending) throw new HttpError(409, "REFUND_PENDING", "이전 환불 결과를 공급자 상태 대사로 확인한 뒤 요청하세요.");
    const command = randomUUID(); db.prepare("INSERT INTO platform_payment_commands VALUES(?,?,'refund',?,?,?,'pending',?)").run(command, id, amount, key, fingerprint, now()); return command;
  });
  await transport(connection, "POST", { operation: "refund", orderId: id, paymentId: current.provider_payment_id, amountMinor: amount }, commandId);
  assertWritable?.();
  db.prepare("UPDATE platform_payment_commands SET status='requested' WHERE id=? AND status='pending'").run(commandId); audit(db, "payment.refund.request", id);
  return { commandId, status: String(one(db, "SELECT status FROM platform_payment_commands WHERE id=?", commandId)?.status), message: "환불 요청을 전달했습니다. 공급자 웹훅 또는 상태 대사 후 완료로 기록됩니다." };
}
export async function reconcileOrder(db: DatabaseSync, id: string, transport: Transport = providerRequest, assertWritable?: () => void): Promise<SqlRow> {
  const current = order(db, id), retained = retainedPayment(db, id), providerId = String(current.provider_id ?? retained?.provider_id ?? ""), connection = getConnection(db, providerId), paymentId = current.provider_payment_id ?? retained?.provider_payment_id;
  const result = record(await transport(connection, "POST", { operation: "status", orderId: id, paymentId }, `status:${id}:${randomUUID()}`));
  assertWritable?.();
  if (result.orderId !== id) throw new HttpError(502, "PAYMENT_MISMATCH", "상태 대사 주문 ID가 일치하지 않습니다.");
  if (!current.provider_id) {
    if (!retained || result.amountMinor !== current.amount_minor || result.currency !== current.currency || result.paymentId !== retained.provider_payment_id || connection.projectId !== current.project_id) throw new HttpError(409, "RESTORE_PAYMENT_MISMATCH", "이전 거래 원장과 공급자 상태가 일치하지 않습니다.");
    assertPaymentWatermark(db, id, providerId, String(result.paymentId), integer(result.sequence, "공급자 순서", 0, Number.MAX_SAFE_INTEGER));
    db.prepare("UPDATE platform_orders SET provider_id=?,provider_payment_id=? WHERE id=? AND provider_id IS NULL").run(providerId, String(result.paymentId), id);
  }
  const applied = applyPaymentEvent(db, providerId, result);
  applyVerifiedRetainedCommands(db, id, result);
  if (applied.applied || applied.duplicate) confirmReconciledOrder(db, id);
  audit(db, "payment.reconcile", id); return applied;
}
export function saveResource(db: DatabaseSync, project: string, input: Record<string, unknown>,reviewed=false): SqlRow {
  const id = input.id ? text(input.id, "자원 ID", 100) : randomUUID(), old = one(db, "SELECT project_id,capacity,active FROM platform_resources WHERE id=?", id);
  if (old && old.project_id !== project) throw new HttpError(403, "OWNERSHIP", "다른 사이트의 예약 자원입니다.");
  if(old&&!reviewed&&(Number(old.capacity)!==integer(input.capacity,'정원',1,10000)||Boolean(old.active)!==boolean(input.active,'예약 자원 상태',true))&&one(db,'SELECT 1 FROM platform_slots WHERE resource_id=? AND starts_at>?',id,now()))throw new HttpError(409,'BOOKING_REVIEW_REQUIRED','생성된 일정의 정원·사용 상태 변경은 예약·대기 영향 검토가 필요합니다.');
  db.prepare("INSERT INTO platform_resources VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,capacity=excluded.capacity,active=excluded.active").run(id, project, text(input.name, "예약 자원명", 100), integer(input.capacity, "정원", 1, 10000), boolean(input.active, "예약 자원 상태", true) ? 1 : 0); audit(db, "resource.save", id); return one(db, "SELECT * FROM platform_resources WHERE id=?", id)!;
}
export function saveSlot(db: DatabaseSync, project: string, input: Record<string, unknown>): SqlRow {
  const resourceId = text(input.resourceId, "자원 ID", 100), resource = one(db, "SELECT * FROM platform_resources WHERE id=? AND project_id=? AND active=1", resourceId, project);
  if (!resource) throw new HttpError(404, "RESOURCE", "예약 자원을 확인하세요.");
  const start = text(input.startsAt, "시작 UTC 시각", 30), end = text(input.endsAt, "종료 UTC 시각", 30);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(start) || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(end) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end) || Date.parse(start) <= Date.now()) throw new HttpError(400, "SLOT_TIME", "현재 이후의 올바른 UTC 시작·종료 시각이 필요합니다.");
  const capacity = integer(input.capacity ?? resource.capacity, "정원", 1, Number(resource.capacity)), startsAt = new Date(start).toISOString(), endsAt = new Date(end).toISOString();
  return transaction(db, () => {
    if (one(db, "SELECT id FROM platform_slots WHERE resource_id=? AND starts_at<? AND ends_at>?", resourceId, endsAt, startsAt)) throw new HttpError(409, "SLOT_OVERLAP", "동일 자원에 겹치는 예약 시간이 있습니다.");
    const id = randomUUID(); db.prepare("INSERT INTO platform_slots VALUES(?,?,?,?,?)").run(id, resourceId, startsAt, endsAt, capacity); audit(db, "slot.create", id); return one(db, "SELECT * FROM platform_slots WHERE id=?", id)!;
  });
}
export function slots(db: DatabaseSync, project: string): SqlRow[] { return many(db, "SELECT s.id,s.resource_id AS resourceId,r.name,s.starts_at AS startsAt,s.ends_at AS endsAt,s.capacity,COALESCE(SUM(CASE WHEN b.status='confirmed' THEN b.quantity ELSE 0 END),0) AS reserved FROM platform_slots s JOIN platform_resources r ON r.id=s.resource_id LEFT JOIN platform_bookings b ON b.slot_id=s.id WHERE r.project_id=? AND r.active=1 AND s.starts_at>? GROUP BY s.id ORDER BY s.starts_at LIMIT 500", project, now()).filter(row => !holiday(db, project, String(row.resourceId), String(row.startsAt))).map((row) => ({ ...row, available: Math.max(0, Number(row.capacity) - Number(row.reserved) - offered(db, String(row.id))) })); }
export function createBooking(db: DatabaseSync, project: string, account: string, input: Record<string, unknown>): SqlRow {
  const slotId = text(input.slotId, "시간 ID", 100), quantity = integer(input.quantity ?? 1, "인원", 1, 10000), key = text(input.idempotencyKey, "요청 키", 100), fingerprint = hash(JSON.stringify({ slotId, quantity }));
  return transaction(db, () => {
    const old = one(db, "SELECT * FROM platform_bookings WHERE project_id=? AND account_id=? AND idempotency_key=?", project, account, key);
    if (old) { if (old.fingerprint !== fingerprint) throw new HttpError(409, "IDEMPOTENCY", "동일 예약 키의 내용이 다릅니다."); return old; }
    const slot = one(db, "SELECT s.* FROM platform_slots s JOIN platform_resources r ON r.id=s.resource_id WHERE s.id=? AND r.project_id=? AND r.active=1 AND s.starts_at>?", slotId, project, now());
    if (!slot) throw new HttpError(404, "SLOT", "예약 가능한 시간을 확인하세요.");
    if (holiday(db, project, String(slot.resource_id), String(slot.starts_at))) throw new HttpError(409, "BOOKING_HOLIDAY", "휴일에는 예약할 수 없습니다.");
    const used = Number(one(db, "SELECT COALESCE(SUM(quantity),0) AS n FROM platform_bookings WHERE slot_id=? AND status='confirmed'", slotId)?.n ?? 0) + offered(db, slotId);
    if (used + quantity > Number(slot.capacity)) throw new HttpError(409, "BOOKING_FULL", "예약 정원이 부족합니다.");
    consumeUsage(db, project, "bookings"); const id = randomUUID();
    db.prepare("INSERT INTO platform_bookings VALUES(?,?,?,?,?,'confirmed',?,?,?)").run(id, project, slotId, account, quantity, key, fingerprint, now()); recordPlatformEvent(db, project, "booking.created", id, { id, bookingId: id, slotId, quantity }); audit(db, "booking.create", id); return one(db, "SELECT * FROM platform_bookings WHERE id=?", id)!;
  });
}
export function cancelBooking(db: DatabaseSync, id: string): void { db.prepare("UPDATE platform_bookings SET status='cancelled' WHERE id=?").run(id); audit(db, "booking.cancel", id); }
