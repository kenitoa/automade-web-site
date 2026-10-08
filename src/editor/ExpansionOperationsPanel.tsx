import { useEffect, useState, type FormEvent } from "react";
import type {
  ExpansionUsage,
  WorkItem,
  ExpansionEnvironment,
} from "../domain/expansion";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import AutomationPanel from "./AutomationPanel";
import ApiSecurityPanel from "./ApiSecurityPanel";
import EditorDialog from "./EditorDialog";
import ChangeReview from "./ChangeReview";
import DataTransferPanel from "./DataTransferPanel";
import AdapterPanel from "./AdapterPanel";
import BatchReleasePanel from "./BatchReleasePanel";
import BusinessExpansionPanel from "./BusinessExpansionPanel";
export default function ExpansionOperationsPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const [tab, setTab] = useState("jobs"),
    [jobs, setJobs] = useState<WorkItem[]>([]),
    [usage, setUsage] = useState<ExpansionUsage | null>(null),
    [metrics, setMetrics] = useState<Record<string, unknown> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reviewJob, setReviewJob] = useState<WorkItem | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [envReview, setEnvReview] = useState<{
      environment: ExpansionEnvironment;
      name: string;
      config: Record<string, unknown>;
    } | null>(null);
  const query = new URLSearchParams({
      projectId: s.project.id,
      ...(x.scope?.organizationId
        ? { organizationId: x.scope.organizationId }
        : {}),
      ...(x.environmentId ? { environmentId: x.environmentId } : {}),
    }),
    environment = x.bootstrap?.environments.find(
      (env) => env.id === x.environmentId,
    );
  async function refresh() {
    try {
      const [jobs, usage, metrics] = await Promise.all([
        api<WorkItem[]>(`/api/work-items?${query}`),
        x.can("billing.manage")
          ? x.request<ExpansionUsage>("usage")
          : Promise.resolve(null),
        api<unknown>(`/api/work-items/metrics?${query}`),
      ]);
      setJobs(jobs);
      setUsage(usage);
      setMetrics(record(metrics));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "운영 실행 상태를 확인하세요.");
    }
  }
  useEffect(() => {
    void refresh();
  }, [s.project.id, x.environmentId]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "운영 요청을 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  function reviewEnvironment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!environment) return;
    try {
      const values = new FormData(e.currentTarget);
      setEnvReview({
        environment,
        name: String(values.get("name")),
        config: record(JSON.parse(String(values.get("config"))) as unknown),
      });
      setError("");
    } catch {
      setError(
        "환경 설정은 일반 설정 JSON 객체로 입력하세요. 비밀 원문은 조직 비밀 참조를 사용하세요.",
      );
    }
  }
  return (
    <details className="expansion-panel" open>
      <summary>환경 운영·확장 실행</summary>
      <DataTransferPanel studio={s} expansion={x} />
      <AdapterPanel studio={s} expansion={x} />
      <BatchReleasePanel studio={s} expansion={x} />
      <BusinessExpansionPanel studio={s} expansion={x} />
      <div className="panel-tabs">
        {[
          ["jobs", "실행 대기열"],
          ["automation", "자동화"],
          ["security", "API·비밀"],
          ["usage", "사용량"],
          ["environment", "환경 설정"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            onClick={() => setTab(id!)}
            aria-pressed={tab === id}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "automation" && <AutomationPanel studio={s} expansion={x} />}{" "}
      {tab === "security" && <ApiSecurityPanel studio={s} expansion={x} />}{" "}
      {tab === "jobs" && (
        <>
          <h3>실제 실행 대기열</h3>
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            대기열 상태 새로고침
          </button>
          {metrics && (
            <dl className="stat-grid">
              {Object.entries(metrics)
                .filter(([, value]) => typeof value === "number")
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
            </dl>
          )}
          {jobs.map((job) => (
            <article className="page-card" key={job.id}>
              <strong>
                {job.kind} ·{" "}
                {
                  {
                    waiting: "대기",
                    running: "실행 중",
                    succeeded: "완료",
                    failed: "실패",
                    cancelled: "취소",
                    unknown: "외부 결과 미확인",
                  }[job.status]
                }
              </strong>
              <small>
                {job.id} · 시도 {job.attempts} · 환경{" "}
                {job.scope.environmentId || "기본"} ·{" "}
                {new Date(job.createdAt).toLocaleString()}
              </small>
              {job.errorCode && (
                <p className="bad">오류 코드 {job.errorCode}</p>
              )}{" "}
              {job.cancelRequested && (
                <p>취소 요청 전달됨 · 실행 중인 공급자 작업은 결과 확인 필요</p>
              )}
              {["waiting", "running"].includes(job.status) && (
                <button
                  type="button"
                  disabled={busy || !x.can("project.edit")}
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `/api/work-items/${job.id}/cancel?${query}`,
                        "POST",
                        {},
                      );
                    })
                  }
                >
                  실행 취소 요청
                </button>
              )}
              {["failed", "cancelled", "unknown"].includes(job.status) && (
                <button
                  type="button"
                  disabled={busy || !x.can("project.edit")}
                  onClick={() => {
                    setConfirmed(false);
                    setReviewJob(job);
                  }}
                >
                  실행 재시도 검토
                </button>
              )}
            </article>
          ))}
          {!jobs.length && !error && (
            <p>이 사이트·환경의 저장된 작업이 없습니다.</p>
          )}
        </>
      )}{" "}
      {tab === "usage" && (
        <>
          <h3>실제 사용·예약 한도</h3>
          <p className="hint">
            비용이 발생할 수 있는 작업은 사용량을 예약하고 완료량을 반영합니다.
            청구 공급자 금액과는 별도로 관리합니다.
          </p>
          {usage?.budget.map((budget) => (
            <p key={budget.metric + budget.period}>
              {budget.metric} · {budget.period} · 사용 {budget.used} / 한도{" "}
              {budget.limitAmount}
            </p>
          ))}
          {!usage?.budget.length && <p>설정된 사용 한도가 없습니다.</p>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = new FormData(e.currentTarget);
              void run(async () => {
                await x.request("usage/limits", "POST", {
                  organizationId: x.scope?.organizationId,
                  metric: values.get("metric"),
                  amount: Number(values.get("amount")),
                  period: values.get("period"),
                });
              });
            }}
          >
            <label>
              사용량 종류
              <input
                name="metric"
                placeholder="generation"
                required
                maxLength={100}
              />
            </label>
            <label>
              기간
              <input
                name="period"
                defaultValue={new Date().toISOString().slice(0, 7)}
                required
                maxLength={30}
              />
            </label>
            <label>
              허용량
              <input
                name="amount"
                type="number"
                min={0}
                max={1000000000}
                required
              />
            </label>
            <button disabled={busy || !x.can("billing.manage")}>
              조직 사용 한도 저장
            </button>
          </form>
          {usage?.reservations.map((item) => (
            <article className="page-card" key={item.id}>
              <strong>
                {item.metric} · {item.status}
              </strong>
              <p>
                예약 {item.amount} · 실제 반영 {item.committedAmount}
              </p>
              <small>
                {item.key} · 환경 {item.scope.environmentId || "기본"} ·{" "}
                {new Date(item.createdAt).toLocaleString()}
              </small>
            </article>
          ))}
        </>
      )}{" "}
      {tab === "environment" && (
        <>
          <h3>선택 환경의 일반 설정</h3>
          {environment ? (
            <form
              key={environment.id + ":" + environment.configVersion}
              onSubmit={reviewEnvironment}
            >
              <p>
                {environment.kind} · 데이터 키 {environment.dataKey} · 설정 v
                {environment.configVersion}
              </p>
              <label>
                환경 표시 이름
                <input
                  name="name"
                  defaultValue={environment.name}
                  required
                  maxLength={100}
                />
              </label>
              <label>
                일반 환경 설정 JSON
                <textarea
                  name="config"
                  defaultValue={JSON.stringify(environment.config, null, 2)}
                  maxLength={64000}
                  rows={8}
                />
              </label>
              <p className="hint">
                비밀·토큰·비밀번호 원문은 입력하지 않습니다. 환경 데이터 귀속은
                변경하지 않고 설정만 새 버전으로 저장합니다.
              </p>
              <button disabled={busy || !x.can("workspace.manage")}>
                환경 설정 변경 검토
              </button>
            </form>
          ) : (
            <p>작업 공간에서 사이트와 환경을 먼저 선택하세요.</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {reviewJob && (
        <EditorDialog
          title="영속 작업 재시도 검토"
          onClose={() => setReviewJob(null)}
        >
          <p>
            {reviewJob.kind} · {reviewJob.id} · 현재 {reviewJob.status} · 기존
            요청 키와 완료된 동작 기록을 유지합니다.
          </p>
          {reviewJob.status === "unknown" ? (
            <>
              <p className="bad">
                외부 공급자가 처리했는지 확인되지 않았습니다. 공급자 거래·발송
                기록을 확인한 뒤 재시도를 결정해야 합니다.
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                공급자 결과와 중복 실행 영향을 확인했습니다
              </label>
            </>
          ) : (
            <p>일시 오류·수정된 설정을 확인하고 기존 작업을 다시 실행합니다.</p>
          )}
          <button
            type="button"
            disabled={busy || (reviewJob.status === "unknown" && !confirmed)}
            onClick={() =>
              void run(async () => {
                await api(
                  `/api/work-items/${reviewJob.id}/retry?${query}`,
                  "POST",
                  {
                    confirmedUnknown: confirmed,
                  },
                );
                setReviewJob(null);
              })
            }
          >
            검토한 작업 재시도
          </button>
        </EditorDialog>
      )}
      {envReview && (
        <EditorDialog
          title="환경 설정 변경 비교"
          onClose={() => setEnvReview(null)}
        >
          <ChangeReview
            before={{
              name: envReview.environment.name,
              config: envReview.environment.config,
            }}
            after={{ name: envReview.name, config: envReview.config }}
          />
          <p>
            설정 v{envReview.environment.configVersion} 기준이며 데이터 키{" "}
            {envReview.environment.dataKey}는 유지합니다.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await x.request(
                  `environments/${envReview.environment.id}`,
                  "PUT",
                  {
                    name: envReview.name,
                    config: envReview.config,
                    baseVersion: envReview.environment.configVersion,
                  },
                );
                setEnvReview(null);
                await x.refresh();
              })
            }
          >
            검토한 환경 설정 저장
          </button>
        </EditorDialog>
      )}
    </details>
  );
}
