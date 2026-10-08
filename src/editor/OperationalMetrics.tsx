import { useEffect, useState } from "react";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import type { ReleaseSummary, OperationMetric } from "../domain/operations";
export default function OperationalMetrics({
  projectId,
  releases,
}: {
  projectId: string;
  releases: ReleaseSummary[];
}) {
  const [metrics, setMetrics] = useState<OperationMetric[]>([]),
    [at, setAt] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const raw = await api<unknown>(`/api/projects/${projectId}/metrics`);
      if (!Array.isArray(raw))
        throw new Error("측정 응답을 확인하지 못했습니다.");
      const values = raw.map((value) => {
        const item = record(value);
        if (
          typeof item.operation !== "string" ||
          typeof item.status !== "string" ||
          typeof item.count !== "number" ||
          !Number.isSafeInteger(item.count) ||
          item.count < 0 ||
          typeof item.avgDurationMs !== "number" ||
          !Number.isFinite(item.avgDurationMs) ||
          item.avgDurationMs < 0 ||
          typeof item.lastMeasuredAt !== "string" ||
          !Number.isFinite(Date.parse(item.lastMeasuredAt))
        )
          throw new Error("측정 자료의 형식이 올바르지 않습니다.");
        return {
          operation: item.operation,
          status: item.status,
          count: item.count,
          avgDurationMs: item.avgDurationMs,
          lastMeasuredAt: item.lastMeasuredAt,
        };
      });
      setMetrics(values);
      setAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "측정을 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [projectId]);
  const generation = metrics.filter((x) => x.operation === "generation"),
    done = releases.filter((x) =>
      ["ready", "failed", "cancelled"].includes(x.status),
    ),
    total = generation.length
      ? generation.reduce((count, item) => count + item.count, 0)
      : done.length,
    success = generation.length
      ? generation
          .filter((x) => x.status === "success")
          .reduce((count, item) => count + item.count, 0)
      : done.filter((x) => x.status === "ready").length;
  const names: Record<string, string> = {
    generation: "사이트 생성",
    "project.start": "프로젝트 시작",
    "site.first-run": "첫 사이트 실행",
    "site.generate": "사이트 생성",
    "quality.resolve": "생성 오류 해결",
    "preview.mobile": "모바일 미리보기",
    "form.submit": "폼 접수",
    "site.publish": "원격 게시",
    restore: "운영 데이터 복원",
  };
  const latest = metrics.reduce(
    (last, metric) =>
      metric.lastMeasuredAt > last ? metric.lastMeasuredAt : last,
    "",
  );
  return (
    <details className="operational-metrics">
      <summary>실제 운영 지표</summary>
      <p>
        {total
          ? `저장된 완료 작업 생성 성공률 ${Math.round((success / total) * 100)}% (${success}/${total})`
          : "아직 완료된 생성 작업이 없습니다."}
      </p>
      <p className="hint">
        {generation.length
          ? "서버가 기록한 전체 생성 작업의 완료 이벤트를 집계합니다."
          : "생성 이벤트 기록 전 작업은 최근 최대 200개 저장된 작업의 성공·실패·취소를 집계합니다."}{" "}
        진행 중 작업은 제외합니다. 방문자 전환율을 의미하지 않습니다.
      </p>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {busy ? "측정 조회 중…" : "측정 다시 조회"}
      </button>
      {at ? <small>조회 시각 {new Date(at).toLocaleString()}</small> : null}
      {latest ? (
        <p>
          <small>최근 측정 {new Date(latest).toLocaleString()}</small>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="bad">
          {error}
        </p>
      ) : null}
      {!busy && !error && !metrics.length ? (
        <p>수집된 이용 지표가 없습니다.</p>
      ) : null}
      {metrics.map((metric) => (
        <article
          className="page-card"
          key={`${metric.operation}:${metric.status}`}
        >
          <strong>
            {names[metric.operation] || metric.operation} ·{" "}
            {metric.status === "success" ? "성공" : `실패 (${metric.status})`}
          </strong>
          <p>
            {metric.count}회 · 평균 {(metric.avgDurationMs / 1000).toFixed(2)}초
          </p>
        </article>
      ))}
    </details>
  );
}
