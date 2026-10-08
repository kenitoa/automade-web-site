import { useEffect, useState } from "react";
import type {
  AutomationWorkflow,
  AutomationRun,
  WorkflowAction,
  WorkflowCondition,
  WorkflowTrigger,
} from "../domain/expansion";
import type { ExpansionState } from "./useExpansion";
import type { StudioState } from "./useStudio";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import EditorDialog from "./EditorDialog";
export default function AutomationPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const [list, setList] = useState<AutomationWorkflow[]>([]),
    [runs, setRuns] = useState<AutomationRun[]>([]),
    [name, setName] = useState(""),
    [trigger, setTrigger] = useState<WorkflowTrigger>("manual"),
    [enabled, setEnabled] = useState(false),
    [conditions, setConditions] = useState<WorkflowCondition[]>([]),
    [actions, setActions] = useState<WorkflowAction[]>([
      { type: "submission.update", status: "processing" },
    ]),
    [editing, setEditing] = useState<AutomationWorkflow | null>(null),
    [review, setReview] = useState(false),
    [event, setEvent] = useState('{"submissionId":""}'),
    [eventKey, setEventKey] = useState<string>(crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [connections, setConnections] = useState<
      { id: string; name: string; kind: string }[]
    >([]);
  async function refresh() {
    try {
      const [a, b, c] = await Promise.all([
        x.request<AutomationWorkflow[]>("workflows"),
        x.request<AutomationRun[]>("workflows/runs"),
        api<unknown>(`/api/platform/connections?projectId=${s.project.id}`),
      ]);
      setList(a);
      setRuns(b);
      if (Array.isArray(c))
        setConnections(
          c.map((value) => {
            const v = record(value);
            if (
              typeof v.id !== "string" ||
              typeof v.name !== "string" ||
              typeof v.kind !== "string"
            )
              throw new Error("연결 목록 계약을 확인하세요.");
            return { id: v.id, name: v.name, kind: v.kind };
          }),
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : "자동화 목록을 확인하세요.");
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
      setError(e instanceof Error ? e.message : "자동화 계약을 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  function load(item: AutomationWorkflow | null) {
    setEditing(item);
    setName(item?.name || "");
    setTrigger(item?.trigger || "manual");
    setEnabled(item?.enabled || false);
    setConditions(structuredClone(item?.conditions || []));
    setActions(
      structuredClone(
        item?.actions || [{ type: "submission.update", status: "processing" }],
      ),
    );
  }
  return (
    <section className="expansion-panel">
      <h3>이벤트 자동화</h3>
      <p className="hint">
        조건이 맞는 이벤트를 영속 대기열에 저장합니다. 완료한 동작은 기록하며
        실패한 작업의 재시도는 운영 대기열에서 검토합니다.
      </p>
      <button type="button" onClick={() => void refresh()} disabled={busy}>
        자동화·실행 새로고침
      </button>
      {list.map((item) => (
        <article key={item.id} className="page-card">
          <strong>
            {item.name} · v{item.revision} ·{" "}
            {item.enabled ? "실행 허용" : "중지"}
          </strong>
          <small>
            {item.trigger} · 조건 {item.conditions.length} · 동작{" "}
            {item.actions.length}
          </small>
          <button type="button" disabled={busy} onClick={() => load(item)}>
            정의 편집
          </button>
          <button
            type="button"
            disabled={busy || !x.can("automation.manage")}
            onClick={() =>
              void run(async () => {
                await x.request(`workflows/${item.id}`, "PUT", {
                  ...item,
                  projectId: s.project.id,
                  enabled: !item.enabled,
                  baseRevision: item.revision,
                });
              })
            }
          >
            {item.enabled ? "중지" : "실행 허용"}
          </button>
        </article>
      ))}
      {!list.length && <p>저장된 자동화가 없습니다.</p>}
      <details open={Boolean(editing)}>
        <summary>{editing ? "저장된 자동화 변경" : "자동화 만들기"}</summary>
        <label>
          자동화 이름
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
          />
        </label>
        <label>
          시작 이벤트
          <select
            value={trigger}
            onChange={(e) => setTrigger(e.target.value as WorkflowTrigger)}
          >
            {[
              ["manual", "수동 실행"],
              ["form.submitted", "폼 문의 접수"],
              ["order.paid", "주문 결제 서버 확인"],
              ["booking.created", "예약 생성"],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          이벤트 실행 허용
        </label>
        {conditions.map((condition, i) => (
          <fieldset key={i}>
            <legend>조건 {i + 1}</legend>
            <label>
              이벤트 자료 경로
              <input
                value={condition.field}
                onChange={(e) =>
                  setConditions((list) =>
                    list.map((c, j) =>
                      j === i ? { ...c, field: e.target.value } : c,
                    ),
                  )
                }
                placeholder="category"
                maxLength={100}
              />
            </label>
            <label>
              비교
              <select
                value={condition.operator}
                onChange={(e) =>
                  setConditions((list) =>
                    list.map((c, j) =>
                      j === i
                        ? {
                            ...c,
                            operator: e.target
                              .value as WorkflowCondition["operator"],
                          }
                        : c,
                    ),
                  )
                }
              >
                <option value="equals">같음</option>
                <option value="contains">포함</option>
                <option value="greaterThan">숫자보다 큼</option>
              </select>
            </label>
            <label>
              비교 값
              <input
                value={String(condition.value ?? "")}
                onChange={(e) =>
                  setConditions((list) =>
                    list.map((c, j) =>
                      j === i
                        ? {
                            ...c,
                            value:
                              c.operator === "greaterThan"
                                ? Number(e.target.value)
                                : e.target.value,
                          }
                        : c,
                    ),
                  )
                }
              />
            </label>
            <button
              type="button"
              onClick={() =>
                setConditions((list) => list.filter((_, j) => j !== i))
              }
            >
              조건 제거
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={conditions.length >= 20}
          onClick={() =>
            setConditions((list) => [
              ...list,
              { field: "category", operator: "equals", value: "" },
            ])
          }
        >
          조건 추가
        </button>
        {actions.map((action, i) => (
          <fieldset key={i}>
            <legend>동작 {i + 1}</legend>
            <label>
              동작 종류
              <select
                value={action.type}
                onChange={(e) =>
                  setActions((list) =>
                    list.map((a, j) =>
                      j !== i
                        ? a
                        : e.target.value === "submission.update"
                          ? { type: "submission.update", status: "processing" }
                          : {
                              type: "connection.enqueue",
                              connectionId: "",
                              template: { message: "{{message}}" },
                            },
                    ),
                  )
                }
              >
                <option value="submission.update">
                  문의 상태·담당·태그 변경
                </option>
                <option value="connection.enqueue">
                  연결한 메일·CRM에 발송 작업
                </option>
              </select>
            </label>
            {action.type === "submission.update" ? (
              <>
                <label>
                  문의 상태
                  <select
                    value={action.status || ""}
                    onChange={(e) =>
                      setActions((list) =>
                        list.map((a, j) =>
                          j === i && a.type === "submission.update"
                            ? { ...a, status: e.target.value as "processing" }
                            : a,
                        ),
                      )
                    }
                  >
                    <option value="new">새 문의</option>
                    <option value="processing">처리 중</option>
                    <option value="completed">완료</option>
                    <option value="archived">보관</option>
                  </select>
                </label>
                <label>
                  담당자
                  <input
                    value={action.assignee || ""}
                    onChange={(e) =>
                      setActions((list) =>
                        list.map((a, j) =>
                          j === i && a.type === "submission.update"
                            ? { ...a, assignee: e.target.value }
                            : a,
                        ),
                      )
                    }
                    maxLength={200}
                  />
                </label>
                <label>
                  태그 · 쉼표로 구분
                  <input
                    value={action.tags?.join(",") || ""}
                    onChange={(e) =>
                      setActions((list) =>
                        list.map((a, j) =>
                          j === i && a.type === "submission.update"
                            ? {
                                ...a,
                                tags: e.target.value
                                  .split(",")
                                  .map((v) => v.trim())
                                  .filter(Boolean),
                              }
                            : a,
                        ),
                      )
                    }
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  발송 연결
                  <select
                    value={action.connectionId}
                    onChange={(e) =>
                      setActions((list) =>
                        list.map((a, j) =>
                          j === i && a.type === "connection.enqueue"
                            ? { ...a, connectionId: e.target.value }
                            : a,
                        ),
                      )
                    }
                  >
                    <option value="">선택하세요</option>
                    {connections
                      .filter((c) => ["mail", "crm"].includes(c.kind))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  메시지 템플릿
                  <textarea
                    value={action.template.message || ""}
                    onChange={(e) =>
                      setActions((list) =>
                        list.map((a, j) =>
                          j === i && a.type === "connection.enqueue"
                            ? {
                                ...a,
                                template: {
                                  ...a.template,
                                  message: e.target.value,
                                },
                              }
                            : a,
                        ),
                      )
                    }
                    maxLength={2000}
                  />
                </label>
                <p className="hint">
                  이벤트 필드는 &#123;&#123;message&#125;&#125; 형태로
                  연결합니다.
                </p>
              </>
            )}
            <button
              type="button"
              disabled={actions.length === 1}
              onClick={() =>
                setActions((list) => list.filter((_, j) => j !== i))
              }
            >
              동작 제거
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={actions.length >= 20}
          onClick={() =>
            setActions((list) => [
              ...list,
              { type: "submission.update", status: "processing" },
            ])
          }
        >
          동작 추가
        </button>
        <div className="button-row">
          <button
            type="button"
            disabled={busy || !name.trim() || !x.can("automation.manage")}
            onClick={() => setReview(true)}
          >
            실행 권한·동작 검토
          </button>
          <button type="button" onClick={() => load(null)}>
            새 정의로 시작
          </button>
        </div>
      </details>
      <details>
        <summary>수동 이벤트 실행 검토</summary>
        <label>
          이벤트 자료 JSON
          <textarea
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            maxLength={100000}
          />
        </label>
        <p className="hint">
          실제 문의 변경은 해당 submissionId가 필요합니다. 키 {eventKey}는 같은
          요청 재시도에 유지합니다.
        </p>
        <button
          type="button"
          disabled={busy || !x.can("automation.manage")}
          onClick={() => {
            if (
              !confirm(
                "수동 이벤트 조건과 일치하는 활성 자동화를 실제 실행 대기열에 저장합니다. 계속할까요?",
              )
            )
              return;
            void run(async () => {
              const payload = record(JSON.parse(event) as unknown);
              await x.request("workflows/events", "POST", {
                projectId: s.project.id,
                trigger: "manual",
                payload,
                key: eventKey,
              });
              s.setMessage(
                "수동 이벤트를 영속 대기열에 저장했습니다. 실제 완료 상태를 확인하세요.",
              );
            });
          }}
        >
          검토한 이벤트 실행 요청
        </button>
        <button type="button" onClick={() => setEventKey(crypto.randomUUID())}>
          새 이벤트 키 만들기
        </button>
      </details>
      <h4>실행 기록</h4>
      {runs.map((run) => (
        <article className="page-card" key={run.id}>
          <strong>
            {run.status} · 완료 동작 {run.completedActions}
          </strong>
          <small>
            {run.id} · {new Date(run.updatedAt).toLocaleString()}
          </small>
          {run.errorCode && (
            <p className="bad">
              오류 코드 {run.errorCode} · 완료 동작 이후부터 재시도 가능
            </p>
          )}
        </article>
      ))}
      {!runs.length && <p>실행 기록이 없습니다.</p>}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {review && (
        <EditorDialog
          title="자동화 저장·실행 영향 검토"
          onClose={() => setReview(false)}
        >
          <p>
            {name} · {trigger} ·{" "}
            {enabled ? "저장 후 새 이벤트 실행 허용" : "저장 후 중지 상태"}
          </p>
          <p>
            환경 {x.environmentId || "기본"} · 필요 권한 automation.manage
            {actions.some((a) => a.type === "submission.update")
              ? " · data.write"
              : ""}
            {actions.some((a) => a.type === "connection.enqueue")
              ? " · connection.use"
              : ""}
          </p>
          <pre className="source-preview">
            {JSON.stringify({ conditions, actions }, null, 2)}
          </pre>
          <button
            type="button"
            disabled={busy}
            className="primary"
            onClick={() =>
              void run(async () => {
                await x.request(
                  editing ? `workflows/${editing.id}` : "workflows",
                  editing ? "PUT" : "POST",
                  {
                    projectId: s.project.id,
                    name,
                    trigger,
                    enabled,
                    conditions,
                    actions,
                    ...(editing ? { baseRevision: editing.revision } : {}),
                  },
                );
                setReview(false);
                load(null);
                s.setMessage("검토한 자동화 정의를 저장했습니다.");
              })
            }
          >
            검토한 정의 저장
          </button>
        </EditorDialog>
      )}
    </section>
  );
}
