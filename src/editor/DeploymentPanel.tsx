import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { api as requestApi } from "../infrastructure/api";
import type { DeploymentEntry, DeploymentState } from "../domain/deployment";
import type { ReleaseSummary } from "../domain/operations";
import { useCreatorSession } from "./CreatorGate";
interface Readiness {
  ready: boolean;
  errors: Array<{ message: string }>;
  configured: boolean;
  releaseId: string;
  revision: number;
  sha256: string;
  bytes: number;
  files: number;
  publicOrigin: string | null;
  persistentDataRequired: boolean;
}
export default function DeploymentPanel({
  projectId,
  environmentId,
  onMessage,
}: {
  projectId: string;
  environmentId: string;
  onMessage: (message: string) => void;
}) {
  const { session } = useCreatorSession();
  function api<T>(route: string, method = "GET", input?: unknown): Promise<T> {
    const url = new URL(route, window.location.origin);
    url.searchParams.set("environmentId", environmentId);
    return requestApi<T>(url.pathname + url.search, method, input);
  }
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const endpoint = `/api/projects/${projectId}/deployment`;
  const [state, setState] = useState<DeploymentState | null>(null),
    [releases, setReleases] = useState<ReleaseSummary[]>([]),
    [releaseId, setReleaseId] = useState(""),
    [ready, setReady] = useState<Readiness | null>(null),
    [review, setReview] = useState<"publish" | "rollback" | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const [state, versions] = await Promise.all([
      api<DeploymentState>(endpoint),
      api<ReleaseSummary[]>(`/api/projects/${projectId}/releases`),
    ]);
    if (!active.current) return;
    setState(state);
    setReleases(versions.filter((entry) => entry.status === "ready"));
  }, [endpoint, projectId, environmentId]);
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage("");
    try {
      await action();
      if (!active.current) return;
      await load();
      setMessage(success);
      onMessage(success);
    } catch (error) {
      if (!active.current) return;
      const message =
        error instanceof Error
          ? error.message
          : "배포 요청을 처리하지 못했습니다.";
      setMessage(message);
      onMessage(message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setReady(null);
    setReleaseId("");
    setReview(null);
    load().catch((error: unknown) =>
      setMessage(
        error instanceof Error
          ? error.message
          : "배포 정보를 불러오지 못했습니다.",
      ),
    );
  }, [load]);
  function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(
      () =>
        api(endpoint, "PUT", {
          endpoint: form.get("endpoint"),
          allowedHost: form.get("allowedHost"),
          secretRef: form.get("secretRef"),
          publicOrigin: form.get("publicOrigin"),
        }),
      "배포 연결을 저장했습니다. 원격 게시를 완료한 상태는 아닙니다.",
    );
  }
  async function assess(operation?: "publish" | "rollback") {
    await run(async () => {
      const result = await api<Readiness>(
        `${endpoint}/readiness?releaseId=${encodeURIComponent(releaseId)}`,
      );
      setReady(result);
      if (operation && result.ready) setReview(operation);
    }, "게시 준비 검사를 확인했습니다.");
  }
  const status = (entry: DeploymentEntry): string =>
    ({
      preparing: "준비",
      verifying: "공개 검증 중",
      verified: "공개 버전·해시 검증 완료",
      failed: "실패",
      unknown: "원격 결과 불명확",
    })[entry.status];
  return (
    <section aria-label="공개 배포 관리">
      <h3>공개 배포</h3>
      <p>
        로컬 사이트 실행과 공개 게시를 구분합니다. HTTPS 배포 공급자
        계약·도메인·영속 데이터 볼륨을 준비해야 합니다. 공급자가 없으면 게시를
        완료로 표시하지 않습니다.
      </p>
      <p role="status">{busy ? "처리 중…" : message}</p>
      <form
        key={state?.settings?.endpoint ?? "unconfigured"}
        onSubmit={configure}
      >
        <fieldset disabled={busy}>
          <legend>배포 연결</legend>
          <label>
            공급자 HTTPS API
            <input
              name="endpoint"
              type="url"
              defaultValue={state?.settings?.endpoint ?? ""}
              required
            />
          </label>
          <label>
            공급자 허용 호스트
            <input
              name="allowedHost"
              defaultValue={state?.settings?.allowedHost ?? ""}
              required
            />
          </label>
          <label>
            비밀 환경 변수 이름
            <input
              name="secretRef"
              defaultValue={state?.settings?.secretRef ?? ""}
              placeholder={
                session.localOwner
                  ? "DEPLOY_PROVIDER_KEY 또는 TENANT_DEPLOY"
                  : "TENANT_DEPLOY"
              }
              pattern={
                session.localOwner
                  ? "(DEPLOY|TENANT)_[A-Z0-9_]+"
                  : "TENANT_[A-Z0-9_]+"
              }
              required
            />
          </label>
          <label>
            공개 HTTPS 출처
            <input
              name="publicOrigin"
              type="url"
              defaultValue={state?.settings?.publicOrigin ?? ""}
              placeholder="https://www.example.com"
              required
            />
          </label>
          <p>
            서버 PLATFORM_ALLOWED_HOSTS에 공급자와 공개 호스트를 등록하세요.
            실제 비밀값은 서버 환경 변수로만 설정합니다.
          </p>
          <button>연결 저장</button>
        </fieldset>
      </form>
      <p>
        {state?.configured
          ? "환경 변수 준비 · 공개 배포 검증은 별도"
          : "배포 연결 또는 서버 비밀 환경 변수 미설정"}
      </p>
      <button
        type="button"
        disabled={busy || !state?.configured}
        onClick={() =>
          void run(
            () => api(endpoint + "/test", "POST", {}),
            "공급자 연결 응답을 확인했습니다. 게시 검증은 수행하지 않았습니다.",
          )
        }
      >
        공급자 연결 테스트
      </button>
      <label>
        게시할 정상 결과
        <select
          value={releaseId}
          onChange={(event) => {
            setReleaseId(event.target.value);
            setReady(null);
            setReview(null);
          }}
        >
          <option value="">사이트 결과 선택</option>
          {releases.map((release) => (
            <option key={release.id} value={release.id}>
              v{release.revision} · {release.active ? "활성" : "이전 결과"} ·{" "}
              {release.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={busy || !releaseId}
        onClick={() => void assess()}
      >
        게시 준비 검사
      </button>
      {ready && (
        <article>
          <h4>게시 준비 {ready.ready ? "통과" : "미충족"}</h4>
          <p>
            v{ready.revision} · {(ready.bytes / 1024 / 1024).toFixed(1)}MB ·{" "}
            {ready.files}파일
          </p>
          <p>공개 주소: {ready.publicOrigin ?? "미설정"}</p>
          <p>
            패키지 해시: <code>{ready.sha256}</code>
          </p>
          {ready.errors.map((error, index) => (
            <p role="alert" key={index}>
              {error.message}
            </p>
          ))}
          <p>
            현재 운영 DB를 패키지에 넣지 않습니다. 공급자가 기존 영속 볼륨을
            유지해야 합니다.
          </p>
        </article>
      )}
      <div className="button-row">
        <button
          type="button"
          disabled={busy || !releaseId || !state?.configured}
          onClick={() => void assess("publish")}
        >
          공개 게시 검토
        </button>
        <button
          type="button"
          disabled={busy || !releaseId || !state?.configured}
          onClick={() => void assess("rollback")}
        >
          이 버전으로 공개 복원 검토
        </button>
      </div>
      {review && ready && (
        <fieldset>
          <legend>
            {review === "publish" ? "공개 게시" : "공개 버전 복원"} 범위 확인
          </legend>
          <p>
            {ready.publicOrigin}에 v{ready.revision}의 디자인·실행 코드를
            반영합니다. 공급자는 현재 운영 데이터를 유지해야 합니다. 완료는 공개
            health의 프로젝트·버전·릴리스·해시 확인 후 기록합니다.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const key = crypto.randomUUID();
                const entry = await api<DeploymentEntry>(
                  endpoint + "/" + review,
                  "POST",
                  {
                    releaseId,
                    requestKey: key,
                    confirm: true,
                  },
                );
                if (entry.status === "verified" && review === "publish")
                  window.dispatchEvent(
                    new CustomEvent("automade:outcome", {
                      detail: {
                        projectId,
                        environmentId,
                        eventId: `publish:${entry.id}`,
                        metric: "first-publish",
                        value: 1,
                        failed: false,
                      },
                    }),
                  );
                setReview(null);
              }, "공개 사이트의 프로젝트·버전·릴리스·패키지 해시를 확인했습니다.")
            }
          >
            범위 확인 후 {review === "publish" ? "공개 게시" : "공개 버전 복원"}
          </button>
          <button type="button" disabled={busy} onClick={() => setReview(null)}>
            검토 닫기
          </button>
        </fieldset>
      )}
      <h4>배포 이력</h4>
      {state?.history.length ? (
        [...state.history].reverse().map((entry) => (
          <article key={entry.id}>
            <h5>
              v{entry.revision} · {status(entry)}
            </h5>
            <p>
              {entry.operation === "publish" ? "게시" : "공개 복원"} ·{" "}
              {new Date(entry.createdAt).toLocaleString()}
            </p>
            {entry.verifiedAt && (
              <p>검증 {new Date(entry.verifiedAt).toLocaleString()}</p>
            )}
            {entry.errorCode && (
              <p role="alert">
                {entry.errorCode} · 공급자 상태를 확인한 후 같은 결과를
                검증하세요.
              </p>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api(endpoint + "/verify", "POST", { id: entry.id }),
                  "공개 버전과 패키지 해시를 다시 검증했습니다.",
                )
              }
            >
              공개 버전 재검증
            </button>
          </article>
        ))
      ) : (
        <p>배포 이력이 없습니다.</p>
      )}
    </section>
  );
}
