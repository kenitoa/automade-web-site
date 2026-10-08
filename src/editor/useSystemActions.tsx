import { useRef, useState } from "react";
import { api } from "../infrastructure/api";
import type { StepUpInput } from "../domain/advancement";
import type { ExpansionState } from "./useExpansion";
import type { StudioState } from "./useStudio";
import EditorDialog from "./EditorDialog";
import ChangeReview from "./ChangeReview";
export interface SystemAction {
  label: string;
  path: string;
  method: string;
  payload: unknown;
  before?: unknown;
  after?: unknown;
  stepUp?: boolean;
  success?: (result: unknown) => Promise<void> | void;
}
export function systemEndpoint(
  path: string,
  projectId: string,
  environmentId: string,
): string {
  const [route, query = ""] = path.split("?"),
    params = new URLSearchParams(query);
  params.set("projectId", projectId);
  params.set("environmentId", environmentId);
  return `${route?.startsWith("/api/") ? route : "/api/advancement/" + route}?${params}`;
}
export function useSystemActions(s: StudioState, x: ExpansionState) {
  const [action, setAction] = useState<
      | (SystemAction & {
          projectId: string;
          environmentId: string;
          operationId: string;
        })
      | null
    >(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [recovery, setRecovery] = useState(false);
  const endpoint = (path: string) =>
    systemEndpoint(path, s.project.id, x.environmentId);
  const current = useRef({
    projectId: s.project.id,
    environmentId: x.environmentId,
  });
  current.current = { projectId: s.project.id, environmentId: x.environmentId };
  const review = (next: SystemAction) => {
    setError("");
    setPassword("");
    setCode("");
    setAction({
      ...next,
      projectId: s.project.id,
      environmentId: x.environmentId,
      operationId: crypto.randomUUID(),
    });
  };
  async function apply() {
    if (!action) return;
    if (
      action.projectId !== s.project.id ||
      action.environmentId !== x.environmentId
    ) {
      setError(
        "검토 이후 사이트·환경이 바뀌었습니다. 현재 대상에서 다시 검토하세요.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const route = systemEndpoint(
        action.path,
        action.projectId,
        action.environmentId,
      );
      let token = "";
      if (action.stepUp && !x.session.localOwner) {
        const input: StepUpInput = {
          password,
          ...(recovery ? { recoveryCode: code } : { code }),
          method: action.method,
          path: route.split("?")[0]!,
          projectId: action.projectId,
          environmentId: action.environmentId,
          payload: action.payload,
        };
        const proof = await api<{ token: string; expiresAt: string }>(
          endpoint("security/step-up"),
          "POST",
          input,
        );
        token = proof.token;
        setPassword("");
        setCode("");
      }
      if (
        current.current.projectId !== action.projectId ||
        current.current.environmentId !== action.environmentId
      )
        throw new Error(
          "인증 중 사이트·환경이 변경되었습니다. 현재 대상을 다시 검토하세요.",
        );
      const result = await api<unknown>(
        route,
        action.method,
        action.payload,
        undefined,
        token ? { "X-Step-Up-Token": token } : undefined,
      );
      if (
        current.current.projectId !== action.projectId ||
        current.current.environmentId !== action.environmentId
      ) {
        setAction(null);
        s.setMessage(
          "이전 환경 요청 결과는 해당 환경에 저장되었습니다. 현재 범위의 내용을 유지합니다.",
        );
        return;
      }
      await action.success?.(result);
      if (
        result &&
        typeof result === "object" &&
        "status" in result &&
        ["completed", "verified", "succeeded"].includes(String(result.status))
      )
        window.dispatchEvent(
          new CustomEvent("automade:outcome", {
            detail: {
              projectId: action.projectId,
              environmentId: action.environmentId,
              eventId: `task:${action.operationId}`,
              metric: "task-completed",
              value: 1,
              failed: false,
            },
          }),
        );
      setAction(null);
      s.setMessage(
        `${action.label} 요청의 서버 결과를 확인했습니다. 외부 공개·전달 상태는 해당 업무에서 확인하세요.`,
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "요청을 완료하지 못했습니다. 검토한 입력을 보존했습니다.",
      );
    } finally {
      setPassword("");
      setCode("");
      setBusy(false);
    }
  }
  const dialog = action && (
    <EditorDialog
      title={action.label + " · 적용 범위 검토"}
      onClose={() => {
        if (!busy) {
          setAction(null);
          setPassword("");
          setCode("");
        }
      }}
    >
      <p>
        {s.project.name} ·{" "}
        {x.bootstrap?.environments.find(
          (env) => env.id === action.environmentId,
        )?.name || "기본 환경"}{" "}
        · {action.method} 요청
      </p>
      <ChangeReview
        before={action.before ?? {}}
        after={
          action.path === "secrets/versions" &&
          action.payload &&
          typeof action.payload === "object"
            ? { ...action.payload, value: "새 비밀값 입력됨 · 원문 표시 안 함" }
            : (action.after ?? action.payload)
        }
      />
      <p>
        검토한 대상과 입력만 적용합니다. 다른 환경의 비밀값·운영 자료를 복제하지
        않습니다.
      </p>
      {action.stepUp && !x.session.localOwner && (
        <fieldset>
          <legend>이 작업의 일회성 추가 인증</legend>
          <label>
            현재 제작자 비밀번호
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={recovery}
              onChange={(e) => setRecovery(e.target.checked)}
            />
            복구 코드 사용
          </label>
          <label>
            {recovery ? "일회용 복구 코드" : "인증 앱 코드"}
            <input
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={recovery ? 64 : 6}
            />
          </label>
          <p>인증 정보와 일회성 토큰은 브라우저 저장소에 남기지 않습니다.</p>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      <button
        type="button"
        className="primary"
        disabled={
          busy ||
          (Boolean(action.stepUp) &&
            !x.session.localOwner &&
            (!password || !code))
        }
        onClick={() => void apply()}
      >
        {busy ? "서버 적용·결과 확인 중…" : "검토한 작업 실제 적용"}
      </button>
    </EditorDialog>
  );
  return { endpoint, review, dialog, busy, error, setError };
}
