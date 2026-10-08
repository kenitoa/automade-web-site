import { useState } from "react";
import type { DataManifest } from "../../server/dataPortability";
import { api } from "../infrastructure/api";
import { downloadFile } from "../infrastructure/library";
import { record } from "../domain/validation";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import EditorDialog from "./EditorDialog";
interface PortableData {
  manifest: DataManifest;
  databaseBase64: string;
}
function portable(value: unknown): PortableData {
  const input = record(value),
    m = record(input.manifest);
  if (
    m.format !== 1 ||
    typeof m.projectId !== "string" ||
    typeof m.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(m.sha256) ||
    typeof m.bytes !== "number" ||
    m.bytes < 100 ||
    m.bytes > 16000000 ||
    !Array.isArray(m.migrations) ||
    !m.migrations.every((v) => Number.isInteger(v)) ||
    typeof input.databaseBase64 !== "string" ||
    input.databaseBase64.length > 22000000 ||
    !/^[A-Za-z0-9+/=]+$/.test(input.databaseBase64)
  )
    throw new Error("운영 데이터 이전 파일 계약을 확인하세요.");
  const tables = record(m.tables);
  if (
    !Object.values(tables).every(
      (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
    )
  )
    throw new Error("이전 건수 계약을 확인하세요.");
  return {
    manifest: m as unknown as DataManifest,
    databaseBase64: input.databaseBase64,
  };
}
export default function DataTransferPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [candidate, setCandidate] = useState<PortableData | null>(null);
  const endpoint = `/api/projects/${s.project.id}/data-transfer`;
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "운영 데이터 이전을 확인하세요.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="expansion-panel">
      <summary>운영 데이터 내보내기·환경 이전</summary>
      <p className="hint">
        선택 환경의 실제 DB와 검증 manifest를 함께 내보냅니다. 같은 프로젝트로
        가져오며 무결성·참조·버전·해시를 서버에서 다시 검사합니다.
      </p>
      <button
        type="button"
        disabled={busy || !x.can("backup.restore")}
        onClick={() =>
          void run(async () => {
            const data = portable(await api<unknown>(endpoint));
            downloadFile(
              `${s.project.name}-${x.environmentId || "production"}.data.json`,
              JSON.stringify(data),
            );
            s.setMessage(
              "검증 manifest와 실제 운영 DB를 내보냈습니다. 개인정보가 포함될 수 있으므로 안전하게 보관하세요.",
            );
          })
        }
      >
        선택 환경 실제 데이터 내보내기
      </button>
      <label>
        이전 파일 검토
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy || !x.can("backup.restore")}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              void run(async () => {
                if (file.size > 23000000)
                  throw new Error("이전 파일은 23MB 이하로 입력하세요.");
                const next = portable(JSON.parse(await file.text()) as unknown);
                if (next.manifest.projectId !== s.project.id)
                  throw new Error(
                    "같은 프로젝트 ID의 운영 DB만 가져올 수 있습니다.",
                  );
                setCandidate(next);
              });
            e.target.value = "";
          }}
        />
      </label>
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {candidate && (
        <EditorDialog
          title="운영 데이터 이전·복원 범위 검토"
          onClose={() => setCandidate(null)}
        >
          <p>
            프로젝트 {candidate.manifest.projectId} → 환경{" "}
            {x.environmentId || "기본 운영"} ·{" "}
            {(candidate.manifest.bytes / 1024).toFixed(1)}KB · DB 버전{" "}
            {candidate.manifest.migrations.join(", ")}
          </p>
          <p>SHA256 {candidate.manifest.sha256}</p>
          <table className="change-table">
            <thead>
              <tr>
                <th>자료 테이블</th>
                <th>이전 건수</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(candidate.manifest.tables).map(
                ([name, count]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{count}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          <p className="bad">
            선택 환경의 운영 자료를 이 스냅샷으로 복원합니다. 현재 자료를 먼저
            백업하고 쓰기를 잠그며 발송 작업은 거래·중복 대사까지 보류합니다.
            디자인 원본은 이 파일에 포함되지 않습니다.
          </p>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(endpoint, "POST", { ...candidate, confirm: true });
                setCandidate(null);
                s.setMessage(
                  "운영 데이터 복원 검증을 확인했습니다. 발송·결제·중복 거래 대사 후 운영 작업을 재개하세요.",
                );
              })
            }
          >
            검토한 환경 데이터 이전 실행
          </button>
        </EditorDialog>
      )}
    </details>
  );
}
