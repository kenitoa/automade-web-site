import { useEffect, useState } from "react";
import type { DataBinding } from "../domain/types";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import { parseMappedData } from "../infrastructure/mappedData";
import { projectBlockDefinition } from "../domain/blockRegistry";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import EditorDialog from "./EditorDialog";
import ChangeReview from "./ChangeReview";
export default function DataBindingPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const b = s.selectedBlock,
    [connectionId, setConnectionId] = useState(""),
    [limit, setLimit] = useState(20),
    [mapping, setMapping] = useState<DataBinding["mapping"]>({
      title: "title",
      body: "body",
    }),
    [connections, setConnections] = useState<{ id: string; name: string }[]>(
      [],
    ),
    [data, setData] = useState<ReturnType<typeof parseMappedData> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [review, setReview] = useState<{
      blockId: string;
      revision: number;
      binding: DataBinding;
    } | null>(null);
  useEffect(() => {
    setConnectionId(b?.props.dataBinding?.connectionId || "");
    setLimit(b?.props.dataBinding?.limit || 20);
    setMapping(
      structuredClone(
        b?.props.dataBinding?.mapping || { title: "title", body: "body" },
      ),
    );
    setData(null);
  }, [b?.id]);
  useEffect(() => {
    void api<unknown>(`/api/platform/connections?projectId=${s.project.id}`)
      .then((value) => {
        if (!Array.isArray(value))
          throw new Error("연결 목록 계약을 확인하세요.");
        setConnections(
          value
            .map(record)
            .filter((v) => v.kind === "data")
            .map((v) => {
              if (typeof v.id !== "string" || typeof v.name !== "string")
                throw new Error("자료 연결 계약을 확인하세요.");
              return { id: v.id, name: v.name };
            }),
        );
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "연결 권한을 확인하세요."),
      );
  }, [s.project.id, x.environmentId]);
  if (
    !b ||
    !(
      projectBlockDefinition(s.project, b)?.propertyProfile === "items" ||
      b.type === "chart"
    )
  )
    return null;
  const binding = { connectionId, limit, mapping },
    headers = [...new Set(data?.rows.flatMap((row) => Object.keys(row)) || [])];
  async function inspect() {
    setBusy(true);
    setError("");
    try {
      setData(
        parseMappedData(
          await api<unknown>(
            `/api/platform/connections/${encodeURIComponent(connectionId)}/data?projectId=${s.project.id}&limit=${limit}`,
          ),
        ),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "실시간 자료 연결을 확인하세요.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="data-binding-panel">
      <summary>실시간 외부 자료 연결</summary>
      <p className="hint">
        승인된 연결 ID와 표시 필드를 연결합니다. 실행 사이트에서 실제 조회하며
        상태와 시각을 표시합니다.
      </p>
      <label>
        자료 연결
        <select
          value={connectionId}
          onChange={(e) => {
            setConnectionId(e.target.value);
            setData(null);
          }}
        >
          <option value="">선택하세요</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        한 번에 표시할 자료
        <input
          type="number"
          min={1}
          max={100}
          value={limit}
          onChange={(e) =>
            setLimit(Math.min(100, Math.max(1, Number(e.target.value))))
          }
        />
      </label>
      <button
        type="button"
        disabled={busy || !connectionId || !x.can("connection.use")}
        onClick={() => void inspect()}
      >
        실제 조회·필드 확인
      </button>
      {data && (
        <>
          <p>
            {data.rows.length}행 · {data.cached ? "서버 캐시" : "서버 조회"} ·{" "}
            {data.fetchedAt
              ? new Date(data.fetchedAt).toLocaleString()
              : "서버 조회시각 미제공"}
          </p>
          {!data.rows.length && <p>조회 자료가 없습니다.</p>}
          <div className="csv-preview">
            <table>
              <thead>
                <tr>
                  {headers.map((header) => (
                    <th key={header}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.slice(0, 5).map((row, i) => (
                  <tr key={i}>
                    {headers.map((header) => (
                      <td key={header}>{String(row[header] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {(["title", "body", "image", "label", "value"] as const).map((key) => (
        <label key={key}>
          {
            {
              title: "제목 필드",
              body: "본문 필드",
              image: "문서 이미지 ID 필드",
              label: "차트 항목 필드",
              value: "차트 숫자 필드",
            }[key]
          }
          <select
            value={mapping[key] || ""}
            onChange={(e) =>
              setMapping((map) => ({
                ...map,
                [key]: e.target.value || undefined,
              }))
            }
          >
            <option value="">연결하지 않음</option>
            {[
              ...new Set(
                [mapping[key], ...headers].filter((v): v is string =>
                  Boolean(v),
                ),
              ),
            ].map((field) => (
              <option key={field} value={field}>
                {field}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button
        type="button"
        disabled={busy || !s.editable || !connectionId || !data}
        onClick={() =>
          setReview({ blockId: b.id, revision: s.project.revision, binding })
        }
      >
        실시간 표시 연결 검토
      </button>
      {b.props.dataBinding && (
        <button
          type="button"
          disabled={!s.editable}
          onClick={() =>
            s.apply((p) => {
              delete p.blocks.find((block) => block.id === b.id)!.props
                .dataBinding;
            })
          }
        >
          실시간 연결 해제
        </button>
      )}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {review && (
        <EditorDialog
          title="실시간 데이터 표시 연결 검토"
          onClose={() => setReview(null)}
        >
          <p>
            원본 v{review.revision} · 연결 {review.binding.connectionId} · 조회{" "}
            {review.binding.limit}행
          </p>
          <ChangeReview before={b.props.dataBinding} after={review.binding} />
          <p>
            방문자에게 표시할 자료는 연결 설정과 서버 권한을 검토하세요. 그림
            필드는 문서 자산 ID를 사용합니다.
          </p>
          <button
            type="button"
            disabled={s.project.revision !== review.revision || !s.editable}
            onClick={() => {
              s.apply((p) => {
                p.blocks.find(
                  (block) => block.id === review.blockId,
                )!.props.dataBinding = review.binding;
              });
              setReview(null);
            }}
          >
            검토한 표시 연결 저장
          </button>
        </EditorDialog>
      )}
    </details>
  );
}
