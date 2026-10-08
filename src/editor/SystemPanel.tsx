import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import type {
  ConfigSnapshot,
  ConfigChange,
  FeatureFlag,
  SecurityStatus,
  SecretVersion,
  AuditEntry,
} from "../domain/advancement";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import { useSystemActions } from "./useSystemActions";
import EditorDialog from "./EditorDialog";
import JournalPanel from "./JournalPanel";
const SystemRuntimePanel = lazy(() => import("./SystemRuntimePanel"));
const SystemOperationsPanel = lazy(() => import("./SystemOperationsPanel"));
const SystemCapacityPanel = lazy(() => import("./SystemCapacityPanel"));
const SystemObservabilityPanel = lazy(
  () => import("./SystemObservabilityPanel"),
);
export default function SystemPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const a = useSystemActions(s, x),
    [tab, setTab] = useState("config"),
    [config, setConfig] = useState<ConfigSnapshot | null>(null),
    [flags, setFlags] = useState<FeatureFlag[]>([]),
    [security, setSecurity] = useState<SecurityStatus | null>(null),
    [versions, setVersions] = useState<SecretVersion[]>([]),
    [audit, setAudit] = useState<AuditEntry[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [enrollment, setEnrollment] = useState<{
      secret: string;
      otpauthUrl: string;
      expiresAt: string;
    } | null>(null),
    [codes, setCodes] = useState<string[]>([]),
    [enrollCode, setEnrollCode] = useState("");
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
      const route =
        tab === "config"
          ? "config"
          : tab === "flags"
            ? "flags"
            : tab === "security"
              ? "security"
              : tab === "secrets"
                ? "secrets/versions"
                : "audit";
      if (["runtime", "operations", "capacity", "observability"].includes(tab))
        return;
      const raw = await api<unknown>(a.endpoint(route));
      if (scope !== currentScope.current || request !== requestSequence.current)
        return;
      if (tab === "config") {
        const item = record(raw);
        if (typeof item.revision !== "number" || !item.config)
          throw new Error("설정 응답 형식을 확인하세요.");
        setConfig(raw as ConfigSnapshot);
      } else if (tab === "security") {
        const item = record(raw);
        if (typeof item.enabled !== "boolean")
          throw new Error("인증 상태 형식을 확인하세요.");
        setSecurity(raw as SecurityStatus);
      } else {
        if (!Array.isArray(raw))
          throw new Error("목록 응답 형식을 확인하세요.");
        if (tab === "flags") setFlags(raw as FeatureFlag[]);
        if (tab === "secrets") setVersions(raw as SecretVersion[]);
        if (tab === "audit") setAudit(raw as AuditEntry[]);
      }
    } catch (e) {
      if (scope !== currentScope.current || request !== requestSequence.current)
        return;
      setError(
        e instanceof Error ? e.message : "시스템 상태를 조회하지 못했습니다.",
      );
    } finally {
      if (scope === currentScope.current && request === requestSequence.current)
        setBusy(false);
    }
  }
  useEffect(() => {
    setConfig(null);
    setFlags([]);
    setVersions([]);
    setAudit([]);
    setEnrollment(null);
    setCodes([]);
    void refresh();
    return () => {
      requestSequence.current++;
    };
  }, [tab, s.project.id, x.environmentId]);
  async function prepareConfig(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!config) return;
    const scope = scopeKey;
    setBusy(true);
    try {
      const input = new FormData(e.currentTarget),
        next = record(JSON.parse(String(input.get("config"))) as unknown),
        preview = await api<ConfigChange>(
          a.endpoint("config/changes"),
          "POST",
          { baseRevision: config.revision, config: next },
        );
      if (scope !== currentScope.current) return;
      a.review({
        label: "환경 설정 새 버전 적용",
        path: `config/changes/${preview.id}/apply`,
        method: "POST",
        payload: { approvalFingerprint: preview.approvalFingerprint },
        before: config.config,
        after: preview.config,
        success: async () => {
          await x.refresh();
          await refresh();
        },
      });
    } catch (e) {
      if (scope !== currentScope.current) return;
      setError(
        e instanceof Error ? e.message : "환경 설정을 검토하지 못했습니다.",
      );
    } finally {
      if (scope === currentScope.current) setBusy(false);
    }
  }
  return (
    <details className="system-panel expansion-panel">
      <summary>시스템 고도화·안전한 변경</summary>
      <JournalPanel studio={s} />
      <div className="panel-tabs">
        {[
          ["config", "환경 변경"],
          ["flags", "기능 중지"],
          ["security", "추가 인증"],
          ["secrets", "비밀 회전"],
          ["audit", "감사 이력"],
          ["operations", "복구·관리"],
          ["runtime", "릴리스·실험"],
          ["capacity", "용량·이전"],
          ["observability", "추적·알림"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={tab === id}
            onClick={() => setTab(id!)}
          >
            {label}
          </button>
        ))}
      </div>
      {!["runtime", "operations", "capacity", "observability"].includes(
        tab,
      ) && (
        <button
          type="button"
          disabled={busy || !x.scope}
          onClick={() => void refresh()}
        >
          {busy ? "서버 상태 확인 중…" : "선택 환경 실제 상태 새로고침"}
        </button>
      )}
      {tab === "config" && config && (
        <form key={config.revision} onSubmit={(e) => void prepareConfig(e)}>
          <p>
            설정 v{config.revision} · 검토 후 다른 변경이 발생하면 다시
            검토합니다.
          </p>
          <label>
            일반 환경 설정
            <textarea
              name="config"
              rows={8}
              defaultValue={JSON.stringify(config.config, null, 2)}
              maxLength={64000}
            />
          </label>
          <p>비밀 원문을 입력하지 않고 TENANT_ 참조만 사용합니다.</p>
          <button disabled={busy || !x.can("project.publish")}>
            설정 영향 검토
          </button>
        </form>
      )}
      {tab === "flags" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const values = new FormData(e.currentTarget),
              key = String(values.get("key")),
              current = flags.find((item) => item.key === key),
              expires = String(values.get("expires"));
            a.review({
              label: "선택 환경의 신규 기능 실행 변경",
              path: `flags/${key}`,
              method: "PUT",
              before: current || {},
              payload: {
                baseRevision: current?.revision || 0,
                enabled: values.get("enabled") === "on",
                reason: values.get("reason"),
                ...(expires
                  ? { expiresAt: new Date(expires).toISOString() }
                  : {}),
              },
              success: refresh,
            });
          }}
        >
          <label>
            신규 작업 종류
            <select name="key">
              {[
                ["publication", "새 발행"],
                ["automation", "자동화"],
                ["paid-actions", "비용 작업"],
                ["external-writes", "외부 쓰기"],
                ["ai", "AI 요청"],
              ].map(([id, label]) => (
                <option value={id} key={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input name="enabled" type="checkbox" defaultChecked />
            신규 실행 허용
          </label>
          <label>
            변경 사유
            <textarea name="reason" required maxLength={1000} />
          </label>
          <label>
            제한 만료 시각
            <input name="expires" type="datetime-local" />
          </label>
          <p>
            기존 정상 사이트 조회와 복구·대사는 유지합니다. 이미 전달한 외부
            효과를 취소하지 않습니다.
          </p>
          <button disabled={!x.can("project.publish")}>기능 변경 검토</button>
          {flags.map((flag) => (
            <p key={flag.key}>
              {flag.key} · {flag.enabled ? "신규 실행 허용" : "신규 실행 중지"}{" "}
              · v{flag.revision} · {flag.reason}
            </p>
          ))}
        </form>
      )}
      {tab === "security" && (
        <>
          <p>
            {security?.enabled
              ? `인증 앱 등록됨 · 복구 코드 ${security.recoveryCodesRemaining}개`
              : "인증 앱 미등록"}{" "}
            ·{" "}
            {security?.stepUpRequired
              ? "관리형 고위험 작업에 일회성 추가 인증 필요"
              : "로컬 소유자 작업"}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                values = new FormData(form),
                scope = scopeKey;
              setBusy(true);
              void api<{
                secret: string;
                otpauthUrl: string;
                expiresAt: string;
              }>(a.endpoint("security/enrollment"), "POST", {
                password: values.get("password"),
                ...(security?.enabled ? { code: values.get("code") } : {}),
              })
                .then((result) => {
                  if (scope === currentScope.current) setEnrollment(result);
                })
                .catch((e) => {
                  if (scope === currentScope.current)
                    setError(
                      e instanceof Error
                        ? e.message
                        : "인증 앱 등록을 확인하세요.",
                    );
                })
                .finally(() => {
                  form.reset();
                  if (scope === currentScope.current) setBusy(false);
                });
            }}
          >
            <label>
              제작자 비밀번호
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            {security?.enabled && (
              <label>
                기존 인증 앱 코드
                <input
                  name="code"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  required
                />
              </label>
            )}
            <button disabled={busy || x.session.localOwner}>
              인증 앱 등록·교체 준비
            </button>
          </form>
        </>
      )}
      {tab === "secrets" && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                values = new FormData(form);
              a.review({
                label: "환경 비밀 새 버전 등록",
                path: "secrets/versions",
                method: "POST",
                payload: {
                  name: values.get("name"),
                  value: values.get("value"),
                },
                stepUp: true,
                success: refresh,
              });
              form.reset();
            }}
          >
            <label>
              비밀 참조
              <input
                name="name"
                pattern="TENANT_[A-Z0-9_]+"
                required
                maxLength={80}
              />
            </label>
            <label>
              새 비밀값
              <input
                name="value"
                type="password"
                autoComplete="off"
                required
                maxLength={16000}
              />
            </label>
            <button disabled={!x.can("secret.rotate")}>
              새 버전 등록 검토
            </button>
          </form>
          {versions.map((version) => (
            <article className="page-card" key={version.id}>
              <strong>
                {version.name} · v{version.version} · {version.status}
              </strong>
              <small>키 버전 {version.keyId}</small>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const values = new FormData(e.currentTarget);
                  a.review({
                    label: "등록한 비밀 버전 실제 연결 시험",
                    path: `secrets/versions/${version.id}/test`,
                    method: "POST",
                    payload: { connectionId: values.get("connectionId") },
                    stepUp: true,
                    success: refresh,
                  });
                }}
              >
                <label>
                  이 환경의 실제 연결 ID
                  <input name="connectionId" required />
                </label>
                <button
                  disabled={
                    !x.can("secret.rotate") || version.status === "retired"
                  }
                >
                  연결 시험 검토
                </button>
              </form>
              <div className="button-row">
                {["activate", "retire"].map((operation) => (
                  <button
                    key={operation}
                    type="button"
                    disabled={!x.can("secret.rotate")}
                    onClick={() =>
                      a.review({
                        label:
                          operation === "activate"
                            ? "시험한 새 비밀 활성화"
                            : "미사용 이전 비밀 버전 폐기",
                        path: `secrets/versions/${version.id}/${operation}`,
                        method: "POST",
                        payload: {},
                        stepUp: true,
                        success: refresh,
                      })
                    }
                  >
                    {operation === "activate" ? "활성화 검토" : "폐기 검토"}
                  </button>
                ))}
              </div>
            </article>
          ))}
          {!versions.length && <p>이 환경의 등록된 비밀 버전이 없습니다.</p>}
        </>
      )}
      {tab === "audit" && (
        <>
          <p>
            변경 전후 버전과 연결된 감사 기록입니다. 비밀 원문과 개인정보 원문을
            표시하지 않습니다.
          </p>
          {audit.map((entry) => (
            <article className="page-card" key={entry.sequence}>
              <strong>
                #{entry.sequence} · {entry.operation} · {entry.status}
              </strong>
              <small>
                {entry.beforeRevision ?? "—"} → {entry.afterRevision ?? "—"} ·{" "}
                {new Date(entry.createdAt).toLocaleString()}
              </small>
              <details>
                <summary>연결 지문</summary>
                <code>
                  {entry.previousHash} → {entry.hash}
                </code>
              </details>
            </article>
          ))}
          {!audit.length && (
            <p>현재 조직에서 조회 가능한 감사 기록이 없습니다.</p>
          )}
        </>
      )}
      <Suspense fallback={<p role="status">시스템 업무를 불러오는 중…</p>}>
        {tab === "runtime" && <SystemRuntimePanel studio={s} expansion={x} />}{" "}
        {tab === "operations" && (
          <SystemOperationsPanel studio={s} expansion={x} />
        )}
        {tab === "capacity" && <SystemCapacityPanel studio={s} expansion={x} />}
        {tab === "observability" && (
          <SystemObservabilityPanel studio={s} expansion={x} />
        )}
      </Suspense>
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {a.dialog}
      {enrollment && (
        <EditorDialog
          title="인증 앱 등록 · 비밀을 안전하게 보관"
          onClose={() => setEnrollment(null)}
        >
          <p>
            아래 키를 인증 앱에 등록하고 현재 코드를 입력하세요. 키는 이
            화면에서만 제공됩니다. 만료{" "}
            {new Date(enrollment.expiresAt).toLocaleString()}
          </p>
          <code>{enrollment.secret}</code>
          <a href={enrollment.otpauthUrl}>인증 앱에서 등록 열기</a>
          <label>
            새 인증 앱 코드
            <input
              value={enrollCode}
              onChange={(e) => setEnrollCode(e.target.value)}
              autoComplete="one-time-code"
              maxLength={6}
            />
          </label>
          <button
            disabled={busy || !/^\d{6}$/.test(enrollCode)}
            onClick={() => {
              setBusy(true);
              void api<{ recoveryCodes: string[] }>(
                a.endpoint("security/enrollment/confirm"),
                "POST",
                { code: enrollCode },
              )
                .then((result) => {
                  setEnrollment(null);
                  setEnrollCode("");
                  setCodes(result.recoveryCodes);
                  void refresh();
                })
                .catch((e) =>
                  setError(
                    e instanceof Error
                      ? e.message
                      : "등록 확인을 다시 시도하세요.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            등록 확인·복구 코드 발급
          </button>
          {error && <p role="alert">{error}</p>}
        </EditorDialog>
      )}
      {codes.length > 0 && (
        <EditorDialog
          title="일회용 복구 코드 · 지금 보관"
          onClose={() => setCodes([])}
        >
          <p>
            다시 조회할 수 없습니다. 인증 앱을 잃으면 한 코드를 한 번
            사용합니다. 다른 사람과 공유하지 마세요.
          </p>
          <ul>
            {codes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setCodes([])}>
            안전하게 보관했고 닫기
          </button>
        </EditorDialog>
      )}
    </details>
  );
}
