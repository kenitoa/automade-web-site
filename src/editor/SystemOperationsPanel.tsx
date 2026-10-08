import { useEffect, useRef, useState } from "react";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import type {
  BackupSet,
  ReconciliationCase,
  OrganizationLifecycle,
  PrivacyRequest,
  CatalogVersion,
  WorkflowSimulation,
  ServiceIdentity,
  SupportSession,
} from "../domain/advancement";
import type { AutomationWorkflow } from "../domain/expansion";
import { EXPANSION_CAPABILITIES } from "../domain/expansion";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import { useSystemActions } from "./useSystemActions";
import EditorDialog from "./EditorDialog";
import { lazy, Suspense } from "react";
const SystemLedgerPanel = lazy(() => import("./SystemLedgerPanel"));
const value = (form: FormData, name: string) => String(form.get(name) || "");
function list<T>(raw: unknown): T[] {
  if (!Array.isArray(raw)) throw new Error("목록 응답 형식을 확인하세요.");
  raw.forEach((item) => record(item));
  return raw as T[];
}
export default function SystemOperationsPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const a = useSystemActions(s, x),
    [tab, setTab] = useState("recovery"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [cases, setCases] = useState<ReconciliationCase[]>([]),
    [backups, setBackups] = useState<BackupSet[]>([]),
    [privacy, setPrivacy] = useState<PrivacyRequest[]>([]),
    [catalog, setCatalog] = useState<CatalogVersion[]>([]),
    [identities, setIdentities] = useState<ServiceIdentity[]>([]),
    [support, setSupport] = useState<SupportSession[]>([]),
    [rotations, setRotations] = useState<Record<string, unknown>[]>([]),
    [lifecycle, setLifecycle] = useState<OrganizationLifecycle | null>(null),
    [workflows, setWorkflows] = useState<AutomationWorkflow[]>([]),
    [simulation, setSimulation] = useState<WorkflowSimulation | null>(null),
    [simulatedInput, setSimulatedInput] = useState<{
      workflowId: string;
      revision: number;
      payload: Record<string, unknown>;
    } | null>(null),
    [result, setResult] = useState<Record<string, unknown> | null>(null),
    [onceToken, setOnceToken] = useState("");
  const scopeKey = `${s.project.id}/${x.environmentId}/${tab}`,
    currentScope = useRef(scopeKey),
    requestSequence = useRef(0);
  currentScope.current = scopeKey;
  async function refresh() {
    const scope = scopeKey,
      request = ++requestSequence.current;
    setBusy(true);
    setError("");
    try {
      setResult(null);
      if (tab === "usage") return;
      if (tab === "workflows") {
        const result = await x.request<AutomationWorkflow[]>("workflows");
        if (
          scope !== currentScope.current ||
          request !== requestSequence.current
        )
          return;
        setWorkflows(result);
        return;
      }
      const route = (
        {
          recovery: "reconciliation-cases",
          backups: "backup-sets",
          privacy: "privacy-requests",
          catalog: "catalog",
          identities: "service-identities",
          support: "support-sessions",
          lifecycle: "lifecycle",
          keyring: "keyring",
          usage: "usage",
        } as Record<string, string>
      )[tab]!;
      const raw = await api<unknown>(a.endpoint(route));
      if (scope !== currentScope.current || request !== requestSequence.current)
        return;
      if (tab === "recovery") setCases(list(raw));
      if (tab === "backups") setBackups(list(raw));
      if (tab === "privacy") setPrivacy(list(raw));
      if (tab === "catalog") setCatalog(list(raw));
      if (tab === "identities") setIdentities(list(raw));
      if (tab === "support") setSupport(list(raw));
      if (tab === "lifecycle")
        setLifecycle(record(raw) as unknown as OrganizationLifecycle);
      if (["usage", "keyring"].includes(tab)) setResult(record(raw));
      if (tab === "keyring") {
        const status = record(raw);
        if (!Array.isArray(status.rotations))
          throw new Error("키 회전의 재개 상태를 확인하세요.");
        setRotations(status.rotations.map((value) => record(value)));
      }
    } catch (e) {
      if (scope !== currentScope.current || request !== requestSequence.current)
        return;
      setError(
        e instanceof Error ? e.message : "운영 상태를 확인하지 못했습니다.",
      );
    } finally {
      if (scope === currentScope.current && request === requestSequence.current)
        setBusy(false);
    }
  }
  useEffect(() => {
    setCases([]);
    setBackups([]);
    setPrivacy([]);
    setCatalog([]);
    setIdentities([]);
    setSupport([]);
    setRotations([]);
    setLifecycle(null);
    setSimulation(null);
    setSimulatedInput(null);
    setOnceToken("");
    void refresh();
    return () => {
      requestSequence.current++;
    };
  }, [tab, s.project.id, x.environmentId]);
  const success = async (raw: unknown) => {
    const scope = scopeKey;
    await refresh();
    if (scope !== currentScope.current) return;
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      setResult(record(raw));
  };
  return (
    <section className="system-operations">
      <div className="panel-tabs">
        {[
          ["recovery", "미확인 대사"],
          ["backups", "백업 집합"],
          ["workflows", "실행 전 시험"],
          ["identities", "기계 계정"],
          ["support", "지원 접근"],
          ["keyring", "암호화 키"],
          ["privacy", "개인정보"],
          ["lifecycle", "인계·보관"],
          ["catalog", "팩 승인"],
          ["usage", "원장 대사"],
        ].map(([id, label]) => (
          <button
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id!)}
            key={id}
          >
            {label}
          </button>
        ))}
      </div>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {busy ? "실제 상태 조회 중…" : "현재 범위 상태 조회"}
      </button>
      {tab === "recovery" && (
        <>
          <p>
            공급자의 실제 결과를 확인합니다. 수동 성공 표시나 미확인 외부 요청의
            무조건 재실행을 제공하지 않습니다.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              a.review({
                label: "미확인 작업 대사 업무 등록",
                path: "reconciliation-cases",
                method: "POST",
                payload: {
                  kind: value(form, "kind"),
                  targetId: value(form, "targetId"),
                },
                success,
              });
            }}
          >
            <label>
              업무 종류
              <select name="kind">
                <option value="payment">결제</option>
                <option value="deployment">공개 배포</option>
                <option value="work">외부 효과 작업</option>
                <option value="restore">복원</option>
              </select>
            </label>
            <label>
              확인할 실제 작업 ID
              <input name="targetId" required maxLength={150} />
            </label>
            <button disabled={!x.can("data.write")}>대사 업무 등록 검토</button>
          </form>
          {cases.map((item) => (
            <article className="page-card" key={item.id}>
              <strong>
                {item.kind} · {item.status} · v{item.revision}
              </strong>
              <p>
                {item.targetId} · {item.resolution || "확인 전"}
              </p>
              {item.evidence && (
                <p>
                  {item.evidence.source} · 확인{" "}
                  {new Date(item.evidence.observedAt).toLocaleString()}
                </p>
              )}
              <button
                type="button"
                disabled={item.status === "verified" || !x.can("data.write")}
                onClick={() =>
                  a.review({
                    label: "공급자 상태 조회·실제 대사",
                    path: `reconciliation-cases/${item.id}/verify`,
                    method: "POST",
                    payload: { baseRevision: item.revision },
                    stepUp: true,
                    success,
                  })
                }
              >
                실제 결과 조회 검토
              </button>
            </article>
          ))}
        </>
      )}
      {tab === "backups" && (
        <>
          <p>
            중앙·환경 DB와 blob·독립 산출물의 목록·해시·필요 키 버전을 함께
            기록합니다. 복원 훈련은 격리된 대상으로 검증하고 실제 복원은 선택
            범위를 교체합니다.
          </p>
          <button
            type="button"
            disabled={!x.can("backup.restore")}
            onClick={() =>
              a.review({
                label: "현재 환경 백업 집합 만들기",
                path: "backup-sets",
                method: "POST",
                payload: {},
                stepUp: true,
                success,
              })
            }
          >
            실제 백업 집합 생성 검토
          </button>
          {backups.map((backup) => (
            <article className="page-card" key={backup.id}>
              <strong>
                {backup.state} · {new Date(backup.createdAt).toLocaleString()}
              </strong>
              <p>
                {backup.consistency} · 파일{" "}
                {backup.files.length +
                  (backup.artifacts ?? []).reduce(
                    (sum, artifact) => sum + artifact.files.length,
                    0,
                  )}
                개 ·{" "}
                {(
                  (backup.files.reduce((sum, file) => sum + file.bytes, 0) +
                    (backup.artifacts ?? []).reduce(
                      (sum, artifact) => sum + artifact.bytes,
                      0,
                    )) /
                  1024
                ).toFixed(1)}
                KB · 키 {backup.keyIds.join(", ") || "별도 키 없음"}
              </p>
              <ul>
                {backup.files.map((file) => (
                  <li key={file.sha256 + file.kind}>
                    {file.kind} · {(file.bytes / 1024).toFixed(1)}KB ·{" "}
                    {file.sha256.slice(0, 12)}
                  </li>
                ))}
                {(backup.artifacts ?? []).map((artifact) => (
                  <li key={artifact.releaseId}>
                    독립 산출물 {artifact.releaseId} · 파일{" "}
                    {artifact.files.length}개 ·{" "}
                    {(artifact.bytes / 1024).toFixed(1)}KB
                  </li>
                ))}
              </ul>
              {backup.errorCode && <p className="bad">{backup.errorCode}</p>}
              {["rehearsal", "restore"].map((operation) => (
                <button
                  type="button"
                  key={operation}
                  disabled={
                    backup.state !== "verified" || !x.can("backup.restore")
                  }
                  onClick={() =>
                    a.review({
                      label:
                        operation === "restore"
                          ? "백업 집합으로 실제 데이터 복원"
                          : "격리된 대상으로 복원 훈련",
                      path: `backup-sets/${backup.id}/${operation}`,
                      method: "POST",
                      payload: { confirm: true },
                      before: {
                        environment: x.environmentId,
                        backupId: backup.id,
                        files: backup.files.map((file) => ({
                          kind: file.kind,
                          sha256: file.sha256,
                          bytes: file.bytes,
                        })),
                        keyIds: backup.keyIds,
                        artifacts: (backup.artifacts ?? []).map((artifact) => ({
                          releaseId: artifact.releaseId,
                          sourceReleaseId: artifact.sourceReleaseId,
                          files: artifact.files.length,
                          bytes: artifact.bytes,
                        })),
                      },
                      stepUp: true,
                      success,
                    })
                  }
                >
                  {operation === "restore"
                    ? "실제 복원 범위 검토"
                    : "격리 복원 훈련 검토"}
                </button>
              ))}
            </article>
          ))}
        </>
      )}
      {tab === "workflows" && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget),
                id = value(form, "workflowId"),
                workflow = workflows.find((item) => item.id === id);
              if (!workflow) return;
              const scope = scopeKey,
                request = ++requestSequence.current;
              setBusy(true);
              setSimulation(null);
              setSimulatedInput(null);
              try {
                const payload = record(
                  JSON.parse(value(form, "payload")) as unknown,
                );
                void api<WorkflowSimulation>(
                  a.endpoint(`workflows/${id}/simulation`),
                  "POST",
                  { payload },
                )
                  .then((result) => {
                    if (
                      scope !== currentScope.current ||
                      request !== requestSequence.current
                    )
                      return;
                    setSimulation(result);
                    setSimulatedInput({
                      workflowId: id,
                      revision: workflow.revision,
                      payload,
                    });
                  })
                  .catch(
                    (e) =>
                      scope === currentScope.current &&
                      request === requestSequence.current &&
                      setError(
                        e instanceof Error
                          ? e.message
                          : "시험을 완료하지 못했습니다.",
                      ),
                  )
                  .finally(() => {
                    if (
                      scope === currentScope.current &&
                      request === requestSequence.current
                    )
                      setBusy(false);
                  });
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "이벤트 JSON 객체를 확인하세요.",
                );
                setBusy(false);
              }
            }}
          >
            <label>
              저장된 자동화
              <select name="workflowId">
                {workflows.map((workflow) => (
                  <option value={workflow.id} key={workflow.id}>
                    {workflow.name} · v{workflow.revision}
                  </option>
                ))}
              </select>
            </label>
            <label>
              시험 이벤트 자료
              <textarea
                name="payload"
                rows={5}
                defaultValue="{}"
                maxLength={100000}
              />
            </label>
            <button
              disabled={
                busy || !workflows.length || !x.can("automation.manage")
              }
            >
              외부 효과 없이 조건·행동 시험
            </button>
          </form>
          {simulation && (
            <>
              <p>
                조건 {simulation.matched ? "충족" : "불충족"} · 실제 외부 실행
                없음
              </p>
              {simulation.conditions.map((condition, index) => (
                <p key={index}>
                  {condition.field} · {condition.matched ? "일치" : "불일치"}
                </p>
              ))}
              {simulation.actions.map((action) => (
                <p key={action.index}>
                  {action.index + 1}. {action.type} ·{" "}
                  {action.configured === false
                    ? "실제 연결 미설정"
                    : "시험 결과"}{" "}
                  · {action.effect}
                </p>
              ))}
              <button
                type="button"
                disabled={
                  !simulation.matched ||
                  !simulatedInput ||
                  simulation.actions.some(
                    (action) => action.configured === false,
                  ) ||
                  !x.can("automation.manage")
                }
                onClick={() => {
                  if (!simulatedInput) return;
                  a.review({
                    label: "시험한 수동 이벤트 실제 실행",
                    path: `workflows/${simulatedInput.workflowId}/execute-reviewed`,
                    method: "POST",
                    payload: {
                      expectedRevision: simulatedInput.revision,
                      payload: simulatedInput.payload,
                      key: crypto.randomUUID(),
                    },
                    before: {
                      workflowId: simulatedInput.workflowId,
                      revision: simulatedInput.revision,
                      externalEffects: false,
                    },
                    stepUp: true,
                    success,
                  });
                }}
              >
                시험 자료의 실제 실행 검토
              </button>
            </>
          )}
          {!workflows.length && (
            <p>자동화 탭에서 먼저 실제 workflow를 저장하세요.</p>
          )}
        </>
      )}
      {tab === "identities" && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              a.review({
                label: "조직 기계 계정 생성",
                path: "service-identities",
                method: "POST",
                payload: {
                  name: value(form, "name"),
                  capabilities: form.getAll("capability"),
                  expiresAt: new Date(value(form, "expires")).toISOString(),
                },
                stepUp: true,
                success: async (raw) => {
                  const item = record(raw);
                  await refresh();
                  if (typeof item.token === "string") setOnceToken(item.token);
                },
              });
            }}
          >
            <label>
              기계 계정 이름
              <input name="name" required maxLength={100} />
            </label>
            <label>
              만료 시각
              <input name="expires" type="datetime-local" required />
            </label>
            <fieldset>
              <legend>명시적으로 허용할 기능</legend>
              {EXPANSION_CAPABILITIES.filter(
                (cap) =>
                  ![
                    "org.manage",
                    "team.manage",
                    "secret.rotate",
                    "billing.manage",
                  ].includes(cap),
              ).map((cap) => (
                <label className="check" key={cap}>
                  <input name="capability" value={cap} type="checkbox" />
                  {cap}
                </label>
              ))}
            </fieldset>
            <button disabled={!x.can("team.manage")}>
              계정 범위·만료 검토
            </button>
          </form>
          {identities.map((identity) => (
            <article className="page-card" key={identity.id}>
              <strong>
                {identity.name} · {identity.revoked ? "폐기됨" : "활성"}
              </strong>
              <p>
                {identity.capabilities.join(", ")} · 만료{" "}
                {new Date(identity.expiresAt).toLocaleString()}
              </p>
              <button
                type="button"
                disabled={identity.revoked || !x.can("team.manage")}
                onClick={() =>
                  a.review({
                    label: "기계 계정 키 회전·제한된 전환",
                    path: `service-identities/${identity.id}/keys`,
                    method: "POST",
                    payload: { graceMinutes: 15 },
                    stepUp: true,
                    success: async (raw) => {
                      const item = record(raw);
                      await refresh();
                      if (typeof item.token === "string")
                        setOnceToken(item.token);
                    },
                  })
                }
              >
                15분 전환 키 회전 검토
              </button>
              <button
                type="button"
                disabled={identity.revoked || !x.can("team.manage")}
                onClick={() =>
                  a.review({
                    label: "기계 계정 신규 실행 폐기",
                    path: `service-identities/${identity.id}`,
                    method: "DELETE",
                    payload: {},
                    stepUp: true,
                    success,
                  })
                }
              >
                폐기 검토
              </button>
            </article>
          ))}
        </>
      )}
      {tab === "support" && (
        <>
          <p>
            현재 조직에 소속된 담당자에게 지원 업무와 24시간 이내의 종료 시각을
            지정합니다.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              a.review({
                label: "지원 담당자의 기간·범위 승인",
                path: "support-sessions",
                method: "POST",
                payload: {
                  supportId: value(form, "supportId"),
                  capabilities: form.getAll("capability"),
                  reason: value(form, "reason"),
                  expiresAt: new Date(value(form, "expires")).toISOString(),
                },
                stepUp: true,
                success,
              });
            }}
          >
            <label>
              현재 조직 지원 담당자 계정 ID
              <input name="supportId" required maxLength={100} />
            </label>
            <label>
              지원 사유
              <textarea name="reason" required maxLength={1000} />
            </label>
            <label>
              지원 종료 시각
              <input name="expires" type="datetime-local" required />
            </label>
            <fieldset>
              <legend>승인할 지원 업무</legend>
              {EXPANSION_CAPABILITIES.filter(
                (cap) =>
                  x.can(cap) &&
                  ![
                    "org.manage",
                    "team.manage",
                    "billing.manage",
                    "secret.rotate",
                    "backup.restore",
                    "workspace.manage",
                  ].includes(cap),
              ).map((cap) => (
                <label className="check" key={cap}>
                  <input type="checkbox" name="capability" value={cap} />
                  {cap}
                </label>
              ))}
            </fieldset>
            <button disabled={!x.can("team.manage")}>
              기간·사유·범위 검토
            </button>
          </form>
          {support.map((session) => (
            <article className="page-card" key={session.id}>
              <strong>
                {session.supportId} ·{" "}
                {session.revoked
                  ? "회수됨"
                  : Date.parse(session.expiresAt) <= Date.now()
                    ? "만료됨"
                    : "지원 허용"}
              </strong>
              <p>
                {session.reason} · {session.capabilities.join(", ")} · 종료{" "}
                {new Date(session.expiresAt).toLocaleString()}
              </p>
              <button
                type="button"
                disabled={session.revoked || !x.can("team.manage")}
                onClick={() =>
                  a.review({
                    label: "지원 세션 즉시 회수",
                    path: `support-sessions/${session.id}`,
                    method: "DELETE",
                    payload: {},
                    before: {
                      supportId: session.supportId,
                      capabilities: session.capabilities,
                      expiresAt: session.expiresAt,
                    },
                    stepUp: true,
                    success,
                  })
                }
              >
                신규 지원 요청·다음 단계 접근 회수 검토
              </button>
            </article>
          ))}
          {!support.length && <p>이 사이트에 승인된 지원 세션이 없습니다.</p>}
        </>
      )}
      {tab === "keyring" && (
        <>
          <p>
            키 회전은 암호화된 자료를 배치 이전하고 검증합니다. 기존 키는 회전
            완료와 복원 가능성을 확인하기 전 폐기하지 않습니다.
          </p>
          <p>
            플랫폼 관리자·로컬 소유자 전용입니다. 새 master key와 보존할 이전
            키는 서버 설정에서 준비하고, 이 화면에는 키 원문을 입력하지
            않습니다.
          </p>
          <button
            type="button"
            disabled={!x.can("secret.rotate")}
            onClick={() =>
              a.review({
                label: "암호화 master key 회전 시작",
                path: "keyring/rotations",
                method: "POST",
                payload: { id: crypto.randomUUID(), limit: 100 },
                stepUp: true,
                success,
              })
            }
          >
            배치 회전 영향 검토
          </button>
          {rotations.map((rotation) => (
            <article className="page-card" key={String(rotation.id)}>
              <strong>
                대상 키 {String(rotation.targetKeyId)} ·{" "}
                {String(rotation.status)}
              </strong>
              <p>
                처리된 암호화 자료 {String(rotation.processed)}개 · 확인{" "}
                {new Date(String(rotation.updatedAt)).toLocaleString()}
              </p>
              {rotation.status === "running" && (
                <button
                  type="button"
                  disabled={!x.can("secret.rotate")}
                  onClick={() =>
                    a.review({
                      label: "중단 지점부터 같은 키 회전 배치 재개",
                      path: "keyring/rotations",
                      method: "POST",
                      payload: { id: rotation.id, limit: 100 },
                      before: {
                        targetKeyId: rotation.targetKeyId,
                        status: rotation.status,
                        processed: rotation.processed,
                      },
                      stepUp: true,
                      success,
                    })
                  }
                >
                  같은 회전 작업의 다음 100건 검토
                </button>
              )}
            </article>
          ))}
        </>
      )}
      {tab === "privacy" && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              a.review({
                label: "정보 주체 자료 처리 요청",
                path: "privacy-requests",
                method: "POST",
                payload: {
                  subjectId: value(form, "subjectId"),
                  action: value(form, "action"),
                },
                stepUp: true,
                success,
              });
            }}
          >
            <label>
              확인된 정보 주체 ID
              <input name="subjectId" required maxLength={150} />
            </label>
            <label>
              요청 종류
              <select name="action">
                <option value="export">자료 내보내기</option>
                <option value="anonymize">익명화</option>
              </select>
            </label>
            <button disabled={!x.can("data.write")}>대상 자료 범위 검토</button>
          </form>
          {privacy.map((request) => (
            <article className="page-card" key={request.id}>
              <strong>
                {request.action} · {request.status}
              </strong>
              <p>{request.heldReason || "대상과 보존 규칙을 확인하세요."}</p>
              {Object.entries(request.counts).map(([key, count]) => (
                <p key={key}>
                  {key} {count}개
                </p>
              ))}
              <button
                type="button"
                disabled={
                  request.status === "completed" || !x.can("data.write")
                }
                onClick={() =>
                  a.review({
                    label: "확인된 개인정보 처리 실행",
                    path: `privacy-requests/${request.id}/run`,
                    method: "POST",
                    payload: { confirm: true },
                    before: {
                      counts: request.counts,
                      heldReason: request.heldReason,
                    },
                    stepUp: true,
                    success,
                  })
                }
              >
                실제 처리 검토
              </button>
            </article>
          ))}
        </>
      )}
      {tab === "lifecycle" && (
        <>
          <p>
            인계는 상대 계정의 수락을 확인합니다. 조직 보관은 신규 작업을
            중지하고 기존 거래·미확인 자료는 유지합니다.
          </p>
          {lifecycle && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                a.review({
                  label: "조직 운영 상태 변경",
                  path: "lifecycle",
                  method: "PUT",
                  payload: {
                    baseRevision: lifecycle.revision,
                    state: value(form, "state"),
                    reason: value(form, "reason"),
                  },
                  before: lifecycle,
                  stepUp: true,
                  success,
                });
              }}
            >
              <p>
                현재 {lifecycle.state} · v{lifecycle.revision}
              </p>
              <label>
                운영 상태
                <select name="state" defaultValue={lifecycle.state}>
                  <option value="active">운영</option>
                  <option value="archived">보관</option>
                  <option value="closing">종료 준비</option>
                </select>
              </label>
              <label>
                변경 사유
                <textarea name="reason" required maxLength={1000} />
              </label>
              <button disabled={!x.can("org.manage")}>변경 영향 검토</button>
            </form>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              a.review({
                label: "조직 소유권 인계 제안",
                path: "handoffs",
                method: "POST",
                payload: {
                  accountId: value(new FormData(e.currentTarget), "accountId"),
                },
                stepUp: true,
                success,
              });
            }}
          >
            <label>
              인계받을 현재 구성원 계정 ID
              <input name="accountId" required />
            </label>
            <button disabled={!x.can("org.manage")}>인계 제안 검토</button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const id = value(new FormData(e.currentTarget), "handoffId");
              a.review({
                label: "본인에게 제안된 조직 인계 수락",
                path: `handoffs/${encodeURIComponent(id)}/accept`,
                method: "POST",
                payload: {},
                stepUp: true,
                success,
              });
            }}
          >
            <label>
              받은 인계 제안 ID
              <input name="handoffId" required />
            </label>
            <button>본인 인계 수락 검토</button>
          </form>
        </>
      )}
      {tab === "catalog" && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              try {
                const manifest = record(
                  JSON.parse(value(form, "manifest")) as unknown,
                );
                a.review({
                  label: "선언형 확장 버전 승인 요청",
                  path: "catalog",
                  method: "POST",
                  payload: {
                    manifest,
                    license: value(form, "license"),
                    supportContact: value(form, "supportContact"),
                    evidence: value(form, "evidence"),
                  },
                  success,
                });
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "검증한 manifest를 확인하세요.",
                );
              }
            }}
          >
            <label>
              검증한 선언형 manifest
              <textarea name="manifest" required rows={6} maxLength={1000000} />
            </label>
            <label>
              라이선스
              <input name="license" required maxLength={200} />
            </label>
            <label>
              지원 연락처
              <input name="supportContact" required maxLength={500} />
            </label>
            <label>
              호환 검증 근거
              <textarea name="evidence" required maxLength={5000} />
            </label>
            <button disabled={!x.can("asset.manage")}>
              지원 범위 승인 요청 검토
            </button>
          </form>
          {catalog.map((item) => (
            <article className="page-card" key={item.id}>
              <strong>
                {item.packageId} {item.version} · {item.status}
              </strong>
              <p>
                {item.license} · {item.supportContact}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  a.review({
                    label: "확장 버전 검토·문제 버전 신규 설치 제한",
                    path: `catalog/${item.id}/review`,
                    method: "POST",
                    payload: {
                      status: value(form, "status"),
                      evidence: value(form, "evidence"),
                    },
                    before: item,
                    stepUp: true,
                    success,
                  });
                }}
              >
                <label>
                  검토 결과
                  <select name="status">
                    <option value="approved">검증된 버전 승인</option>
                    <option value="revoked">문제 버전 회수</option>
                  </select>
                </label>
                <label>
                  검토 근거
                  <textarea name="evidence" required maxLength={5000} />
                </label>
                <button disabled={!x.can("review.approve")}>
                  실제 검토 결과 적용 검토
                </button>
              </form>
            </article>
          ))}
        </>
      )}
      {tab === "usage" && (
        <Suspense
          fallback={<p role="status">사용량·금액 원장을 확인하는 중…</p>}
        >
          <SystemLedgerPanel studio={s} expansion={x} />
        </Suspense>
      )}
      {result && (
        <details open>
          <summary>서버가 확인한 결과</summary>
          <dl>
            {Object.entries(result)
              .filter(
                ([key, val]) =>
                  !/[Tt]oken|[Ss]ecret|password|ciphertext|data|records|files/.test(
                    key,
                  ) && ["string", "number", "boolean"].includes(typeof val),
              )
              .map(([key, val]) => (
                <div key={key}>
                  <dt>
                    {key === "artifactChecks"
                      ? "산출물 실제 복원·보존 검사"
                      : key}
                  </dt>
                  <dd>{String(val)}</dd>
                </div>
              ))}
          </dl>
          <p>세부 실행·외부 전달·활성화 결과는 관련 업무에서 확인합니다.</p>
        </details>
      )}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {a.dialog}
      {onceToken && (
        <EditorDialog
          title="기계 계정 키 · 일회 표시"
          onClose={() => setOnceToken("")}
        >
          <p>
            키를 안전한 서버 비밀 저장소에 보관하세요. 다시 조회할 수 없습니다.
          </p>
          <code>{onceToken}</code>
          <button type="button" onClick={() => setOnceToken("")}>
            보관했고 닫기
          </button>
        </EditorDialog>
      )}
    </section>
  );
}
