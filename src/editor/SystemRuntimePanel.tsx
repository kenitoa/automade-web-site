import { useEffect, useRef, useState } from "react";
import type { Experiment } from "../domain/systemRuntime";
import type { ReleaseSummary } from "../domain/operations";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import { useSystemActions } from "./useSystemActions";
interface Report {
  experiment: Experiment;
  variants: {
    variant: string;
    assigned: number;
    samples: number;
    value: number;
    failures: number;
  }[];
  sufficient: boolean;
  decision: string;
}
interface PromotionPreview {
  releaseId: string;
  artifactHash: string;
  sourceEnvironmentId: string;
  targetEnvironmentId: string;
  expectedConfigRevision: number;
  reviewFingerprint: string;
  compatible: boolean;
  issues: string[];
  requiresStaticVariant: boolean;
  manifest: Record<string, unknown>;
}
export default function SystemRuntimePanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const a = useSystemActions(s, x),
    [experiments, setExperiments] = useState<Experiment[]>([]),
    [report, setReport] = useState<Report | null>(null),
    [releases, setReleases] = useState<ReleaseSummary[]>([]),
    [promotion, setPromotion] = useState<PromotionPreview | null>(null),
    [preview, setPreview] = useState<{
      id: string;
      url: string;
      expiresAt: string;
      revoked?: boolean;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const scopeKey = `${s.project.id}/${x.environmentId}`,
    currentScope = useRef(scopeKey),
    requestSequence = useRef(0);
  currentScope.current = scopeKey;
  async function refresh() {
    const scope = scopeKey,
      request = ++requestSequence.current;
    setBusy(true);
    setError("");
    try {
      const [experiments, releases] = await Promise.all([
        api<Experiment[]>(a.endpoint("runtime/experiments")),
        api<ReleaseSummary[]>(
          `/api/projects/${s.project.id}/releases?environmentId=${encodeURIComponent(x.environmentId)}`,
        ),
      ]);
      if (scope !== currentScope.current || request !== requestSequence.current)
        return;
      if (!Array.isArray(experiments) || !Array.isArray(releases))
        throw new Error("릴리스·실험 목록 형식을 확인하세요.");
      setExperiments(experiments);
      setReleases(releases);
      window.dispatchEvent(new Event("automade:experiments"));
    } catch (e) {
      if (scope !== currentScope.current || request !== requestSequence.current)
        return;
      setError(
        e instanceof Error
          ? e.message
          : "릴리스·실험 상태를 확인하지 못했습니다.",
      );
    } finally {
      if (scope === currentScope.current && request === requestSequence.current)
        setBusy(false);
    }
  }
  useEffect(() => {
    setReport(null);
    setPromotion(null);
    setPreview(null);
    setExperiments([]);
    setReleases([]);
    void refresh();
    return () => {
      requestSequence.current++;
    };
  }, [s.project.id, x.environmentId]);
  return (
    <section className="system-runtime">
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        릴리스·실험 실제 상태 조회
      </button>
      <h3>검수한 릴리스 그대로 승격</h3>
      <p>
        코드·디자인 해시와 고정 콘텐츠를 검토합니다. 환경 설정·운영 DB·동적
        데이터는 별도 경계로 비교합니다. 공개 제공자 배포는 기존 배포 업무에서
        실제 공개 결과를 확인합니다.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget),
            id = String(form.get("releaseId")),
            targetEnvironmentId = String(form.get("targetEnvironmentId"));
          const scope = scopeKey,
            request = ++requestSequence.current;
          setBusy(true);
          void api<PromotionPreview>(
            a.endpoint(
              `runtime/releases/${id}/preview?targetEnvironmentId=${encodeURIComponent(targetEnvironmentId)}`,
            ),
          )
            .then((result) => {
              if (
                scope === currentScope.current &&
                request === requestSequence.current
              )
                setPromotion(result);
            })
            .catch(
              (e) =>
                scope === currentScope.current &&
                request === requestSequence.current &&
                setError(
                  e instanceof Error
                    ? e.message
                    : "승격 영향을 조회하지 못했습니다.",
                ),
            )
            .finally(() => {
              if (
                scope === currentScope.current &&
                request === requestSequence.current
              )
                setBusy(false);
            });
        }}
      >
        <label>
          실제로 생성한 검수 릴리스
          <select name="releaseId" required>
            {releases
              .filter((item) => item.status === "ready")
              .map((release) => (
                <option key={release.id} value={release.id}>
                  문서 v{release.revision} ·{" "}
                  {new Date(release.created_at).toLocaleString()}
                </option>
              ))}
          </select>
        </label>
        <label>
          승격할 현재 사이트 환경
          <select name="targetEnvironmentId" required>
            {x.bootstrap?.environments
              .filter(
                (env) =>
                  env.projectId === s.project.id && env.id !== x.environmentId,
              )
              .map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name} · {env.kind}
                </option>
              ))}
          </select>
        </label>
        <button disabled={busy || !x.can("project.publish")}>
          동일 산출물·설정·콘텐츠 영향 조회
        </button>
      </form>
      {promotion && (
        <article className="page-card">
          <strong>
            {promotion.compatible ? "승격 계약 일치" : "승격 전 해결 필요"}
          </strong>
          <p>산출물 해시 {promotion.artifactHash}</p>
          <p>
            대상 환경{" "}
            {x.bootstrap?.environments.find(
              (environment) => environment.id === promotion.targetEnvironmentId,
            )?.name ?? promotion.targetEnvironmentId}{" "}
            · 검토 이후 기능·활성 비밀 버전이 바뀌면 다시 검토합니다.
          </p>
          <p>
            대상 설정 v{promotion.expectedConfigRevision} ·{" "}
            {promotion.requiresStaticVariant
              ? "주소에 의존하는 정적 변형 별도 검증 필요"
              : "동일 산출물 승격 가능"}
          </p>
          {promotion.issues.map((issue) => (
            <p key={issue} className="bad">
              {issue}
            </p>
          ))}
          <details>
            <summary>검토한 고정 범위</summary>
            <dl>
              {Object.entries(promotion.manifest)
                .filter(([, value]) =>
                  ["string", "number", "boolean"].includes(typeof value),
                )
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
            </dl>
          </details>
          <button
            type="button"
            disabled={
              !promotion.compatible ||
              promotion.requiresStaticVariant ||
              !x.can("project.publish")
            }
            onClick={() =>
              a.review({
                label: `검수 산출물의 ${x.bootstrap?.environments.find((environment) => environment.id === promotion.targetEnvironmentId)?.name ?? promotion.targetEnvironmentId} 환경 활성화`,
                path: `runtime/releases/${promotion.releaseId}/promote`,
                method: "POST",
                payload: {
                  projectId: s.project.id,
                  environmentId: promotion.sourceEnvironmentId,
                  targetEnvironmentId: promotion.targetEnvironmentId,
                  expectedConfigRevision: promotion.expectedConfigRevision,
                  reviewFingerprint: promotion.reviewFingerprint,
                  requestKey: crypto.randomUUID(),
                },
                before: promotion,
                stepUp: true,
                success: async (raw) => {
                  const result = record(raw);
                  await refresh();
                  s.setMessage(
                    `대상 환경 활성화 ${String(result.status)} · 실제 해시 ${String(result.artifactHash)}. 공개 배포 여부는 별도로 확인하세요.`,
                  );
                },
              })
            }
          >
            검토한 승격 실제 적용 검토
          </button>
        </article>
      )}
      <h3>기간을 정한 인증 검수 미리보기</h3>
      <p>
        생성한 릴리스의 정적 화면을 현재 로그인과 사이트 권한으로 검수합니다.
        스크립트·폼·회원 작업은 실행하지 않습니다. 이 컴퓨터의 로컬 주소는 원격
        공유 주소가 아닙니다. 원격 접근과 도메인·TLS는 배포 환경을 연결한 뒤
        확인합니다.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          a.review({
            label: "인증·만료를 적용한 검수 화면 준비",
            path: "runtime/previews",
            method: "POST",
            payload: {
              projectId: s.project.id,
              environmentId: x.environmentId,
              releaseId: String(form.get("releaseId")),
              ttlMinutes: Number(form.get("ttlMinutes")),
            },
            success: (raw) => {
              const result = record(raw),
                url = new URL(String(result.url), window.location.origin);
              if (
                url.origin !== window.location.origin ||
                !["http:", "https:"].includes(url.protocol) ||
                result.authenticated !== true ||
                result.mode !== "static-review" ||
                typeof result.id !== "string" ||
                typeof result.expiresAt !== "string" ||
                !Number.isFinite(Date.parse(result.expiresAt))
              )
                throw new Error("검수 주소의 인증·만료 계약을 확인하세요.");
              setPreview({
                id: result.id,
                url: url.href,
                expiresAt: result.expiresAt,
              });
            },
          });
        }}
      >
        <label>
          검수할 실제 릴리스
          <select name="releaseId" required>
            {releases
              .filter((release) => release.status === "ready")
              .map((release) => (
                <option value={release.id} key={release.id}>
                  문서 v{release.revision} ·{" "}
                  {new Date(release.created_at).toLocaleString()}
                </option>
              ))}
          </select>
        </label>
        <label>
          미리보기 유지 시간 (분)
          <input
            type="number"
            name="ttlMinutes"
            defaultValue={30}
            min={1}
            max={120}
            required
          />
        </label>
        <button
          disabled={
            busy ||
            !releases.some((release) => release.status === "ready") ||
            !x.can("project.read")
          }
        >
          선택한 범위 검수 준비
        </button>
      </form>
      {preview && (
        <article className="page-card">
          <strong>인증된 정적 검수 · 운영 발행 전</strong>
          <p>
            만료 {new Date(preview.expiresAt).toLocaleString()} · 현재 계정의
            접근 권한을 다시 확인합니다.
          </p>
          {preview.revoked ? (
            <p>검수 주소를 즉시 폐기했습니다.</p>
          ) : (
            <>
              <a href={preview.url} target="_blank" rel="noopener noreferrer">
                이 컴퓨터에서 인증 검수 화면 열기 ↗
              </a>
              <button
                type="button"
                onClick={() =>
                  a.review({
                    label: "발급한 검수 주소 즉시 폐기",
                    path: `runtime/previews/${encodeURIComponent(preview.id)}`,
                    method: "DELETE",
                    payload: undefined,
                    success: () => setPreview({ ...preview, revoked: true }),
                  })
                }
              >
                검수 주소 폐기 검토
              </button>
            </>
          )}
        </article>
      )}
      <h3>업무 성과 실험 · 안정적인 그룹 유지</h3>
      <p>
        실제 저장·공개·완료 이벤트만 집계합니다. 계정·작업 공간 배정은 서버가
        고정하며 표본 부족은 판단 보류입니다. 중단해도 작성 문서·진행 업무는
        보존합니다.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          a.review({
            label: "측정 정의와 보호 조건을 가진 실험 시작",
            path: "runtime/experiments",
            method: "POST",
            payload: {
              name: String(form.get("name")),
              hypothesis: String(form.get("hypothesis")),
              unit: String(form.get("unit")),
              metric: String(form.get("metric")),
              minSamples: Number(form.get("minSamples")),
              guardrailErrorRate: Number(form.get("guardrailErrorRate")),
              durationDays: Number(form.get("durationDays")),
              variants: [
                { id: "concise", name: "간결한 업무 안내" },
                { id: "guided", name: "단계·복구 안내" },
              ],
            },
            success: refresh,
          });
        }}
      >
        <label>
          실험 이름
          <input name="name" required maxLength={120} />
        </label>
        <label>
          사전 가설
          <textarea name="hypothesis" required maxLength={2000} />
        </label>
        <label>
          안정적인 배정 단위
          <select name="unit">
            <option value="workspace">작업 공간</option>
            <option value="account">제작자 계정</option>
          </select>
        </label>
        <label>
          판정 지표
          <select name="metric">
            <option value="task-completed">실제 업무 완료</option>
            <option value="save-success">실제 서버 저장 확인</option>
            <option value="first-publish">최초 실제 공개 확인</option>
          </select>
        </label>
        <label>
          최소 표본 수
          <input
            name="minSamples"
            type="number"
            defaultValue={100}
            min={10}
            max={1000000}
            required
          />
        </label>
        <label>
          실패율 중단 기준 (0~1)
          <input
            name="guardrailErrorRate"
            type="number"
            defaultValue={0.05}
            min={0}
            max={1}
            step={0.01}
            required
          />
        </label>
        <label>
          실험 기간 일수
          <input
            name="durationDays"
            type="number"
            defaultValue={14}
            min={1}
            max={90}
            required
          />
        </label>
        <button disabled={!x.can("workspace.manage")}>
          지표·기간·보호 조건 검토
        </button>
      </form>
      {experiments.map((experiment) => (
        <article className="page-card" key={experiment.id}>
          <strong>
            {experiment.name} ·{" "}
            {experiment.status === "running" ? "실행 중" : "중단됨"}
          </strong>
          <p>{experiment.hypothesis}</p>
          <p>
            {experiment.unit} · {experiment.metric} · 최소{" "}
            {experiment.minSamples}표본 · 실패율{" "}
            {Math.round(experiment.guardrailErrorRate * 100)}% 중단 기준
          </p>
          {experiment.stopReason && <p>{experiment.stopReason}</p>}
          <button
            type="button"
            onClick={() => {
              const scope = scopeKey,
                request = ++requestSequence.current;
              setBusy(true);
              void api<Report>(
                a.endpoint(`runtime/experiments/${experiment.id}/report`),
              )
                .then((result) => {
                  if (
                    scope === currentScope.current &&
                    request === requestSequence.current
                  )
                    setReport(result);
                })
                .catch(
                  (e) =>
                    scope === currentScope.current &&
                    request === requestSequence.current &&
                    setError(
                      e instanceof Error
                        ? e.message
                        : "보고서를 확인하지 못했습니다.",
                    ),
                )
                .finally(() => {
                  if (
                    scope === currentScope.current &&
                    request === requestSequence.current
                  )
                    setBusy(false);
                });
            }}
          >
            실제 배정·표본·보호 지표 확인
          </button>
          <button
            type="button"
            disabled={
              experiment.status !== "running" || !x.can("workspace.manage")
            }
            onClick={() =>
              a.review({
                label: "실험 중단·기존 업무 보존",
                path: `runtime/experiments/${experiment.id}/stop`,
                method: "POST",
                payload: {
                  reason: "운영자가 보호 지표·업무 영향을 검토한 뒤 중단",
                },
                success: refresh,
              })
            }
          >
            실험 중단 검토
          </button>
        </article>
      ))}
      {report && (
        <article className="page-card">
          <strong>
            {report.sufficient
              ? "최소 표본 충족 · 담당자 판단 필요"
              : "표본 부족 · 판단 보류"}
          </strong>
          <p>{report.decision}</p>
          <table>
            <caption>{report.experiment.name}의 실제 집계</caption>
            <thead>
              <tr>
                <th>그룹</th>
                <th>배정</th>
                <th>표본</th>
                <th>지표 합계</th>
                <th>실패</th>
              </tr>
            </thead>
            <tbody>
              {report.variants.map((variant) => (
                <tr key={variant.variant}>
                  <th>{variant.variant}</th>
                  <td>{variant.assigned}</td>
                  <td>{variant.samples}</td>
                  <td>{variant.value}</td>
                  <td>{variant.failures}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>이 결과는 실제 외부 거래·방문자 전환율을 의미하지 않습니다.</p>
        </article>
      )}
      {!experiments.length && !busy && !error && (
        <p>이 환경에서 등록된 실험이 없습니다.</p>
      )}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {a.dialog}
    </section>
  );
}
