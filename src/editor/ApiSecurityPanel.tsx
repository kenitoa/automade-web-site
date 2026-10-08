import { useEffect, useState, type FormEvent } from "react";
import type {
  ApiCredential,
  ExpansionCapability,
  ExpansionSecret,
  SecretAuditEntry,
} from "../domain/expansion";
import type { ExpansionState } from "./useExpansion";
import type { StudioState } from "./useStudio";
import EditorDialog from "./EditorDialog";
const choices: [ExpansionCapability, string][] = [
  ["project.read", "원본 읽기"],
  ["project.edit", "원본 편집"],
  ["project.publish", "사이트 생성"],
  ["data.read", "콘텐츠·자료 읽기"],
  ["data.write", "업무 자료 변경"],
  ["connection.use", "승인된 연결 사용"],
  ["automation.manage", "자동화 이벤트 실행"],
];
export default function ApiSecurityPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const [credentials, setCredentials] = useState<ApiCredential[]>([]),
    [secrets, setSecrets] = useState<ExpansionSecret[]>([]),
    [audit, setAudit] = useState<SecretAuditEntry[]>([]),
    [issued, setIssued] = useState<
      (ApiCredential & { token: string; webhookSecret: string }) | null
    >(null),
    [rotate, setRotate] = useState<ExpansionSecret | null>(null),
    [capabilities, setCapabilities] = useState<ExpansionCapability[]>([
      "project.read",
    ]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function refresh() {
    const results = await Promise.allSettled([
      x.request<ApiCredential[]>("credentials"),
      x.request<ExpansionSecret[]>("secrets"),
      x.request<SecretAuditEntry[]>("secrets/audit"),
    ]);
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        if (i === 0) setCredentials(result.value as ApiCredential[]);
        else if (i === 1) setSecrets(result.value as ExpansionSecret[]);
        else setAudit(result.value as SecretAuditEntry[]);
      } else if (x.can(i ? "secret.rotate" : "connection.manage"))
        setError(
          result.reason instanceof Error
            ? result.reason.message
            : "접근 설정을 확인하세요.",
        );
    });
  }
  useEffect(() => {
    void refresh();
  }, [s.project.id, x.scope?.organizationId, x.environmentId]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "접근 설정을 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  async function issue(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    if (
      !confirm(
        "선택한 사이트·환경 범위에 만료되는 API 키를 발급합니다. 토큰과 웹훅 비밀은 한 번만 표시합니다.",
      )
    )
      return;
    await run(async () => {
      setIssued(
        await x.request<
          ApiCredential & { token: string; webhookSecret: string }
        >("credentials", "POST", {
          projectId: s.project.id,
          name: String(data.get("name")),
          capabilities,
          expiresAt: new Date(String(data.get("expiresAt"))).toISOString(),
        }),
      );
    });
  }
  async function saveSecret(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form);
    await run(async () => {
      await x.request(
        rotate ? `secrets/${rotate.id}` : "secrets",
        rotate ? "PUT" : "POST",
        {
          organizationId: x.scope?.organizationId,
          workspaceId: data.get("workspaceId") || undefined,
          name: data.get("name"),
          value: data.get("value"),
          ...(rotate ? { baseVersion: rotate.version } : {}),
        },
      );
      form.reset();
      setRotate(null);
      s.setMessage(
        "암호화된 비밀 참조를 저장했습니다. 원문을 다시 조회할 수 없습니다.",
      );
    });
  }
  return (
    <section className="expansion-panel">
      <h3>API 접근·비밀 참조</h3>
      <a href="/api/expansion/openapi" target="_blank" rel="noreferrer">
        범위 API OpenAPI 계약 열기 ↗
      </a>
      <p className="hint">
        현재 사이트·환경의 보유 권한 안에서 발급합니다. 키를 회수하거나 발급자
        권한을 회수하면 서버에서 차단합니다.
      </p>
      <form onSubmit={issue}>
        <button
          type="button"
          onClick={() => {
            setCapabilities(["project.read", "data.read"]);
            s.setMessage(
              "지원용 읽기 범위를 선택했습니다. 이름과 짧은 만료 시각을 입력하고 발급 범위를 검토하세요.",
            );
          }}
        >
          기간 제한 지원용 읽기 범위 선택
        </button>
        <label>
          API 키 이름
          <input name="name" required maxLength={100} />
        </label>
        <label>
          만료 시각 · 90일 이내
          <input name="expiresAt" type="datetime-local" required />
        </label>
        {choices.map(([cap, label]) => (
          <label className="check" key={cap}>
            <input
              type="checkbox"
              checked={capabilities.includes(cap)}
              disabled={!x.can(cap)}
              onChange={(e) =>
                setCapabilities((list) =>
                  e.target.checked
                    ? [...list, cap]
                    : list.filter((v) => v !== cap),
                )
              }
            />
            {label}
          </label>
        ))}
        <button
          disabled={busy || !capabilities.length || !x.can("connection.manage")}
        >
          발급 범위 검토 후 키 생성
        </button>
      </form>
      {credentials.map((item) => (
        <article className="page-card" key={item.id}>
          <strong>
            {item.name} · {item.revoked ? "회수됨" : "유효 기간 확인"}
          </strong>
          <small>
            {item.id} · 만료 {new Date(item.expiresAt).toLocaleString()} · 환경{" "}
            {item.scope.environmentId || "기본"}
          </small>
          <p>
            {item.capabilities
              .map((c) => choices.find(([id]) => id === c)?.[1] || c)
              .join(" · ")}
          </p>
          <button
            type="button"
            disabled={busy || item.revoked || !x.can("connection.manage")}
            onClick={() => {
              if (
                !confirm(
                  `${item.name} API 키를 회수합니다. 이 키로 실행하는 자동화가 차단됩니다.`,
                )
              )
                return;
              void run(async () => {
                await x.request(`credentials/${item.id}`, "DELETE");
              });
            }}
          >
            API 키 회수
          </button>
        </article>
      ))}
      {!credentials.length && <p>이 범위의 API 키가 없습니다.</p>}
      <details>
        <summary>조직 비밀 참조 생성·교체</summary>
        <p className="hint">
          서버 EXPANSION_SECRET_KEY 설정이 필요합니다. 원문은 입력 시에만
          전송하며 문서·IndexedDB·로그에 저장하지 않습니다. 운영 연결에는
          TENANT_ 참조 이름을 사용합니다.
        </p>
        <form key={rotate?.id || "new"} onSubmit={saveSecret}>
          <label>
            비밀 참조 이름
            <input
              name="name"
              defaultValue={rotate?.name || "TENANT_"}
              pattern="TENANT_[A-Z0-9_]{1,72}"
              required
              maxLength={80}
            />
          </label>
          <label>
            사용 범위
            <select name="workspaceId" defaultValue={rotate?.workspaceId || ""}>
              <option value="">조직 공용</option>
              {x.bootstrap?.workspaces
                .filter((w) => w.organizationId === x.scope?.organizationId)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            새 비밀 원문
            <input
              type="password"
              name="value"
              autoComplete="new-password"
              required
              maxLength={16000}
            />
          </label>
          <button disabled={busy || !x.can("secret.rotate")}>
            {rotate
              ? `v${rotate.version} 기준으로 새 비밀 교체`
              : "암호화 저장소에 참조 생성"}
          </button>
          <button type="button" onClick={() => setRotate(null)}>
            새 참조 입력
          </button>
        </form>
      </details>
      {secrets.map((secret) => (
        <article className="page-card" key={secret.id}>
          <strong>
            {secret.name} · v{secret.version} ·{" "}
            {secret.disabled ? "사용 중지" : "참조 활성"}
          </strong>
          <small>
            {secret.workspaceId ? "작업 공간 범위" : "조직 공용"} ·{" "}
            {secret.configured ? "암호화 저장소 설정 확인" : "저장소 키 미설정"}
          </small>
          <button
            type="button"
            disabled={busy || !x.can("secret.rotate")}
            onClick={() => setRotate(secret)}
          >
            새 비밀 교체 입력
          </button>
          <button
            type="button"
            disabled={busy || secret.disabled || !x.can("secret.rotate")}
            onClick={() => {
              if (
                !confirm(
                  `${secret.name} 참조를 중지합니다. 이를 사용하는 연결 요청이 차단될 수 있습니다.`,
                )
              )
                return;
              void run(async () => {
                await x.request(`secrets/${secret.id}`, "DELETE");
              });
            }}
          >
            참조 사용 중지
          </button>
        </article>
      ))}
      <details>
        <summary>비밀 접근 감사 기록</summary>
        {audit.map((entry) => (
          <p key={entry.id}>
            {new Date(entry.createdAt).toLocaleString()} · {entry.operation} ·{" "}
            {entry.actorId} · {entry.status} · 참조 {entry.secretId}
          </p>
        ))}
        {!audit.length && <p>조회 가능한 기록이 없습니다.</p>}
      </details>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        접근 설정 새로고침
      </button>
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {issued && (
        <EditorDialog
          title="발급된 API 키 · 한 번 표시"
          onClose={() => setIssued(null)}
        >
          <p>
            {issued.name} · 환경 {issued.scope.environmentId || "기본"} · 만료{" "}
            {new Date(issued.expiresAt).toLocaleString()}
          </p>
          <label>
            Bearer 토큰
            <input readOnly value={issued.token} autoComplete="off" />
          </label>
          <label>
            웹훅 서명 비밀
            <input readOnly value={issued.webhookSecret} autoComplete="off" />
          </label>
          <p>
            안전한 비밀 저장소에 보관하세요. 닫은 뒤 다시 조회할 수 없으며 다시
            필요하면 회수하고 새 키를 발급합니다. 브라우저 저장소에는 보관하지
            않습니다.
          </p>
          <button type="button" onClick={() => setIssued(null)}>
            안전한 보관 확인·닫기
          </button>
        </EditorDialog>
      )}
    </section>
  );
}
