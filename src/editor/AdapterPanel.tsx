import { useEffect, useState, type FormEvent } from "react";
import type { ProviderAdapter } from "../domain/expansion";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import { parseMappedData, type DataRow } from "../infrastructure/mappedData";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import ExternalDataImport from "./ExternalDataImport";
import EditorDialog from "./EditorDialog";
export default function AdapterPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const [adapters, setAdapters] = useState<ProviderAdapter[]>([]),
    [editing, setEditing] = useState<ProviderAdapter | null>(null),
    [connections, setConnections] = useState<
      { id: string; name: string; kind: string }[]
    >([]),
    [execution, setExecution] = useState<{
      adapter: ProviderAdapter;
      connectionId: string;
      payload: string;
      key: string;
    } | null>(null),
    [data, setData] = useState<ReturnType<typeof parseMappedData> | null>(null),
    [importRows, setImportRows] = useState<DataRow[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function refresh() {
    try {
      const [a, c] = await Promise.all([
        x.request<ProviderAdapter[]>("adapters"),
        api<unknown>(`/api/platform/connections?projectId=${s.project.id}`),
      ]);
      setAdapters(a);
      if (!Array.isArray(c)) throw new Error("연결 목록 계약을 확인하세요.");
      setConnections(
        c.map(record).map((v) => {
          if (
            typeof v.id !== "string" ||
            typeof v.name !== "string" ||
            typeof v.kind !== "string"
          )
            throw new Error("연결 메타데이터 계약을 확인하세요.");
          return { id: v.id, name: v.name, kind: v.kind };
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "어댑터 범위를 확인하세요.");
    }
  }
  useEffect(() => {
    void refresh();
  }, [s.project.id, x.environmentId, x.scope?.organizationId]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "공급자 계약을 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = new FormData(e.currentTarget);
    await run(async () => {
      const mapping = record(
        JSON.parse(String(values.get("mapping"))) as unknown,
      );
      if (Object.values(mapping).some((v) => typeof v !== "string"))
        throw new Error("매핑 경로는 문자열로 입력하세요.");
      await x.request(
        editing ? `adapters/${editing.id}` : "adapters",
        editing ? "PUT" : "POST",
        {
          organizationId: x.scope?.organizationId,
          name: values.get("name"),
          kind: values.get("kind"),
          mapping,
          ...(editing ? { baseVersion: editing.version } : {}),
        },
      );
      setEditing(null);
      s.setMessage("공급자 어댑터 계약을 저장했습니다.");
    });
  }
  return (
    <details className="expansion-panel">
      <summary>공급자 표시·전송 매핑 계약</summary>
      <form key={editing?.id || "new"} onSubmit={save}>
        <label>
          어댑터 이름
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={editing?.name || ""}
          />
        </label>
        <label>
          공급자 종류
          <select name="kind" defaultValue={editing?.kind || "data"}>
            {[
              ["data", "외부 자료"],
              ["mail", "메일"],
              ["crm", "CRM"],
              ["payment", "결제 전용 계약"],
            ].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          표시 필드 → 원본 경로 매핑 JSON
          <textarea
            name="mapping"
            defaultValue={JSON.stringify(editing?.mapping || {}, null, 2)}
            maxLength={16000}
            rows={4}
          />
        </label>
        <p className="hint">
          각 필드를 자료 경로에 연결합니다. 예: title에 product.name 경로를
          지정합니다. 실행 코드는 입력하지 않습니다.
        </p>
        <button disabled={busy || !x.can("connection.manage")}>
          {editing ? "현재 버전 기준 매핑 저장" : "어댑터 계약 등록"}
        </button>
        <button type="button" onClick={() => setEditing(null)}>
          새 계약 입력
        </button>
      </form>
      {adapters.map((adapter) => (
        <article className="page-card" key={adapter.id}>
          <strong>
            {adapter.name} · v{adapter.version} · {adapter.kind}
          </strong>
          <p>
            {Object.entries(adapter.mapping)
              .map(([key, path]) => `${key} ← ${path}`)
              .join(" · ") || "연결의 기본 자료 사용"}
          </p>
          <button type="button" onClick={() => setEditing(adapter)}>
            계약 편집
          </button>
          <button
            type="button"
            disabled={!x.can("connection.use") || adapter.kind === "payment"}
            onClick={() => {
              setData(null);
              setExecution({
                adapter,
                connectionId: "",
                payload: "{}",
                key: crypto.randomUUID(),
              });
            }}
          >
            연결 실제 실행 검토
          </button>
          {adapter.kind === "payment" && (
            <p className="hint">
              결제는 서버 주문·구독 경로에서 금액과 공급자 상태를 검사합니다.
            </p>
          )}
        </article>
      ))}
      {!adapters.length && <p>조직의 어댑터 계약이 없습니다.</p>}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {execution && (
        <EditorDialog
          title="공급자 계약 실제 조회·발송 검토"
          onClose={() => setExecution(null)}
        >
          <p>
            {execution.adapter.name} v{execution.adapter.version} · 환경{" "}
            {x.environmentId || "기본"}
          </p>
          <label>
            같은 종류의 연결
            <select
              value={execution.connectionId}
              onChange={(e) =>
                setExecution({ ...execution, connectionId: e.target.value })
              }
            >
              <option value="">선택하세요</option>
              {connections
                .filter((c) => c.kind === execution.adapter.kind)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          {execution.adapter.kind !== "data" && (
            <label>
              발송 원본 자료 JSON
              <textarea
                value={execution.payload}
                onChange={(e) =>
                  setExecution({ ...execution, payload: e.target.value })
                }
                maxLength={100000}
              />
            </label>
          )}
          <p>
            요청 키 {execution.key}를 재시도에 유지합니다. 발송은 실제 outbox에
            등록되며 공급자 수락과 수신 완료는 구분합니다.
          </p>
          <button
            type="button"
            disabled={busy || !execution.connectionId}
            onClick={() =>
              void run(async () => {
                const result = await x.request<unknown>(
                  `adapters/${execution.adapter.id}/execute`,
                  "POST",
                  {
                    projectId: s.project.id,
                    connectionId: execution.connectionId,
                    payload: record(JSON.parse(execution.payload) as unknown),
                    key: execution.key,
                    refresh: true,
                  },
                );
                if (execution.adapter.kind === "data")
                  setData(parseMappedData(result));
                else {
                  s.setMessage(
                    "매핑된 발송 자료를 실제 outbox에 등록했습니다. 연결·발송에서 공급자 상태를 확인하세요.",
                  );
                  setExecution(null);
                }
              })
            }
          >
            {execution.adapter.kind === "data"
              ? "실제 자료 조회"
              : "검토한 자료 발송 작업 등록"}
          </button>
          {data && (
            <>
              <p>
                {data.rows.length}행 · {data.cached ? "캐시" : "조회"} ·{" "}
                {data.fetchedAt
                  ? new Date(data.fetchedAt).toLocaleString()
                  : "서버 시각 미제공"}
              </p>
              <div className="csv-preview">
                <table>
                  <tbody>
                    {data.rows.slice(0, 10).map((row, i) => (
                      <tr key={i}>
                        {Object.entries(row).map(([key, value]) => (
                          <td key={key}>
                            <strong>{key}</strong>: {String(value ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                disabled={!data.rows.length || !s.editable}
                onClick={() => {
                  setImportRows(data.rows);
                  setExecution(null);
                }}
              >
                표 초기 자료 적용 검토
              </button>
            </>
          )}
        </EditorDialog>
      )}
      {importRows && (
        <ExternalDataImport
          studio={s}
          records={importRows}
          onClose={() => setImportRows(null)}
        />
      )}
    </details>
  );
}
