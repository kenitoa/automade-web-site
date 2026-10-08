import { useEffect, useRef, useState } from "react";
import type {
  StorageMigrationSummary,
  WorkerPolicySnapshot,
} from "../domain/systemRuntime";
import type { ConfigSnapshot } from "../domain/advancement";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import { useSystemActions } from "./useSystemActions";
export default function SystemCapacityPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const actions = useSystemActions(s, x),
    [tab, setTab] = useState("storage"),
    [migrations, setMigrations] = useState<StorageMigrationSummary[] | null>(
      null,
    ),
    [policy, setPolicy] = useState<WorkerPolicySnapshot | null>(null),
    [configRevision, setConfigRevision] = useState(0),
    [canManage, setCanManage] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [verification, setVerification] = useState<{
      verified: boolean;
      changedTables: string[];
      requiresRecopy: boolean;
    } | null>(null),
    scope = `${s.project.id}/${x.environmentId}/${tab}`,
    currentScope = useRef(scope),
    sequence = useRef(0);
  currentScope.current = scope;
  async function refresh() {
    const key = scope,
      request = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      if (tab === "storage") {
        const [rows, config] = await Promise.all([
          api<StorageMigrationSummary[]>(
            actions.endpoint("runtime/storage-migrations"),
          ),
          api<ConfigSnapshot>(actions.endpoint("config")),
        ]);
        if (key !== currentScope.current || request !== sequence.current)
          return;
        if (!Array.isArray(rows) || typeof config.revision !== "number")
          throw new Error("이전 작업의 환경·버전 계약을 확인하세요.");
        setMigrations(rows);
        setConfigRevision(config.revision);
        try {
          await api<WorkerPolicySnapshot>(
            actions.endpoint("runtime/worker-policy"),
          );
          if (key === currentScope.current && request === sequence.current)
            setCanManage(true);
        } catch (e) {
          if (key === currentScope.current && request === sequence.current) {
            setCanManage(false);
            setError(
              e instanceof Error
                ? e.message
                : "이전 변경에는 플랫폼 관리자 권한이 필요합니다.",
            );
          }
        }
      } else {
        const result = await api<WorkerPolicySnapshot>(
          actions.endpoint("runtime/worker-policy"),
        );
        if (key !== currentScope.current || request !== sequence.current)
          return;
        if (typeof result.revision !== "number" || !result.policy)
          throw new Error("전역 작업 정책 계약을 확인하세요.");
        setPolicy(result);
      }
    } catch (e) {
      if (key === currentScope.current && request === sequence.current)
        setError(
          e instanceof Error
            ? e.message
            : "플랫폼 관리자 권한과 실제 상태를 확인하세요.",
        );
    } finally {
      if (key === currentScope.current && request === sequence.current)
        setBusy(false);
    }
  }
  useEffect(() => {
    setMigrations(null);
    setPolicy(null);
    setConfigRevision(0);
    setCanManage(false);
    setVerification(null);
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [scope]);
  return (
    <section className="system-capacity">
      <p>
        저장소·전역 작업 정책 변경은 플랫폼 관리자·로컬 소유자 전용 업무입니다.
        일반 조직 관리 권한과 구분하며 서버가 권한을 다시 확인합니다.
      </p>
      <div className="panel-tabs">
        <button
          type="button"
          aria-pressed={tab === "storage"}
          onClick={() => setTab("storage")}
        >
          저장소 검증·전환
        </button>
        <button
          type="button"
          aria-pressed={tab === "worker"}
          onClick={() => setTab("worker")}
        >
          전역 작업 예산
        </button>
      </div>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {busy ? "실제 상태 조회 중…" : "플랫폼 권한·상태 조회"}
      </button>
      {tab === "storage" && (
        <>
          <p>
            선택한 환경을 잠시 동결하고 로컬 SQLite 복사본의 건수·내용을
            대사합니다. 전환은 쓰기 대상을 바꾸며 역복구는 전환 후 새 자료도
            포함합니다. PostgreSQL·클라우드 저장소·여러 호스트 이전은 제공자를
            연결한 뒤 별도로 검증합니다.
          </p>
          <button
            type="button"
            disabled={
              busy || !canManage || migrations === null || !configRevision
            }
            onClick={() =>
              actions.review({
                label: "현재 환경의 로컬 저장소 이전 검증본 만들기",
                path: "runtime/storage-migrations",
                method: "POST",
                payload: {
                  target: "sqlite-local",
                  expectedConfigRevision: configRevision,
                  requestKey: crypto.randomUUID(),
                },
                before: { environmentId: x.environmentId, configRevision },
                stepUp: true,
                success: refresh,
              })
            }
          >
            백업·건수·내용을 실제 대사하는 검증본 준비
          </button>
          {migrations?.map((migration) => (
            <article className="page-card" key={migration.id}>
              <strong>
                {migration.target} · {migration.state}
              </strong>
              <p>
                확인 {new Date(migration.updatedAt).toLocaleString()} · 검토
                설정 v{migration.sourceConfigRevision}
              </p>
              <details>
                <summary>대사한 테이블 건수</summary>
                <dl>
                  {Object.entries(migration.counts).map(([table, count]) => (
                    <div key={table}>
                      <dt>{table}</dt>
                      <dd>{count}건</dd>
                    </div>
                  ))}
                </dl>
              </details>
              <div className="button-row">
                {(["verify", "cutover", "rollback"] as const).map(
                  (operation) => (
                    <button
                      type="button"
                      key={operation}
                      disabled={
                        busy ||
                        !canManage ||
                        (operation === "rollback"
                          ? migration.state !== "active"
                          : migration.state !== "verified")
                      }
                      onClick={() =>
                        actions.review({
                          label:
                            operation === "verify"
                              ? "검증 이후 원본 변경 재대사"
                              : operation === "cutover"
                                ? "검증 저장소로 현재 환경 쓰기 전환"
                                : "전환 후 자료를 포함한 기존 저장소 역복구",
                          path: `runtime/storage-migrations/${migration.id}/${operation}`,
                          method: "POST",
                          payload: { confirm: true },
                          before: {
                            environmentId: x.environmentId,
                            state: migration.state,
                            counts: migration.counts,
                            sourceConfigRevision:
                              migration.sourceConfigRevision,
                          },
                          stepUp: true,
                          success: async (raw) => {
                            await refresh();
                            if (operation === "verify") {
                              const result = record(raw);
                              if (
                                typeof result.verified !== "boolean" ||
                                !Array.isArray(result.changedTables) ||
                                !result.changedTables.every(
                                  (table) => typeof table === "string",
                                )
                              )
                                throw new Error("실제 대사 결과를 확인하세요.");
                              setVerification({
                                verified: result.verified,
                                changedTables: result.changedTables,
                                requiresRecopy: result.requiresRecopy === true,
                              });
                            }
                          },
                        })
                      }
                    >
                      {
                        {
                          verify: "원본 변경 재대사 검토",
                          cutover: "쓰기 전환 영향 검토",
                          rollback: "최신 자료 역복구 검토",
                        }[operation]
                      }
                    </button>
                  ),
                )}
              </div>
            </article>
          ))}
          {migrations?.length === 0 && (
            <p>이 환경에서 준비한 이전 검증본이 없습니다.</p>
          )}
          {verification && (
            <p role="status">
              {verification.verified
                ? "원본과 검증본 대사 일치"
                : "원본 변경 감지 · 새 검증본을 준비하세요"}{" "}
              · 변경 테이블 {verification.changedTables.join(", ") || "없음"}
            </p>
          )}
        </>
      )}
      {tab === "worker" && policy && (
        <form
          key={policy.revision}
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            actions.review({
              label: "모든 조직에 적용되는 전역 작업 예산 변경",
              path: "runtime/worker-policy",
              method: "PUT",
              payload: {
                baseRevision: policy.revision,
                policy: {
                  maxRunning: Number(form.get("maxRunning")),
                  pools: {
                    standard: Number(form.get("standard")),
                    cpu: Number(form.get("cpu")),
                    io: Number(form.get("io")),
                    recovery: Number(form.get("recovery")),
                  },
                  maxDurationMs: Number(form.get("maxDurationMs")),
                  drainMs: Number(form.get("drainMs")),
                },
              },
              before: policy,
              stepUp: true,
              success: refresh,
            });
          }}
        >
          <p>
            전역 정책 v{policy.revision} · 모든 조직과 실행기에서 같은 설정을
            사용합니다.
          </p>
          <label>
            전체 동시 실행 수
            <input
              type="number"
              name="maxRunning"
              min={1}
              max={16}
              defaultValue={policy.policy.maxRunning}
              required
            />
          </label>
          <fieldset>
            <legend>작업 종류별 동시 실행 상한</legend>
            {(["standard", "cpu", "io", "recovery"] as const).map((pool) => (
              <label key={pool}>
                {
                  {
                    standard: "일반 업무",
                    cpu: "생성·CPU 업무",
                    io: "연결·외부 업무",
                    recovery: "복구 업무",
                  }[pool]
                }
                <input
                  type="number"
                  name={pool}
                  min={1}
                  max={16}
                  defaultValue={policy.policy.pools[pool]}
                  required
                />
              </label>
            ))}
          </fieldset>
          <label>
            작업 시간 예산 (밀리초)
            <input
              type="number"
              name="maxDurationMs"
              min={1000}
              max={3600000}
              defaultValue={policy.policy.maxDurationMs}
              required
            />
          </label>
          <label>
            종료 처리 예산 (밀리초)
            <input
              type="number"
              name="drainMs"
              min={100}
              max={30000}
              defaultValue={policy.policy.drainMs}
              required
            />
          </label>
          <button disabled={busy}>모든 조직 영향·기존 버전 검토</button>
        </form>
      )}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {actions.dialog}
    </section>
  );
}
