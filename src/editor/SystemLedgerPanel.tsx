import { useEffect, useRef, useState } from "react";
import type { FinancialEntry } from "../domain/advancement";
import type { ExpansionUsage } from "../domain/expansion";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import { useSystemActions } from "./useSystemActions";
export default function SystemLedgerPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const actions = useSystemActions(s, x),
    [realm, setRealm] = useState("orders"),
    [usage, setUsage] = useState<ExpansionUsage | null>(null),
    [entries, setEntries] = useState<FinancialEntry[]>([]),
    [cursor, setCursor] = useState(""),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    scope = `${s.project.id}/${x.environmentId}/${realm}`,
    currentScope = useRef(scope),
    sequence = useRef(0);
  currentScope.current = scope;
  async function refresh(next = "") {
    const key = scope,
      request = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const [usageRaw, ledgerRaw] = await Promise.all([
        api<unknown>(actions.endpoint("usage")),
        api<unknown>(
          actions.endpoint(
            `ledger?realm=${realm}&limit=20${next ? "&before=" + encodeURIComponent(next) : ""}`,
          ),
        ),
      ]);
      if (key !== currentScope.current || request !== sequence.current) return;
      const status = record(usageRaw),
        ledger = record(ledgerRaw);
      if (
        !Array.isArray(status.budgets) ||
        !Array.isArray(status.reservations) ||
        !Array.isArray(ledger.items) ||
        (ledger.nextCursor !== null && typeof ledger.nextCursor !== "string")
      )
        throw new Error("사용량·원장 계약을 확인하세요.");
      setUsage({
        budget: status.budgets,
        reservations: status.reservations,
      } as ExpansionUsage);
      setEntries(ledger.items as FinancialEntry[]);
      setCursor(next);
      setNextCursor(ledger.nextCursor);
    } catch (e) {
      if (key === currentScope.current && request === sequence.current)
        setError(
          e instanceof Error ? e.message : "현재 환경 원장을 확인하세요.",
        );
    } finally {
      if (key === currentScope.current && request === sequence.current)
        setBusy(false);
    }
  }
  useEffect(() => {
    setUsage(null);
    setEntries([]);
    setCursor("");
    setNextCursor(null);
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [scope]);
  return (
    <section className="system-ledger">
      <p>
        추정 예약·확인된 실제 사용량·해제 상태를 구분합니다. 결제 원장은 금액과
        통화를 함께 표시하며, 화면의 성공 표시만으로 입금·환불 완료를 판정하지
        않습니다.
      </p>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        현재 환경의 사용량·원장 재조회
      </button>
      {usage && (
        <>
          <h3>실제 사용량과 예산</h3>
          {usage.budget.map((budget) => (
            <p key={`${budget.metric}/${budget.period}`}>
              {budget.metric} · {budget.period} · 실제 {budget.used} / 예산{" "}
              {budget.limitAmount}
            </p>
          ))}
          {!usage.budget.length && <p>현재 설정된 예산이 없습니다.</p>}
          {usage.reservations.map((reservation) => (
            <article className="page-card" key={reservation.id}>
              <strong>
                {reservation.metric} · {reservation.status}
              </strong>
              <p>
                추정 예약 {reservation.amount} · 실제 정산{" "}
                {reservation.committedAmount} · 만료{" "}
                {new Date(reservation.expiresAt).toLocaleString()}
              </p>
              {reservation.status === "reserved" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const operationId = String(
                      new FormData(e.currentTarget).get("operationId"),
                    );
                    actions.review({
                      label: "서버가 기록한 실제 작업 근거로 사용량 대사",
                      path: "usage/reconcile",
                      method: "POST",
                      payload: { reservationId: reservation.id, operationId },
                      before: {
                        estimated: reservation.amount,
                        metric: reservation.metric,
                        status: reservation.status,
                      },
                      stepUp: true,
                      success: () => refresh(),
                    });
                  }}
                >
                  <label>
                    실제 측정 근거가 있는 작업 ID
                    <input name="operationId" required maxLength={100} />
                  </label>
                  <button disabled={!x.can("billing.manage")}>
                    확인된 사용량 근거 대사 검토
                  </button>
                </form>
              )}
            </article>
          ))}
        </>
      )}
      <label>
        확인할 금액 원장
        <select value={realm} onChange={(e) => setRealm(e.target.value)}>
          <option value="orders">주문·결제·환불</option>
          <option value="subscriptions">정기 거래</option>
        </select>
      </label>
      <table>
        <caption>확인된 금액 내역 · 최소 화폐 단위</caption>
        <thead>
          <tr>
            <th>거래</th>
            <th>종류</th>
            <th>금액</th>
            <th>통화</th>
            <th>기록 시각</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <th>{entry.targetId}</th>
              <td>{entry.kind}</td>
              <td>{entry.amountMinor}</td>
              <td>{entry.currency}</td>
              <td>{new Date(entry.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!entries.length && !busy && !error && (
        <p>이 범위에서 확인된 금액 원장이 없습니다.</p>
      )}
      <div className="button-row">
        <button
          type="button"
          disabled={busy || !cursor}
          onClick={() => void refresh()}
        >
          원장 처음부터
        </button>
        <button
          type="button"
          disabled={busy || !nextCursor}
          onClick={() => void refresh(nextCursor!)}
        >
          다음 원장 20건
        </button>
      </div>
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {actions.dialog}
    </section>
  );
}
