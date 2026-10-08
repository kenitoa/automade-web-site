import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../infrastructure/api";
import type { RetentionPolicy } from "../domain/operations";
interface Candidate {
  id: string;
  kind: string;
  resourceId: string;
  createdAt: string;
  bytes: number;
  label: string;
  relativePath: string;
}
interface Preview {
  policy: RetentionPolicy;
  candidates: Candidate[];
  protectedCount: number;
  bytes: number;
  warning: boolean;
  quarantined: number;
  overdueAuditRecords: number;
  overdueSubmissions: number;
  errors: string[];
}
interface Quarantine {
  id: string;
  candidate: Candidate;
  status: string;
  createdAt: string;
  errorCode?: string;
}
const labels = {
  backupDays: "백업 보존 일",
  artifactDays: "생성 결과 보존 일",
  auditDays: "감사 보존 검토 일",
  submissionDays: "문의 보존 검토 일",
  maxStorageMB: "저장 공간 경고 MB",
};
export default function RetentionPanel({
  projectId,
  onMessage,
}: {
  projectId: string;
  onMessage: (message: string) => void;
}) {
  const [policy, setPolicy] = useState<RetentionPolicy | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [entries, setEntries] = useState<Quarantine[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const endpoint = `/api/projects/${projectId}/retention`;
  const load = useCallback(async () => {
    const [preview, entries] = await Promise.all([
      api<Preview>(endpoint + "/preview"),
      api<Quarantine[]>(endpoint + "/quarantines"),
    ]);
    setPreview(preview);
    setPolicy(preview.policy);
    setEntries(entries);
    setSelected([]);
  }, [endpoint]);
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      await load();
      setMessage(success);
      onMessage(success);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "보존 작업을 처리하지 못했습니다.";
      setMessage(message);
      onMessage(message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load().catch((error: unknown) =>
      setMessage(
        error instanceof Error
          ? error.message
          : "보존 정보를 불러오지 못했습니다.",
      ),
    );
  }, [load]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (policy)
      void run(
        () => api(endpoint, "PUT", policy),
        "보존 정책을 저장했습니다. 자동 격리를 켠 경우 안전한 후보를 처리했습니다.",
      );
  }
  return (
    <section aria-label="보존과 격리 관리">
      <h3>보존과 격리</h3>
      <p>
        오래된 결과·백업을 보관함으로 이동하고 복원합니다. 영구 삭제를 하지
        않으므로 물리적 디스크 용량은 그대로 사용합니다. 활성·실행 사이트, 현재
        DB, 최신 정상 결과 2개와 실제 백업 2개를 보호합니다.
      </p>
      <p role="status">{busy ? "처리 중…" : message}</p>
      {policy && (
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <legend>보존 정책</legend>
            {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => (
              <label key={key}>
                {labels[key]}
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={policy[key]}
                  onChange={(event) =>
                    setPolicy({ ...policy, [key]: Number(event.target.value) })
                  }
                />
              </label>
            ))}
            <label>
              <input
                type="checkbox"
                checked={policy.automaticCleanup}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    automaticCleanup: event.target.checked,
                  })
                }
              />
              자동 격리 · 기본 꺼짐
            </label>
            <p>
              자동 격리를 켜면 저장 직후와 서버 실행 중 1분마다 보존 기간이 지난
              안전한 결과·백업을 격리합니다. 문의 원문·감사 DB 기록은 삭제하지
              않고 검토 개수만 표시합니다.
            </p>
            <button>정책 저장</button>
          </fieldset>
        </form>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(load, "최신 보존 후보를 확인했습니다.")}
      >
        후보 다시 검사
      </button>
      {preview && (
        <>
          <p>
            {(preview.bytes / 1024 / 1024).toFixed(1)}MB · 보호{" "}
            {preview.protectedCount}개 · 격리 {preview.quarantined}개
          </p>
          {preview.warning && (
            <p role="alert">
              설정한 저장 공간 경고 기준을 넘었습니다. 영구 삭제 없이 데이터를
              안전한 별도 저장소로 옮기는 방안을 검토하세요.
            </p>
          )}
          <p>
            기간 검토 대상: 감사 {preview.overdueAuditRecords}개 · 문의{" "}
            {preview.overdueSubmissions}개. DB 원문을 보존합니다.
          </p>
          {preview.errors.map((error) => (
            <p key={error} role="alert">
              {error}
            </p>
          ))}
          <h4>안전한 격리 후보</h4>
          {preview.candidates.length ? (
            preview.candidates.map((candidate) => (
              <label key={candidate.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(candidate.id)}
                  onChange={(event) =>
                    setSelected((old) =>
                      event.target.checked
                        ? [...old, candidate.id]
                        : old.filter((id) => id !== candidate.id),
                    )
                  }
                />
                {candidate.label} · {candidate.relativePath} ·{" "}
                {new Date(candidate.createdAt).toLocaleDateString()} ·{" "}
                {(candidate.bytes / 1024).toFixed(1)}KB
              </label>
            ))
          ) : (
            <p>격리 가능한 후보가 없습니다.</p>
          )}
          <button
            type="button"
            disabled={busy || !selected.length}
            onClick={() =>
              void run(
                () =>
                  api(endpoint + "/quarantine", "POST", {
                    candidateIds: selected,
                  }),
                "선택한 후보를 격리 보관했습니다. 복원할 수 있습니다.",
              )
            }
          >
            선택한 {selected.length}개 격리 보관
          </button>
        </>
      )}
      <h4>격리 보관·복원 이력</h4>
      {entries.length ? (
        entries.map((entry) => (
          <article key={entry.id}>
            <p>
              {entry.candidate.label} · {entry.candidate.relativePath} ·{" "}
              {entry.status}
            </p>
            <small>{new Date(entry.createdAt).toLocaleString()}</small>
            {entry.errorCode && <p role="alert">{entry.errorCode}</p>}
            <button
              type="button"
              disabled={busy || entry.status !== "quarantined"}
              onClick={() =>
                void run(
                  () =>
                    api(
                      `${endpoint}/quarantines/${entry.id}/restore`,
                      "POST",
                      {},
                    ),
                  "원래 위치로 복원했습니다. 기존 파일을 덮어쓰지 않습니다.",
                )
              }
            >
              원래 위치로 복원
            </button>
          </article>
        ))
      ) : (
        <p>격리 이력이 없습니다.</p>
      )}
    </section>
  );
}
