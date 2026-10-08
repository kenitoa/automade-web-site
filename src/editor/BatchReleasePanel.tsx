import { useRef, useState } from "react";
import type { ExpansionEnvironment } from "../domain/expansion";
import type { Project, ExportResult } from "../domain/types";
import { api } from "../infrastructure/api";
import { parseProject, inspectProject } from "../domain/validation";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import EditorDialog from "./EditorDialog";
interface PlannedRelease {
  environment: ExpansionEnvironment;
  project: Project;
  key: string;
  id?: string;
  status: "prepared" | "building" | "ready" | "failed" | "unknown";
  error?: string;
  result?: ExportResult;
}
export default function BatchReleasePanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [plan, setPlan] = useState<PlannedRelease[]>([]),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    stop = useRef(false);
  const environments =
    x.bootstrap?.environments.filter(
      (env) => !x.workspaceId || env.workspaceId === x.workspaceId,
    ) || [];
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      if (!(await s.syncProject(s.project)))
        throw new Error("현재 원본 동기화와 충돌 검토를 완료하세요.");
      const next: PlannedRelease[] = [];
      for (const id of selected) {
        const environment = environments.find((env) => env.id === id);
        if (!environment) throw new Error("선택 환경을 다시 확인하세요.");
        const project = parseProject(
          await api<unknown>(`/api/projects/${environment.projectId}`),
        );
        const issues = inspectProject(project).filter(
          (issue) => issue.severity === "error",
        );
        if (issues.length)
          throw new Error(
            `${project.name}: ${issues.map((issue) => issue.message).join(" · ")}`,
          );
        next.push({
          environment,
          project,
          key: crypto.randomUUID(),
          status: "prepared",
        });
      }
      setPlan(next);
      setReview(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "환경 생성 범위를 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  function update(key: string, change: Partial<PlannedRelease>) {
    setPlan((list) =>
      list.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
  }
  async function execute() {
    stop.current = false;
    setBusy(true);
    setReview(false);
    setError("");
    try {
      for (const item of plan) {
        if (stop.current) break;
        if (item.status === "ready") continue;
        let id = item.id;
        try {
          if (id && item.status === "failed") {
            id = (
              await api<{ id: string }>(
                `/api/exports/${id}/retry?environmentId=${item.environment.id}`,
                "POST",
                {},
              )
            ).id;
          } else if (!id)
            id = (
              await api<{ id: string }>(
                `/api/exports?environmentId=${item.environment.id}&workspaceId=${item.environment.workspaceId}`,
                "POST",
                { project: item.project, idempotencyKey: item.key },
              )
            ).id;
          update(item.key, { id, status: "building", error: "" });
          const deadline = Date.now() + 120000;
          let finished = false;
          while (Date.now() < deadline) {
            const job = await api<{
              status: string;
              error?: string;
              result?: ExportResult;
            }>(`/api/exports/${id}?environmentId=${item.environment.id}`);
            if (job.status === "ready" && job.result) {
              update(item.key, { status: "ready", result: job.result });
              finished = true;
              break;
            }
            if (["failed", "cancelled"].includes(job.status))
              throw new Error(job.error || "환경 생성이 중단되었습니다.");
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          if (!finished) {
            update(item.key, {
              status: "unknown",
              error:
                "저장된 작업이 계속 실행 중일 수 있습니다. 작업 상태를 확인하세요.",
            });
            break;
          }
        } catch (e) {
          const message =
            e instanceof Error ? e.message : "환경 작업을 확인하세요.";
          update(item.key, {
            status: id ? "failed" : "unknown",
            error: message,
            id,
          });
          setError(message);
          break;
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="expansion-panel">
      <summary>여러 환경 순차 생성·실행</summary>
      <p className="hint">
        선택 환경별 원본·데이터 경계를 검토하고 한 환경씩 생성합니다. 실패하면
        다음 환경 요청을 멈추며 완료된 환경은 유지합니다. 공개 배포는 실제 공개
        승인 후 실행합니다.
      </p>
      {environments.map((env) => (
        <label className="check" key={env.id}>
          <input
            type="checkbox"
            checked={selected.includes(env.id)}
            disabled={busy}
            onChange={(e) =>
              setSelected((list) =>
                e.target.checked
                  ? [...list, env.id]
                  : list.filter((id) => id !== env.id),
              )
            }
          />
          {x.bootstrap?.sites.find((site) => site.id === env.siteId)?.name} ·{" "}
          {env.name} · {env.kind}
        </label>
      ))}
      <button
        type="button"
        disabled={
          busy ||
          !selected.length ||
          selected.length > 10 ||
          !x.can("project.publish")
        }
        onClick={() => void prepare()}
      >
        선택 환경의 실제 원본·영향 검토
      </button>
      {busy && (
        <button
          type="button"
          onClick={() => {
            stop.current = true;
            s.setMessage(
              "현재 환경 요청은 상태를 확인하며, 다음 환경부터 새 요청을 중지합니다.",
            );
          }}
        >
          다음 환경 요청 중지
        </button>
      )}
      {plan.map((item) => (
        <article className="page-card" key={item.key}>
          <strong>
            {item.project.name} · {item.environment.name} · v
            {item.project.revision}
          </strong>
          <p>
            {
              {
                prepared: "검토 준비",
                building: "생성 실행 중",
                ready: "생성·실행 완료",
                failed: "실패",
                unknown: "상태 확인 필요",
              }[item.status]
            }
          </p>
          <small>
            요청 키 {item.key} {item.id && `· 작업 ${item.id}`}
          </small>
          {item.result && (
            <a href={item.result.url} target="_blank" rel="noreferrer">
              실제 실행 사이트 열기 ↗
            </a>
          )}
          {item.error && <p className="bad">{item.error}</p>}
        </article>
      ))}
      {!busy && plan.some((item) => item.status !== "ready") && (
        <button type="button" onClick={() => setReview(true)}>
          미완료 환경 재개 검토
        </button>
      )}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {review && (
        <EditorDialog
          title="환경별 순차 생성·데이터 보존 검토"
          onClose={() => setReview(false)}
        >
          {plan.map((item) => (
            <article className="page-card" key={item.key}>
              <strong>
                {item.project.name} v{item.project.revision} →{" "}
                {item.environment.name}
              </strong>
              <p>
                {item.project.pages.length}페이지 · {item.project.blocks.length}
                블록 · 데이터 키 {item.environment.dataKey} · 설정 v
                {item.environment.configVersion}
              </p>
            </article>
          ))}
          <p>
            각 환경의 최신 운영 자료를 유지하고 별도 산출물을 만듭니다. 환경별
            권한과 승인 규칙을 실행 전에 다시 검사합니다. 이미 완료한 환경은
            건너뜁니다.
          </p>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void execute()}
          >
            검토한 환경을 순차 생성·실행
          </button>
        </EditorDialog>
      )}
    </details>
  );
}
