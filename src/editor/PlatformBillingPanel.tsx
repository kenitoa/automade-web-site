import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PublicPlatformBilling } from "../domain/billing";
import { api } from "../infrastructure/api";
interface PaymentChoice {
  id: string;
  name: string;
  kind: string;
  configured: boolean;
  paused: boolean;
}
const subscriptionLabels = {
  pending: "납부 확인 대기",
  active: "공급자 납부 확인",
  cancel_pending: "해지 확인 대기",
  cancelled: "해지 확인",
  past_due: "납부 지연",
  unknown: "결과 미확인",
};
const invoiceLabels = {
  pending: "납부 대기",
  paid: "납부 확인",
  failed: "납부 실패",
  void: "청구 취소",
  partially_refunded: "부분 환불 확인",
  refunded: "전액 환불 확인",
};
export default function PlatformBillingPanel({
  projectId,
  onMessage,
}: {
  projectId: string;
  onMessage: (message: string) => void;
}) {
  const [state, setState] = useState<PublicPlatformBilling | null>(null),
    [choices, setChoices] = useState<PaymentChoice[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [review, setReview] = useState<"start" | "cancel" | null>(null);
  const request = useCallback(
    <T,>(
      route: string,
      method = "GET",
      payload?: unknown,
      signal?: AbortSignal,
    ) =>
      api<T>(
        `/api/platform/${route}?projectId=${encodeURIComponent(projectId)}`,
        method,
        payload,
        signal,
      ),
    [projectId],
  );
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const [current, providers] = await Promise.all([
        request<PublicPlatformBilling>(
          "billing/subscription",
          "GET",
          undefined,
          signal,
        ),
        request<PaymentChoice[]>("connections", "GET", undefined, signal),
      ]);
      if (signal?.aborted) return;
      setState(current);
      setChoices(providers.filter((provider) => provider.kind === "payment"));
    },
    [request],
  );
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    setError("");
    setReview(null);
    void refresh(controller.signal).catch((caught: unknown) => {
      if (!controller.signal.aborted)
        setError(
          caught instanceof Error
            ? caught.message
            : "구독 정보를 가져오지 못했습니다.",
        );
    });
    return () => controller.abort();
  }, [refresh]);
  async function run(task: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    try {
      await task();
      await refresh();
      onMessage(message);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "구독 요청을 처리하지 못했습니다.",
      );
      await refresh().catch(() => {
        setError(
          "요청 결과를 확인하지 못했습니다. 새로고침 후 공급자 상태 대사를 실행하세요.",
        );
      });
    } finally {
      setBusy(false);
      setReview(null);
    }
  }
  function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(
      () =>
        request("billing/connection", "PUT", {
          connectionId: form.get("connectionId"),
          planCode: form.get("planCode"),
          priceMinor: Number(form.get("priceMinor")),
          currency: form.get("currency"),
          periodDays: Number(form.get("periodDays")),
        }),
      "플랫폼 구독 연결 계약을 저장했습니다.",
    );
  }
  function action(
    operation: "start" | "cancel" | "reconcile",
    idempotencyKey: string = crypto.randomUUID(),
  ) {
    void run(
      () =>
        request("billing/subscription", "POST", {
          action: operation,
          idempotencyKey,
        }),
      "공급자 요청을 처리했습니다. 표시된 납부·해지 확인 상태를 확인하세요.",
    );
  }
  return (
    <article aria-busy={busy}>
      <h4>플랫폼 사용료 구독 연결</h4>
      <p>
        사이트 고객 주문과 구분된 플랫폼 구독 계약입니다. 공급자의 서버 상태
        또는 서명 웹훅으로 납부·해지를 확인합니다. 로컬 사용량 한도는 별도로
        유지합니다.
      </p>
      {error && <p role="alert">{error}</p>}
      {!state && !error && <p role="status">구독 정보를 불러오는 중입니다.</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(refresh, "구독 상태를 새로고쳤습니다.")}
      >
        구독 새로고침
      </button>
      {choices.length ? (
        <form
          key={JSON.stringify(state?.connection ?? {})}
          onSubmit={configure}
        >
          <label>
            결제 공급자 연결
            <select
              name="connectionId"
              defaultValue={state?.connection?.connectionId ?? choices[0]?.id}
              required
            >
              {choices.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} ·{" "}
                  {provider.configured && !provider.paused
                    ? "환경 준비"
                    : "환경 미설정·중지"}
                </option>
              ))}
            </select>
          </label>
          <label>
            공급자 플랫폼 플랜 코드
            <input
              name="planCode"
              maxLength={100}
              defaultValue={state?.connection?.planCode ?? ""}
              required
            />
          </label>
          <label>
            주기별 금액 · 최소 통화 단위
            <input
              name="priceMinor"
              type="number"
              min={1}
              max={1000000000}
              step={1}
              defaultValue={state?.connection?.priceMinor}
              required
            />
          </label>
          <label>
            통화
            <input
              name="currency"
              maxLength={3}
              pattern="[A-Za-z]{3}"
              defaultValue={state?.connection?.currency ?? "KRW"}
              required
            />
          </label>
          <label>
            청구 주기 · 일
            <input
              name="periodDays"
              type="number"
              min={1}
              max={366}
              step={1}
              defaultValue={state?.connection?.periodDays ?? 30}
              required
            />
          </label>
          <button disabled={busy}>구독 연결 저장</button>
        </form>
      ) : (
        <p>
          외부 연결 탭에서 결제 API 주소와 서버 비밀 환경 변수 이름을 먼저
          등록하세요. 공급자 연결이 없으면 구독을 시작할 수 없습니다.
        </p>
      )}
      {state && (
        <>
          <p>
            {state.configured
              ? "공급자 환경 준비됨"
              : "공급자 연결·비밀 환경 변수 준비 필요"}{" "}
            ·{" "}
            {state.remoteBillingVerified
              ? "유효한 기간의 납부 확인됨"
              : "유효한 유료 구독 미확인"}
          </p>
          {state.subscription ? (
            <p>
              구독: {subscriptionLabels[state.subscription.status]} ·{" "}
              {state.subscription.amountMinor.toLocaleString()}{" "}
              {state.subscription.currency} / {state.subscription.periodDays}일
              {state.subscription.validUntil
                ? ` · 기간 종료 ${new Date(state.subscription.validUntil).toLocaleString()}`
                : ""}
            </p>
          ) : (
            <p>진행 중인 구독이 없습니다.</p>
          )}
          {state.subscription?.checkoutUrl && (
            <a
              href={state.subscription.checkoutUrl}
              target="_blank"
              rel="noreferrer"
            >
              공급자 구독 결제 화면 열기
            </a>
          )}
          <div className="button-row">
            <button
              type="button"
              disabled={
                busy ||
                !state.configured ||
                Boolean(
                  state.subscription &&
                  state.subscription.status !== "cancelled",
                )
              }
              onClick={() => setReview("start")}
            >
              구독 시작 검토
            </button>
            <button
              type="button"
              disabled={
                busy ||
                !state.configured ||
                !state.subscription ||
                state.subscription.status === "cancelled"
              }
              onClick={() => action("reconcile")}
            >
              공급자 상태 대사
            </button>
            <button
              type="button"
              disabled={
                busy ||
                !state.configured ||
                !state.subscription ||
                state.subscription.status === "cancelled"
              }
              onClick={() => setReview("cancel")}
            >
              해지 요청 검토
            </button>
            {state.pendingAction && (
              <button
                type="button"
                disabled={busy || !state.configured}
                onClick={() =>
                  action(
                    state.pendingAction!.action,
                    state.pendingAction!.idempotencyKey,
                  )
                }
              >
                미확인 요청 같은 키로 재시도
              </button>
            )}
          </div>
          {review && (
            <div
              role="dialog"
              aria-modal="false"
              aria-labelledby="billing-confirm-title"
            >
              <h5 id="billing-confirm-title">
                {review === "start" ? "구독 시작" : "구독 해지"} 요청 검토
              </h5>
              <p>
                {review === "start"
                  ? `${state.connection?.priceMinor.toLocaleString()} ${state.connection?.currency} / ${state.connection?.periodDays}일 · ${state.connection?.planCode}`
                  : `구독 ${state.subscription?.id}`}
              </p>
              <p>
                공급자에 실제 요청을 전달합니다. 납부·해지 완료는 별도 공급자
                확인을 기다립니다.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => action(review)}
              >
                공급자에 요청
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setReview(null)}
              >
                닫기
              </button>
            </div>
          )}
          <h5>플랫폼 청구서 · 최근 100건</h5>
          {state.invoices.length ? (
            <ul>
              {[...state.invoices].reverse().map((invoice) => (
                <li key={invoice.id}>
                  {new Date(invoice.createdAt).toLocaleString()} ·{" "}
                  {invoice.amountMinor.toLocaleString()} {invoice.currency} ·{" "}
                  {invoiceLabels[invoice.status]}
                  {invoice.refundedMinor
                    ? ` · 누적 환불 ${invoice.refundedMinor.toLocaleString()}`
                    : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p>청구서가 없습니다.</p>
          )}
        </>
      )}
    </article>
  );
}
