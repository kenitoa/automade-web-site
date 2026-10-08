import { useEffect, useRef, useState } from "react";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import type { GenerationState } from "./useGeneration";
import type { RuntimeTask as Task } from "../domain/systemRuntime";
import { useSystemActions } from "./useSystemActions";
export default function StudioTaskInbox({
  studio: s,
  expansion: x,
  generation: g,
  variant,
}: {
  studio: StudioState;
  expansion: ExpansionState;
  generation: GenerationState;
  variant?: string;
}) {
  const a = useSystemActions(s, x);
  const [tasks, setTasks] = useState<Task[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [at, setAt] = useState("");
  const sequence = useRef(0);
  async function refresh() {
    const request = ++sequence.current;
    setBusy(true);
    try {
      const raw = record(
        await api<unknown>(
          `/api/advancement/runtime/overview?projectId=${s.project.id}&environmentId=${encodeURIComponent(x.environmentId)}`,
        ),
      );
      if (!Array.isArray(raw.tasks))
        throw new Error("업무 목록 형식을 확인하세요.");
      const values = raw.tasks.map((value) => {
        const item = record(value);
        for (const key of [
          "id",
          "kind",
          "title",
          "status",
          "projectId",
          "nextAction",
        ])
          if (typeof item[key] !== "string")
            throw new Error("업무 목록 형식을 확인하세요.");
        return item as unknown as Task;
      });
      if (request !== sequence.current) return;
      setTasks(values);
      setAt(new Date().toISOString());
      setError("");
    } catch (e) {
      if (request !== sequence.current) return;
      setError(
        e instanceof Error ? e.message : "현재 업무를 확인하지 못했습니다.",
      );
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      if (x.scope) void refresh();
    }, 800);
    return () => {
      clearTimeout(timer);
      sequence.current++;
    };
  }, [s.project.id, x.environmentId, s.project.revision, g.job?.status]);
  async function open(task: Task) {
    if (task.projectId !== s.project.id) {
      setError("이 업무의 사이트를 먼저 선택하세요. 현재 변경은 보존됩니다.");
      return;
    }
    if (task.environmentId && task.environmentId !== x.environmentId) {
      await x.selectEnvironment(task.environmentId);
    }
    const panel = task.kind.includes("quality")
      ? "quality"
      : task.kind.includes("content") || task.kind.includes("review")
        ? "pages"
        : task.kind.includes("connection") ||
            task.kind.includes("job") ||
            task.kind.includes("recovery") ||
            task.kind.includes("release.unknown")
          ? "operations"
          : "output";
    s.setPanel(panel);
    if (panel === "pages") s.setInspectorOpen(true);
    s.setMessage(`${task.title} · ${task.nextAction}`);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(".tool-panel h2")?.focus(),
    );
  }
  return (
    <details className="studio-task-inbox">
      <summary>
        역할별 다음 업무{" "}
        {tasks.filter((task) => task.status !== "completed").length
          ? `· ${tasks.filter((task) => task.status !== "completed").length}개`
          : ""}
      </summary>
      <p>
        {x.can("review.approve")
          ? "검토·승인 담당"
          : x.can("project.publish")
            ? "제작·발행 담당"
            : "편집·확인 담당"}{" "}
        · 완료는 실제 서버 상태로 확인합니다. 읽음과 업무 완료를 구분합니다.
      </p>
      {variant === "guided" && (
        <ol>
          <li>업무 사유와 현재 사이트·환경을 확인합니다.</li>
          <li>해당 메뉴에서 필요한 입력·권한·승인을 완료합니다.</li>
          <li>
            실제 업무 상태를 다시 조회하고, 실패하면 입력을 유지해 복구합니다.
          </li>
        </ol>
      )}
      <button
        type="button"
        disabled={busy || !x.scope}
        onClick={() => void refresh()}
      >
        {busy ? "업무 상태 확인 중…" : "실제 업무 상태 다시 확인"}
      </button>
      {at && <small>확인 {new Date(at).toLocaleTimeString()}</small>}
      {tasks.map((task) => (
        <article className="page-card" key={task.id}>
          <strong>{task.title}</strong>
          <p>
            {task.status} · {task.nextAction}
          </p>
          {task.reason && <p>{task.reason}</p>}
          <button type="button" onClick={() => void open(task)}>
            해당 업무 이어서 수행
          </button>
          {task.kind === "release.unknown" && (
            <button
              type="button"
              disabled={
                busy ||
                !x.can("project.publish") ||
                Boolean(
                  task.environmentId && task.environmentId !== x.environmentId,
                )
              }
              onClick={() =>
                a.review({
                  label: "중단된 승격의 활성 상태·산출물 대사",
                  path: `runtime/releases/${encodeURIComponent(task.id)}/reconcile`,
                  method: "POST",
                  payload: {
                    projectId: task.projectId,
                    environmentId: task.environmentId,
                  },
                  stepUp: true,
                  success: async (raw) => {
                    const result = record(raw);
                    await refresh();
                    s.setMessage(
                      `승격 대사 ${String(result.status)} · 사이트 데이터 보존. 공개 제공자 상태는 배포 업무에서 확인하세요.`,
                    );
                  },
                })
              }
            >
              중단된 승격 대사 검토
            </button>
          )}
        </article>
      ))}
      {!busy && !error && !tasks.length && (
        <p>
          현재 범위에서 대기하는 업무가 없습니다. 새 자료를 준비하거나 기존
          프로젝트를 편집할 수 있습니다.
        </p>
      )}
      {error && (
        <p className="bad" role="alert">
          {error}
        </p>
      )}
      {a.dialog}
    </details>
  );
}
