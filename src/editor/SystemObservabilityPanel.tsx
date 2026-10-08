import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  RuntimeAlertPolicy,
  RuntimeObservabilitySnapshot,
} from "../domain/systemRuntime";
import { record } from "../domain/validation";
import { api } from "../infrastructure/api";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import { useSystemActions } from "./useSystemActions";

const metrics: [RuntimeAlertPolicy["metric"], string][] = [
  ["http-errors", "요청 오류 수"],
  ["queue-unknown", "결과 확인이 필요한 작업 수"],
  ["outbox-blocked", "실패·중단된 전달 이벤트 수"],
  ["latency-ms", "최대 요청 지연 (ms)"],
];
export default function SystemObservabilityPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const a = useSystemActions(s, x),
    [snapshot, setSnapshot] = useState<RuntimeObservabilitySnapshot | null>(
      null,
    ),
    [policies, setPolicies] = useState<RuntimeAlertPolicy[]>([]),
    [canManage, setCanManage] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const key = `${s.project.id}/${x.environmentId}`,
    current = useRef(key),
    sequence = useRef(0);
  current.current = key;
  async function refresh() {
    const scope = key,
      request = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const [raw, alerts, privilege] = await Promise.allSettled([
        api<RuntimeObservabilitySnapshot>(a.endpoint("runtime/observability")),
        api<RuntimeAlertPolicy[]>(a.endpoint("runtime/alerts")),
        api<unknown>(a.endpoint("runtime/worker-policy")),
      ]);
      if (scope !== current.current || request !== sequence.current) return;
      if (raw.status === "rejected") throw raw.reason;
      if (alerts.status === "rejected") throw alerts.reason;
      if (
        !Array.isArray(raw.value.spans) ||
        !Array.isArray(raw.value.metrics) ||
        !Array.isArray(raw.value.incidents) ||
        !Array.isArray(alerts.value)
      )
        throw new Error("운영 추적 응답 형식을 확인하세요.");
      setSnapshot(raw.value);
      setPolicies(alerts.value);
      setCanManage(privilege.status === "fulfilled");
    } catch (e) {
      if (scope === current.current && request === sequence.current)
        setError(
          e instanceof Error ? e.message : "운영 추적을 조회하지 못했습니다.",
        );
    } finally {
      if (scope === current.current && request === sequence.current)
        setBusy(false);
    }
  }
  useEffect(() => {
    setSnapshot(null);
    setPolicies([]);
    setCanManage(false);
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [key]);
  function propose(e: FormEvent<HTMLFormElement>, policy?: RuntimeAlertPolicy) {
    e.preventDefault();
    const form = new FormData(e.currentTarget),
      id = policy?.id || String(form.get("id"));
    a.review({
      label: "선택 환경의 장애 감지 기준 변경",
      path: `runtime/alerts/${encodeURIComponent(id)}`,
      method: "PUT",
      before: policy,
      payload: {
        baseRevision: policy?.revision ?? 0,
        metric: String(form.get("metric")),
        threshold: Number(form.get("threshold")),
        windowMs: Number(form.get("windowMinutes")) * 60000,
        enabled: form.get("enabled") === "on",
      },
      stepUp: true,
      success: refresh,
    });
  }
  return (
    <section
      className="system-observability"
      aria-label="실제 운영 추적·장애 감지"
    >
      <button disabled={busy || !x.scope} onClick={() => void refresh()}>
        {busy ? "운영 추적 조회 중…" : "실제 추적·장애 상태 조회"}
      </button>
      <p>
        선택한 사이트·환경에서 기록한 요청의 지연·오류와 전달·작업 상태입니다.
        입력 원문·비밀값·개인정보를 표시하지 않습니다.
      </p>
      {snapshot && (
        <>
          <p>
            외부 추적 수집기{" "}
            {snapshot.exporter.status === "configured"
              ? "연결 설정 있음 · 실제 전달 성공은 수집기에서 확인"
              : "미연결"}{" "}
            · {snapshot.exporter.protocol}
          </p>
          <h3>최근 1시간 요청 집계</h3>
          {snapshot.metrics.length ? (
            <table>
              <thead>
                <tr>
                  <th>업무</th>
                  <th>상태</th>
                  <th>요청</th>
                  <th>평균 ms</th>
                  <th>최대 ms</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.metrics.map((row) => (
                  <tr key={`${row.operation}/${row.status}`}>
                    <th>{row.operation}</th>
                    <td>{row.status}</td>
                    <td>{row.requests}</td>
                    <td>{row.averageMs}</td>
                    <td>{row.maxMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>이 범위의 최근 요청 집계가 없습니다.</p>
          )}
          <h3>감지한 장애·해결 이력</h3>
          {snapshot.incidents.length ? (
            snapshot.incidents.map((incident) => {
              const body = record(incident.body);
              return (
                <article className="page-card" key={incident.id}>
                  <strong>
                    {incident.kind} ·{" "}
                    {incident.status === "open" ? "확인 필요" : "해결됨"}
                  </strong>
                  <p>
                    {String(body.metric ?? "")} · 실제 값{" "}
                    {String(body.value ?? "—")} / 기준{" "}
                    {String(body.threshold ?? "—")} · 정책 v
                    {String(body.policyRevision ?? "—")}
                  </p>
                  <small>{new Date(incident.updatedAt).toLocaleString()}</small>
                </article>
              );
            })
          ) : (
            <p>감지한 장애가 없습니다. 알림 기준을 설정한 업무만 평가합니다.</p>
          )}
          <details>
            <summary>최근 요청·연결 추적 (최대 100건)</summary>
            {snapshot.spans.length ? (
              snapshot.spans.map((span) => (
                <article className="page-card" key={span.id}>
                  <strong>
                    {span.operation} · {span.status} · {span.durationMs}ms
                  </strong>
                  <small>{new Date(span.startedAt).toLocaleString()}</small>
                  <p>
                    연결 추적 <code>{span.traceId}</code>
                    {span.parentId && (
                      <>
                        {" "}
                        · 상위 <code>{span.parentId}</code>
                      </>
                    )}
                    {span.errorCode && <> · 오류 {span.errorCode}</>}
                  </p>
                </article>
              ))
            ) : (
              <p>이 범위의 추적 기록이 없습니다.</p>
            )}
          </details>
        </>
      )}
      <h3>장애 감지 기준·버전 비교</h3>
      <p>
        플랫폼 관리자·로컬 소유자만 기준을 변경할 수 있습니다. 실제 값이 기준을
        초과하면 이 화면에 장애를 기록하고 정상 범위로 돌아오면 해결 상태로
        바꿉니다. 이메일·외부 알림 전달은 연결하지 않았습니다.
      </p>
      {policies.map((policy) => (
        <article className="page-card" key={policy.id}>
          <strong>
            {policy.id} · v{policy.revision} ·{" "}
            {policy.enabled ? "감지 중" : "감지 중지"}
          </strong>
          <form key={policy.revision} onSubmit={(e) => propose(e, policy)}>
            <AlertFields policy={policy} />
            <button disabled={!canManage || busy}>감지 기준 변경 검토</button>
          </form>
        </article>
      ))}
      {!policies.length && <p>이 환경의 장애 감지 기준이 없습니다.</p>}
      <details>
        <summary>새 감지 기준 등록</summary>
        <form onSubmit={(e) => propose(e)}>
          <label>
            기준 ID
            <input name="id" required maxLength={80} pattern="[A-Za-z0-9_-]+" />
          </label>
          <AlertFields />
          <button disabled={!canManage || busy}>새 감지 기준 검토</button>
        </form>
      </details>
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {a.dialog}
    </section>
  );
}
function AlertFields({ policy }: { policy?: RuntimeAlertPolicy }) {
  return (
    <>
      <label>
        감지 지표
        <select name="metric" defaultValue={policy?.metric ?? "http-errors"}>
          {metrics.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        초과 기준
        <input
          name="threshold"
          type="number"
          min={0}
          max={1000000}
          required
          defaultValue={policy?.threshold ?? 5}
        />
      </label>
      <label>
        측정 구간 (분)
        <input
          name="windowMinutes"
          type="number"
          min={1}
          max={1440}
          required
          defaultValue={(policy?.windowMs ?? 300000) / 60000}
        />
      </label>
      <label className="check">
        <input
          name="enabled"
          type="checkbox"
          defaultChecked={policy ? Boolean(policy.enabled) : true}
        />
        감지 사용
      </label>
    </>
  );
}
