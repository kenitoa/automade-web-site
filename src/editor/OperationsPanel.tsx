import { useEffect, useState } from "react";
import { api as requestApi } from "../infrastructure/api";
import type {
  DataBackup,
  ReleaseSummary,
  SubmissionEntry,
  SubmissionPage,
  SubmissionStatus,
} from "../domain/operations";
import type { GenerationState } from "./useGeneration";
import { errorText, type StudioState } from "./useStudio";
import EditorDialog from "./EditorDialog";
import PlatformPanel from "./PlatformPanel";
import RetentionPanel from "./RetentionPanel";
import DeploymentPanel from "./DeploymentPanel";
import OperationalMetrics from "./OperationalMetrics";
import ExternalDataImport, { type MappedDataRow } from "./ExternalDataImport";
export default function OperationsPanel({
  studio: s,
  generation: g,
  environmentId,
}: {
  studio: StudioState;
  generation: GenerationState;
  environmentId: string;
}) {
  function api<T>(route: string, method = "GET", input?: unknown): Promise<T> {
    const url = new URL(route, window.location.origin);
    url.searchParams.set("environmentId", environmentId);
    return requestApi<T>(url.pathname + url.search, method, input);
  }
  const [tab, setTab] = useState("sites"),
    [releases, setReleases] = useState<ReleaseSummary[]>([]),
    [backups, setBackups] = useState<DataBackup[]>([]),
    [restore, setRestore] = useState<DataBackup | null>(null),
    [busy, setBusy] = useState(false),
    [externalRows, setExternalRows] = useState<MappedDataRow[] | null>(null),
    [site, setSite] = useState(""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [offset, setOffset] = useState(0),
    [entries, setEntries] = useState<SubmissionPage>({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    });
  const endpoint = `/api/projects/${s.project.id}`;
  const filters = new URLSearchParams({
    includeMeta: "1",
    limit: "20",
    offset: String(offset),
    query,
    status,
  });
  const report = (e: unknown) => s.setMessage(errorText(e));
  async function loadReleases() {
    try {
      setReleases(await api<ReleaseSummary[]>(endpoint + "/releases"));
    } catch (e) {
      report(e);
    }
  }
  async function loadBackups() {
    try {
      setBackups(await api<DataBackup[]>(endpoint + "/data-backups"));
    } catch (e) {
      report(e);
    }
  }
  async function loadEntries(id = site) {
    if (!id) return;
    try {
      setEntries(
        await api<SubmissionPage>(`/api/exports/${id}/submissions?${filters}`),
      );
    } catch (e) {
      report(e);
    }
  }
  useEffect(() => {
    void loadReleases();
  }, [s.project.id]);
  useEffect(() => {
    if (site) void loadEntries();
  }, [site, offset]);
  async function patchEntry(
    entry: SubmissionEntry,
    change: Partial<
      Pick<SubmissionEntry, "status" | "tags" | "note" | "assignee">
    >,
  ) {
    try {
      await api(
        `/api/exports/${site}/submissions/${entry.id}`,
        "PATCH",
        change,
      );
      await loadEntries();
    } catch (e) {
      report(e);
    }
  }
  return (
    <>
      <div className="panel-tabs">
        {[
          ["sites", "사이트·작업"],
          ["inbox", "문의함"],
          ["backups", "백업·보존"],
          ["platform", "계정·연결"],
          ["deployment", "배포"],
        ].map(([id, name]) => (
          <button
            type="button"
            className={tab === id ? "active" : ""}
            key={id}
            onClick={() => {
              setTab(id!);
              if (id === "sites") {
                void g.refresh();
                void loadReleases();
              }
              if (id === "backups") void loadBackups();
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === "sites" ? (
        <>
          <button
            type="button"
            className="secondary full"
            onClick={() => {
              void g.refresh();
              void loadReleases();
            }}
          >
            상태 새로고침
          </button>
          {g.operations ? (
            <>
              <div className="stat-grid">
                <div>
                  <strong>{g.operations.stats.projects}</strong>프로젝트
                </div>
                <div>
                  <strong>{g.operations.stats.exports}</strong>생성 작업
                </div>
              </div>
              {g.operations.sites
                ?.filter((x) => x.projectId === s.project.id)
                .map((x) => (
                  <article className="page-card" key={x.projectId}>
                    <strong>{x.name}</strong>
                    <p>
                      {x.activeReleaseId
                        ? `활성 버전 ${x.revision}`
                        : "활성 버전 없음"}{" "}
                      · 미처리 {x.pending} · 문의 {x.submissions}
                    </p>
                    <small>
                      측정 {new Date(x.measuredAt).toLocaleString()}
                    </small>
                    {x.error ? <p role="alert">{x.error}</p> : null}
                  </article>
                ))}
              <h3>실행 중인 사이트</h3>
              {g.operations.running
                .filter(
                  (run) => !run.projectId || run.projectId === s.project.id,
                )
                .map((run) => (
                  <div className="run-card" key={run.id}>
                    <a href={run.url} target="_blank" rel="noreferrer">
                      {run.url}
                    </a>
                    <span>
                      {run.readOnly ? "읽기 전용 이전 버전" : "현재 실행"}
                    </span>
                    <button type="button" onClick={() => void g.stop(run.id)}>
                      실행 종료
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSite(run.id);
                        setTab("inbox");
                        void loadEntries(run.id);
                      }}
                    >
                      문의 조회
                    </button>
                  </div>
                ))}
              <h3>생성 작업</h3>
              {g.operations.jobs
                .filter(
                  (job) => !job.project_id || job.project_id === s.project.id,
                )
                .map((job) => (
                  <div className="job-row" key={job.id}>
                    <span>
                      {job.status} · {job.stage || job.id.slice(0, 8)}
                    </span>
                    <small>{new Date(job.created_at).toLocaleString()}</small>
                    {job.status === "failed" ? (
                      <button
                        type="button"
                        onClick={() => void g.retry(job.id)}
                      >
                        재시도
                      </button>
                    ) : null}
                  </div>
                ))}
            </>
          ) : null}
          <h3>저장된 사이트 버전</h3>
          <OperationalMetrics projectId={s.project.id} releases={releases} />
          {releases.map((release) => (
            <article className="page-card" key={release.id}>
              <strong>
                편집본 v{release.revision} ·{" "}
                {release.active ? "활성" : release.status}
              </strong>
              <small>{new Date(release.created_at).toLocaleString()}</small>
              <div className="button-row">
                {release.status === "ready" ? (
                  <>
                    <button
                      type="button"
                      disabled={g.operations?.running.some(
                        (run) => run.id === release.id,
                      )}
                      onClick={() => void g.restart(release.id)}
                    >
                      다시 실행
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSite(release.id);
                        setTab("inbox");
                        void loadEntries(release.id);
                      }}
                    >
                      문의 조회
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            `디자인 v${release.revision}로 새 사이트를 생성합니다. 최신 문의·표 데이터는 유지합니다. 진행할까요?`,
                          )
                        )
                          void g.designRollback(release.id);
                      }}
                    >
                      이 디자인으로 복원
                    </button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </>
      ) : null}
      {tab === "inbox" ? (
        <>
          <p className="hint">
            종료된 사이트의 문의도 같은 프로젝트 저장소에서 조회합니다. 운영
            데이터는 소스 ZIP과 별도로 보존합니다.
          </p>
          <label>
            사이트 버전
            <select
              value={site}
              onChange={(e) => {
                setSite(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">버전 선택</option>
              {releases
                .filter((x) => x.status === "ready")
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    v{x.revision} · {x.id.slice(0, 8)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            문의 검색
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
            />
          </label>
          <label>
            처리 상태
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">전체</option>
              {[
                ["new", "미확인"],
                ["processing", "처리 중"],
                ["completed", "완료"],
                ["archived", "보관"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!site}
            onClick={() => void loadEntries()}
          >
            검색 적용
          </button>
          {site ? (
            <a
              className="button-link"
              href={`/api/exports/${site}/submissions.csv?${filters}`}
              download
            >
              현재 문의 CSV 다운로드
            </a>
          ) : null}
          <p>
            {entries.total}개 · {offset + 1}–
            {Math.min(offset + 20, entries.total)}
          </p>
          {entries.items.map((entry) => (
            <article className="submission" key={entry.id}>
              <strong>{new Date(entry.created_at).toLocaleString()}</strong>
              {Object.entries(entry.values).map(([key, value]) => (
                <p key={key}>
                  <strong>{key}: </strong>
                  {value}
                </p>
              ))}
              <label>
                처리 상태
                <select
                  value={entry.status}
                  onChange={(e) =>
                    void patchEntry(entry, {
                      status: e.target.value as SubmissionStatus,
                    })
                  }
                >
                  {[
                    ["new", "미확인"],
                    ["processing", "처리 중"],
                    ["completed", "완료"],
                    ["archived", "보관"],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                태그
                <input
                  defaultValue={entry.tags.join(", ")}
                  onBlur={(e) =>
                    void patchEntry(entry, {
                      tags: e.target.value
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <label>
                담당자
                <input
                  defaultValue={entry.assignee}
                  onBlur={(e) =>
                    void patchEntry(entry, { assignee: e.target.value })
                  }
                />
              </label>
              <label>
                담당자 메모
                <textarea
                  defaultValue={entry.note}
                  onBlur={(e) =>
                    void patchEntry(entry, { note: e.target.value })
                  }
                />
              </label>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (
                    window.confirm(
                      "문의 원문을 마스킹합니다. 복원할 수 없으며 감사 이력이 남습니다. 진행할까요?",
                    )
                  )
                    void api(
                      `/api/exports/${site}/submissions/${entry.id}`,
                      "PATCH",
                      { action: "mask" },
                    )
                      .then(() => loadEntries())
                      .catch(report);
                }}
              >
                원문 마스킹
              </button>
            </article>
          ))}
          {!entries.items.length ? <p>조건에 맞는 문의가 없습니다.</p> : null}
          <div className="button-row">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              이전 페이지
            </button>
            <button
              type="button"
              disabled={offset + 20 >= entries.total}
              onClick={() => setOffset(offset + 20)}
            >
              다음 페이지
            </button>
          </div>
          <button
            type="button"
            disabled={!site}
            onClick={() => void loadEntries()}
          >
            선택 페이지 불러오기
          </button>
        </>
      ) : null}
      {tab === "backups" ? (
        <>
          <p className="hint">
            원본 저장본, 디자인 버전, 실제 문의·표 데이터 백업은 별개입니다.
            데이터 복구는 선택한 시각 이후 데이터를 교체하며 복구 직전 자동
            백업을 만듭니다.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api(endpoint + "/data-backups", "POST", {})
                .then(() => loadBackups())
                .catch(report)
                .finally(() => setBusy(false));
            }}
          >
            지금 운영 데이터 백업
          </button>
          {backups.map((backup) => (
            <article className="page-card" key={backup.id}>
              <strong>{new Date(backup.createdAt).toLocaleString()}</strong>
              <p>
                문의 {backup.submissions}개 · 표 {backup.tables}개 ·{" "}
                {(backup.bytes / 1024).toFixed(1)}KB
              </p>
              <small>{backup.reason}</small>
              <a
                href={`${endpoint}/data-backups/${backup.id}/download`}
                download
              >
                운영 데이터 다운로드
              </a>
              <button type="button" onClick={() => setRestore(backup)}>
                이 백업 복구 검토
              </button>
            </article>
          ))}
          <RetentionPanel projectId={s.project.id} onMessage={s.setMessage} />
        </>
      ) : null}
      {tab === "platform" ? (
        <PlatformPanel
          projectId={s.project.id}
          onMessage={s.setMessage}
          onImportData={setExternalRows}
        />
      ) : null}
      {tab === "deployment" ? (
        <DeploymentPanel
          projectId={s.project.id}
          environmentId={environmentId}
          onMessage={s.setMessage}
        />
      ) : null}
      {restore ? (
        <EditorDialog
          title="운영 데이터 복구 검토"
          onClose={() => setRestore(null)}
        >
          <p>
            {s.project.name}의 실제 문의와 표를{" "}
            {new Date(restore.createdAt).toLocaleString()} 백업으로 교체합니다.
          </p>
          <p>
            백업 범위: 문의 {restore.submissions}개 · 표 {restore.tables}개.
            현재 디자인과 편집 원본은 유지합니다. 백업 이후 변경 데이터는 현재
            운영본에서 사라지며 복구 직전 별도 백업으로 보존합니다.
          </p>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api(
                `${endpoint}/data-backups/${restore.id}/restore`,
                "POST",
                { confirm: true },
              )
                .then(() => {
                  setRestore(null);
                  s.setMessage(
                    "운영 데이터를 복구했습니다. 실행 사이트 상태를 확인하세요.",
                  );
                  return loadBackups();
                })
                .catch(report)
                .finally(() => setBusy(false));
            }}
          >
            범위 확인 후 데이터 복구
          </button>
        </EditorDialog>
      ) : null}
      {externalRows ? (
        <ExternalDataImport
          studio={s}
          records={externalRows}
          onClose={() => setExternalRows(null)}
        />
      ) : null}
    </>
  );
}
