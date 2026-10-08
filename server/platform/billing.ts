import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HttpError } from "../http";
import { record } from "../../src/domain/validation";
import { recordFinancialEntry } from "../advancement/ledger";
import { assertRuntimeFeature } from "../advancement/config";
import { audit, hash, integer, now, one, text, transaction } from "./common";
import { configuredHosts, connectionSecret, getConnection, providerRequest, type Transport } from "./connections";
import type { BillingConnection, PlatformSubscription, PlatformInvoice, PublicPlatformBilling } from "../../src/domain/billing";
export type { BillingConnection, PlatformSubscription, PlatformInvoice } from "../../src/domain/billing";
interface BillingCommand { id: string; key: string; fingerprint: string; action: string; subscriptionId: string; status: "pending" | "requested" | "unknown" | "verified"; createdAt: string }
interface BillingEvent { id: string; fingerprint: string; applied: boolean }
export interface PlatformBillingState { connection: BillingConnection | null; subscription: PlatformSubscription | null; invoices: PlatformInvoice[]; commands: BillingCommand[]; events: BillingEvent[] }
export function billingState(db: DatabaseSync, project: string): PlatformBillingState {
  const stored = one(db, "SELECT value FROM runtime_state WHERE key=?", `platform.billing:${project}`);
  return stored ? JSON.parse(String(stored.value)) as PlatformBillingState : { connection: null, subscription: null, invoices: [], commands: [], events: [] };
}
function persist(db: DatabaseSync, project: string, value: PlatformBillingState): void { db.prepare("INSERT INTO runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`platform.billing:${project}`, JSON.stringify(value)); }
export function configureBilling(db: DatabaseSync, project: string, input: Record<string, unknown>): PlatformBillingState {
  const connectionId = text(input.connectionId, "플랫폼 구독 결제 연결", 100), provider = getConnection(db, connectionId);
  if (provider.projectId !== project || provider.kind !== "payment") throw new HttpError(400, "BILLING_CONNECTION", "이 사이트의 결제 연결을 선택하세요.");
  const currency = text(input.currency, "통화", 3).toUpperCase(); if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "CURRENCY", "통화 코드를 확인하세요.");
  const connection: BillingConnection = { connectionId, planCode: text(input.planCode, "플랫폼 공급자 플랜 코드", 100), priceMinor: integer(input.priceMinor, "구독 최소 단위 금액", 1), currency, periodDays: integer(input.periodDays, "청구 주기 일", 1, 366) };
  const state = billingState(db, project); state.connection = connection; persist(db, project, state); audit(db, "platform.billing.configure", project); return state;
}
export function publicBillingState(db: DatabaseSync, project: string): PublicPlatformBilling {
  const state = billingState(db, project); let configured = false;
  if (state.connection) { const connection = getConnection(db, state.subscription && state.subscription.status !== "cancelled" ? state.subscription.connectionId : state.connection.connectionId); configured = connection.kind === "payment" && !connection.paused && Boolean(connectionSecret(connection, connection.secretRef) && connectionSecret(connection, connection.webhookSecretRef)); }
  const command = [...state.commands].reverse().find((command) => command.subscriptionId === state.subscription?.id && command.status === "unknown");
  return { connection: state.connection, configured, subscription: state.subscription, invoices: state.invoices.slice(-100), remoteBillingVerified: state.subscription?.status === "active" && Boolean(state.subscription.validUntil && Date.parse(state.subscription.validUntil) > Date.now()), pendingAction: command ? { action: command.action as "start" | "cancel" | "reconcile", idempotencyKey: command.key } : null };
}
export function applyBillingEvent(db: DatabaseSync, project: string, connectionId: string, input: Record<string, unknown>): { duplicate: boolean; applied: boolean; status: string } {
  if (input.namespace !== "platform.subscription") throw new HttpError(400, "BILLING_NAMESPACE", "사이트 고객 주문과 플랫폼 구독 이벤트를 구분하세요.");
  const eventId = text(input.eventId, "구독 이벤트 ID", 200), sequence = integer(input.sequence, "구독 이벤트 순서", 0, Number.MAX_SAFE_INTEGER), fingerprint = hash(JSON.stringify(input));
  return transaction(db, () => {
    const state = billingState(db, project), subscription = state.subscription;
    if (!subscription || subscription.id !== input.subscriptionId || subscription.connectionId !== connectionId || input.amountMinor !== subscription.amountMinor || input.currency !== subscription.currency) throw new HttpError(409, "BILLING_MISMATCH", "구독·공급자·금액·통화가 서버 계약과 일치하지 않습니다.");
    const previous = state.events.find((event) => event.id === eventId);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new HttpError(409, "BILLING_DUPLICATE", "같은 구독 이벤트의 내용이 다릅니다."); return { duplicate: true, applied: previous.applied, status: subscription.status }; }
    const status = text(input.status, "구독 상태", 30); if (!["active", "cancelled", "past_due"].includes(status)) throw new HttpError(400, "BILLING_STATUS", "지원하지 않는 공급자 구독 상태입니다.");
    const providerSubscriptionId = text(input.providerSubscriptionId, "공급자 구독 ID", 200);
    if (subscription.providerSubscriptionId && providerSubscriptionId !== subscription.providerSubscriptionId) throw new HttpError(409, "BILLING_MISMATCH", "공급자 구독 ID가 일치하지 않습니다.");
    if (sequence <= subscription.sequence) { state.events.push({ id: eventId, fingerprint, applied: false }); persist(db, project, state); return { duplicate: false, applied: false, status: subscription.status }; }
    if (subscription.status === "cancelled" && status !== "cancelled") throw new HttpError(409, "BILLING_TRANSITION", "종료한 구독을 과거 이벤트로 다시 활성화할 수 없습니다.");
    let invoice: PlatformInvoice | undefined;
    if (input.invoiceStatus !== undefined) {
      const invoiceStatus = text(input.invoiceStatus, "청구서 상태", 30), providerInvoiceId = text(input.providerInvoiceId, "공급자 청구서 ID", 200);
      if (!["paid", "failed", "void", "partially_refunded", "refunded"].includes(invoiceStatus)) throw new HttpError(400, "INVOICE_STATUS", "청구서 상태를 확인하세요.");
      const refunded = integer(input.refundedMinor ?? 0, "청구서 누적 환불", 0, subscription.amountMinor);
      if ((invoiceStatus === "paid" && refunded !== 0) || (invoiceStatus === "partially_refunded" && (refunded <= 0 || refunded >= subscription.amountMinor)) || (invoiceStatus === "refunded" && refunded !== subscription.amountMinor)) throw new HttpError(400, "INVOICE_REFUND", "청구서 환불 금액과 상태를 확인하세요.");
      invoice = state.invoices.find((entry) => entry.providerInvoiceId === providerInvoiceId);
      if (invoice && invoice.subscriptionId !== subscription.id) throw new HttpError(409, "INVOICE_MISMATCH", "다른 구독에서 이미 사용한 공급자 청구서 ID입니다.");
      if (!invoice) invoice = state.invoices.find((entry) => entry.subscriptionId === subscription.id && entry.status === "pending" && !entry.providerInvoiceId);
      if (!invoice) { invoice = { id: randomUUID(), providerInvoiceId, subscriptionId: subscription.id, amountMinor: subscription.amountMinor, currency: subscription.currency, refundedMinor: 0, status: "pending", createdAt: now(), updatedAt: now() }; state.invoices.push(invoice); }
      if (invoice.refundedMinor > refunded || (["paid", "partially_refunded", "refunded"].includes(invoice.status) && ["failed", "void"].includes(invoiceStatus))) throw new HttpError(409, "INVOICE_TRANSITION", "확인한 납부·환불 이력을 되돌릴 수 없습니다.");
      if(['paid','partially_refunded','refunded'].includes(invoiceStatus)&&!['paid','partially_refunded','refunded'].includes(invoice.status))recordFinancialEntry(db,{realm:'subscriptions',projectId:project,targetId:invoice.id,key:'invoice-paid:'+providerInvoiceId,kind:'payment_confirmed',amountMinor:subscription.amountMinor,currency:subscription.currency,eventId});
      if(refunded>invoice.refundedMinor)recordFinancialEntry(db,{realm:'subscriptions',projectId:project,targetId:invoice.id,key:'invoice-refund:'+eventId,kind:'refund_confirmed',amountMinor:refunded-invoice.refundedMinor,currency:subscription.currency,eventId});
      invoice.providerInvoiceId = providerInvoiceId; invoice.status = invoiceStatus as PlatformInvoice["status"]; invoice.refundedMinor = refunded; invoice.updatedAt = now();
    }
    if (status === "active") {
      if (!invoice || (invoice.status !== "paid" && !(subscription.validUntil && ["partially_refunded", "refunded"].includes(invoice.status)))) throw new HttpError(409, "BILLING_PAYMENT_REQUIRED", "확인된 청구서 납부 없이 유료 구독을 활성화할 수 없습니다.");
      const until = text(input.validUntil, "구독 UTC 만료 시각", 40);
      if (!until.endsWith("Z") || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now() || (subscription.validUntil && Date.parse(until) < Date.parse(subscription.validUntil))) throw new HttpError(400, "BILLING_EXPIRY", "미래의 UTC 구독 기간을 확인하세요.");
      subscription.validUntil = new Date(until).toISOString();
    }
    subscription.status = status as PlatformSubscription["status"]; subscription.providerSubscriptionId = providerSubscriptionId; subscription.sequence = sequence; subscription.updatedAt = now();
    for (const command of state.commands) if (command.subscriptionId === subscription.id && command.status !== "verified" && (command.action === "reconcile" || command.action === "start" || (command.action === "cancel" && status === "cancelled"))) command.status = "verified";
    state.events.push({ id: eventId, fingerprint, applied: true }); persist(db, project, state); audit(db, "platform.billing.event", subscription.id); return { duplicate: false, applied: true, status: subscription.status };
  });
}
export async function billingAction(db: DatabaseSync, project: string, input: Record<string, unknown>, transport: Transport = providerRequest, assertWritable?: () => void): Promise<{ subscription: PlatformSubscription; message: string }> {
  const action = text(input.action, "구독 작업", 20), key = text(input.idempotencyKey, "구독 요청 키", 100);
  if (!["start", "cancel", "reconcile"].includes(action)) throw new HttpError(400, "BILLING_ACTION", "구독 작업을 확인하세요.");
  if(action==='start')assertRuntimeFeature(db,'paid-actions');
  const initial = billingState(db, project), configuration = initial.connection;
  if (!configuration) throw new HttpError(503, "BILLING_UNCONFIGURED", "플랫폼 구독 연결을 먼저 설정하세요.");
  const connection = getConnection(db, action === "start" ? configuration.connectionId : initial.subscription?.connectionId ?? configuration.connectionId);
  if (connection.projectId !== project || connection.kind !== "payment" || connection.paused || !connectionSecret(connection, connection.secretRef) || !connectionSecret(connection, connection.webhookSecretRef)) throw new HttpError(503, "BILLING_UNCONFIGURED", "플랫폼 구독 공급자 환경 변수를 준비하세요.");
  const command = transaction(db, () => {
    const state = billingState(db, project), fingerprint = hash(JSON.stringify({ action, ...(action === "start" ? configuration : { subscriptionId: state.subscription?.id }) })), previous = state.commands.find((command) => command.key === key);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new HttpError(409, "IDEMPOTENCY", "같은 구독 요청 키의 내용이 다릅니다."); return previous; }
    if (action === "start") {
      if (state.subscription && state.subscription.status !== "cancelled") throw new HttpError(409, "BILLING_ACTIVE", "진행 중인 구독을 먼저 공급자 상태 대사·해지로 확인하세요.");
      const time = now(); state.subscription = { id: randomUUID(), status: "pending", providerSubscriptionId: null, connectionId: configuration.connectionId, planCode: configuration.planCode, amountMinor: configuration.priceMinor, currency: configuration.currency, periodDays: configuration.periodDays, validUntil: null, checkoutUrl: null, sequence: -1, createdAt: time, updatedAt: time }; state.invoices.push({ id: randomUUID(), providerInvoiceId: null, subscriptionId: state.subscription.id, amountMinor: configuration.priceMinor, currency: configuration.currency, refundedMinor: 0, status: "pending", createdAt: time, updatedAt: time });
    } else if (!state.subscription || state.subscription.status === "cancelled") throw new HttpError(409, "BILLING_STATUS", "진행 중인 구독이 없습니다.");
    const command: BillingCommand = { id: randomUUID(), key, fingerprint, action, subscriptionId: state.subscription!.id, status: "pending", createdAt: now() }; state.commands.push(command); persist(db, project, state); return command;
  });
  let state = billingState(db, project), subscription = state.subscription!;
  if (command.subscriptionId !== subscription.id) throw new HttpError(409, "BILLING_OLD_COMMAND", "이전 구독의 요청 키입니다.");
  if (command.status === "verified") return { subscription, message: "이미 공급자 결과를 확인한 요청입니다." };
  try {
    const response = record(await transport(connection, "POST", { operation: `platform.subscription.${action === "reconcile" ? "status" : action}`, namespace: "platform.subscription", projectId: project, subscriptionId: subscription.id, providerSubscriptionId: subscription.providerSubscriptionId, planCode: subscription.planCode, amountMinor: subscription.amountMinor, currency: subscription.currency, periodDays: subscription.periodDays }, command.id));
    assertWritable?.();
    if (billingState(db, project).subscription?.id !== command.subscriptionId) throw new HttpError(409, "BILLING_OLD_COMMAND", "응답을 기다리는 동안 구독이 교체되었습니다. 최신 구독 상태를 확인하세요.");
    if (action === "reconcile") applyBillingEvent(db, project, subscription.connectionId, response);
    else {
      state = billingState(db, project); subscription = state.subscription!;
      if (response.providerSubscriptionId !== undefined) { const providerId = text(response.providerSubscriptionId, "공급자 구독 ID", 200); if (subscription.providerSubscriptionId && subscription.providerSubscriptionId !== providerId) throw new HttpError(409, "BILLING_MISMATCH", "공급자 구독 ID가 변경되었습니다."); subscription.providerSubscriptionId = providerId; }
      if (response.checkoutUrl !== undefined) { const url = new URL(text(response.checkoutUrl, "구독 결제 주소", 2000)); if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !configuredHosts().includes(url.hostname)) throw new HttpError(502, "BILLING_URL", "허용된 HTTPS 구독 결제 주소가 필요합니다."); subscription.checkoutUrl = url.href; }
      if (action === "cancel" && subscription.status !== "cancelled") subscription.status = "cancel_pending";
      const savedCommand = state.commands.find((saved) => saved.id === command.id)!; if (savedCommand.status !== "verified") savedCommand.status = "requested"; subscription.updatedAt = now(); persist(db, project, state);
    }
    audit(db, `platform.billing.${action}`, subscription.id); return { subscription: billingState(db, project).subscription!, message: action === "reconcile" ? "공급자의 서명 계약과 동일한 서버 상태 응답을 확인했습니다." : "요청을 전달했습니다. 서명된 구독 웹훅 또는 서버 상태 대사 전에는 납부·해지 완료로 표시하지 않습니다." };
  } catch (error) {
    assertWritable?.();
    state = billingState(db, project); const failed = state.commands.find((saved) => saved.id === command.id)!; if (failed.status !== "verified") failed.status = "unknown"; if (action === "start" && state.subscription?.id === command.subscriptionId && state.subscription.status === "pending") state.subscription.status = "unknown"; persist(db, project, state); audit(db, `platform.billing.${action}`, project, "unknown"); throw error;
  }
}
