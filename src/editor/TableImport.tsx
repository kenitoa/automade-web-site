import { useRef, useState } from "react";
import { importTableCsv } from "../domain/content";
import type { Block, Row } from "../domain/types";
import { errorText, type StudioState } from "./useStudio";
import EditorDialog from "./EditorDialog";
export default function TableImport({
  block: b,
  studio: s,
}: {
  block: Block;
  studio: StudioState;
}) {
  const input = useRef<HTMLInputElement>(null),
    [source, setSource] = useState(""),
    [headers, setHeaders] = useState<string[]>([]),
    [mapping, setMapping] = useState<Record<string, number>>({}),
    [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [preview, setPreview] = useState(false);
  async function load(file: File) {
    try {
      if (file.size > 2_000_000)
        throw new Error("CSV는 2MB까지 가져올 수 있습니다.");
      const text = await file.text(),
        head = importTableCsv(text, []).headers;
      setSource(text);
      setHeaders(head);
      setMapping(
        Object.fromEntries(
          b.props.columns.map((col) => [col.id, head.indexOf(col.label)]),
        ),
      );
      setRows([]);
      setError("");
      setPreview(true);
    } catch (e) {
      setError(errorText(e));
    }
  }
  function inspect() {
    try {
      const result = importTableCsv(
        source,
        b.props.columns,
        mapping,
        b.props.rows,
      );
      setRows(result.rows);
      setError(
        result.errors
          .map((x) => `${x.row + 1}행 ${x.column}: ${x.message}`)
          .join("\n"),
      );
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <>
      <button type="button" onClick={() => input.current?.click()}>
        초기 데이터 CSV 가져오기
      </button>
      <input
        ref={input}
        hidden
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void load(file);
          e.target.value = "";
        }}
      />
      {error && !preview ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}
      {preview ? (
        <EditorDialog
          title="CSV 열 연결·미리보기"
          onClose={() => setPreview(false)}
        >
          <p>
            현재 표의 초기 데이터 뒤에 추가합니다. 실행 사이트의 운영 데이터는
            직접 변경하지 않습니다.
          </p>
          {b.props.columns.map((col) => (
            <label key={col.id}>
              {col.label}
              <select
                value={mapping[col.id] ?? -1}
                onChange={(e) => {
                  setMapping({ ...mapping, [col.id]: Number(e.target.value) });
                  setRows([]);
                }}
              >
                <option value={-1}>CSV 열 선택</option>
                {headers.map((header, i) => (
                  <option key={i} value={i}>
                    {header}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button type="button" onClick={inspect}>
            행 유효성 검사·미리보기
          </button>
          {error ? (
            <p className="bad" role="alert" style={{ whiteSpace: "pre-wrap" }}>
              {error}
            </p>
          ) : null}
          {rows.length ? (
            <>
              <p>{rows.length}개 행 · 앞 10개 표시</p>
              <div className="csv-preview">
                <table>
                  <thead>
                    <tr>
                      {b.props.columns.map((col) => (
                        <th key={col.id}>{col.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 10).map((row) => (
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
            disabled={Boolean(error) || !rows.length}
            onClick={() => {
              s.apply((p) => {
                p.blocks.find((x) => x.id === b.id)!.props.rows.push(...rows);
              });
              setPreview(false);
              s.setMessage(`${rows.length}개 초기 데이터 행을 추가했습니다.`);
            }}
          >
            검사한 행 추가
          </button>
        </EditorDialog>
      ) : null}
    </>
  );
}
