import { useState } from "react";
import { uid } from "../domain/catalog";
import { validateTableRows } from "../domain/content";
import { parseRows } from "../domain/validation";
import type { Row } from "../domain/types";
import type { StudioState } from "./useStudio";
import EditorDialog from "./EditorDialog";
export type MappedDataRow = Record<string, string | number | boolean | null>;
export default function ExternalDataImport({
  studio: s,
  records,
  onClose,
}: {
  studio: StudioState;
  records: MappedDataRow[];
  onClose: () => void;
}) {
  const tables = s.project.blocks.filter((b) => b.type === "table"),
    [target, setTarget] = useState(
      s.selectedBlock?.type === "table"
        ? s.selectedBlock.id
        : tables[0]?.id || "",
    ),
    [mode, setMode] = useState("append"),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState<Row[] | null>(null),
    [errors, setErrors] = useState<string[]>([]),
    [revision, setRevision] = useState(s.project.revision),
    table = tables.find((b) => b.id === target),
    headers = [...new Set(records.flatMap((row) => Object.keys(row)))];
  function inspect() {
    if (!table) return;
    const missing = table.props.columns.filter(
      (col) =>
        !mapping[col.id] &&
        !headers.includes(col.label) &&
        !headers.includes(col.id),
    );
    if (missing.length) {
      setErrors(
        missing.map((col) => `${col.label}: 연결할 외부 필드를 선택하세요.`),
      );
      setPreview(null);
      return;
    }
    const rows = records.map((record) => ({
      id: uid(),
      values: table.props.columns.map((col) =>
        String(
          record[
            mapping[col.id] ||
              (headers.includes(col.label) ? col.label : col.id)
          ] ?? "",
        ),
      ),
    }));
    const all = mode === "append" ? [...table.props.rows, ...rows] : rows;
    try {
      parseRows(all, table.props.columns.length);
    } catch (e) {
      setErrors([
        e instanceof Error
          ? e.message
          : "연결한 자료의 행과 값 형식을 확인하세요.",
      ]);
      setPreview(null);
      return;
    }
    const errors = validateTableRows(table.props.columns, all);
    setErrors(errors.map((x) => `${x.row + 1}행 ${x.column}: ${x.message}`));
    setPreview(rows);
    setRevision(s.project.revision);
  }
  return (
    <EditorDialog title="연결 데이터 표 적용 검토" onClose={onClose}>
      <p>
        조회한 외부 자료 {records.length}개를 편집 원본의 표 초기 데이터에
        반영합니다. 실행 사이트의 운영 데이터는 직접 변경하지 않습니다.
      </p>
      <label>
        대상 표
        <select
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setPreview(null);
            setMapping({});
          }}
        >
          <option value="">표 선택</option>
          {tables.map((b) => (
            <option key={b.id} value={b.id}>
              {b.props.title || b.name}
            </option>
          ))}
        </select>
      </label>
      {!tables.length ? (
        <p>
          표 블록을 먼저 추가하세요. 조회한 자료는 적용 전까지 변경하지
          않습니다.
        </p>
      ) : null}
      <label>
        반영 방식
        <select
          value={mode}
          onChange={(e) => {
            setMode(e.target.value);
            setPreview(null);
          }}
        >
          <option value="append">기존 초기 데이터 뒤에 추가</option>
          <option value="replace">초기 데이터 전체 교체</option>
        </select>
      </label>
      {table?.props.columns.map((col) => (
        <label key={col.id}>
          {col.label}에 연결할 외부 필드
          <select
            value={
              mapping[col.id] ||
              (headers.includes(col.label)
                ? col.label
                : headers.includes(col.id)
                  ? col.id
                  : "")
            }
            onChange={(e) => {
              setMapping({ ...mapping, [col.id]: e.target.value });
              setPreview(null);
            }}
          >
            <option value="">필드 선택</option>
            {headers.map((header) => (
              <option key={header} value={header}>
                {header}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button
        type="button"
        disabled={!table || !records.length}
        onClick={inspect}
      >
        연결·행 검증 및 미리보기
      </button>
      {errors.length ? (
        <p role="alert" className="bad" style={{ whiteSpace: "pre-wrap" }}>
          {errors.join("\n")}
        </p>
      ) : null}
      {preview && table ? (
        <>
          <p>
            초기 데이터 {table.props.rows.length} →{" "}
            {mode === "append"
              ? table.props.rows.length + preview.length
              : preview.length}
            개
          </p>
          <p className="hint">
            {mode === "replace"
              ? `현재 ${table.props.rows.length}행을 제거하고 조회한 ${preview.length}행으로 교체합니다.`
              : `기존 ${table.props.rows.length}행을 보존하고 조회한 ${preview.length}행을 뒤에 추가합니다.`}{" "}
            아래는 새로 반영할 자료의 첫 10행입니다.
          </p>
          {mode === "replace" && table.props.rows.length ? (
            <details>
              <summary>교체 전 초기 데이터 검토</summary>
              <div className="csv-preview">
                <table>
                  <thead>
                    <tr>
                      {table.props.columns.map((col) => (
                        <th key={col.id}>{col.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.props.rows.slice(0, 10).map((row) => (
                      <tr key={row.id}>
                        {row.values.map((value, i) => (
                          <td key={i}>{value}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
          <div className="csv-preview">
            <table>
              <thead>
                <tr>
                  {table.props.columns.map((col) => (
                    <th key={col.id}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 10).map((row) => (
                  <tr key={row.id}>
                    {row.values.map((value, i) => (
                      <td key={i}>{value}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <button
        type="button"
        className="primary"
        disabled={
          !preview ||
          !table ||
          !preview.length ||
          Boolean(errors.length) ||
          s.project.revision !== revision
        }
        onClick={() => {
          if (!preview) return;
          s.apply((p) => {
            const block = p.blocks.find((x) => x.id === target)!;
            block.props.rows =
              mode === "append" ? [...block.props.rows, ...preview] : preview;
          });
          s.setMessage(
            "검토한 연결 데이터를 초기 표에 적용했습니다. 한 번의 실행 취소로 복구할 수 있습니다.",
          );
          onClose();
        }}
      >
        검토한 데이터 적용
      </button>
    </EditorDialog>
  );
}
