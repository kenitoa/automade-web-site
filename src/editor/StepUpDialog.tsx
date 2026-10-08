import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  setStepUpHandler,
  getProjectContext,
  type StepUpTarget,
} from "../infrastructure/api";
import EditorDialog from "./EditorDialog";
import { stepUpScope } from "../infrastructure/stepUpContext";
import type { ExpansionState } from "./useExpansion";
import ChangeReview from "./ChangeReview";
function reviewInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviewInput);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|secret|token|value|recovery|code/i.test(key)
          ? "입력됨 · 원문 표시 안 함"
          : reviewInput(item),
      ]),
    );
  return value;
}
export default function StepUpDialog({
  expansion: x,
}: {
  expansion: ExpansionState;
}) {
  const [request, setRequest] = useState<
      | (StepUpTarget & {
          resolve: (token: string) => void;
          reject: (error: Error) => void;
        })
      | null
    >(null),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [recovery, setRecovery] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const pending = new Set<(error: Error) => void>();
    setStepUpHandler(
      (target) =>
        new Promise((resolve, reject) => {
          const fail = (error: Error) => {
            pending.delete(fail);
            reject(error);
          };
          pending.add(fail);
          setPassword("");
          setCode("");
          setError("");
          setRequest((current) => {
            if (current)
              current.reject(
                new ApiError(
                  "다른 추가 인증 요청을 먼저 확인하세요.",
                  "STEP_UP_CANCELLED",
                  409,
                ),
              );
            return {
              ...target,
              resolve: (token) => {
                pending.delete(fail);
                resolve(token);
              },
              reject: fail,
            };
          });
        }),
    );
    return () => {
      setStepUpHandler(null);
      for (const reject of pending)
        reject(
          new ApiError(
            "제작자 세션이 종료되어 추가 인증을 중지했습니다.",
            "SESSION_CHANGED",
            401,
          ),
        );
    };
  }, []);
  const close = () => {
    request?.reject(
      new ApiError(
        "추가 인증을 취소했습니다. 검토한 입력과 변경은 보존됩니다.",
        "STEP_UP_CANCELLED",
        403,
      ),
    );
    setRequest(null);
    setPassword("");
    setCode("");
  };
  async function verify() {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      const url = new URL(request.path, window.location.origin),
        scope = stepUpScope(
          request,
          window.location.origin,
          getProjectContext(),
          x.bootstrap,
        ),
        params = new URLSearchParams({ ...scope });
      const proof = await api<{ token: string; expiresAt: string }>(
        `/api/advancement/security/step-up?${params}`,
        "POST",
        {
          password,
          ...(recovery ? { recoveryCode: code } : { code }),
          method: request.method,
          path: url.pathname,
          ...scope,
          payload: request.payload,
        },
      );
      request.resolve(proof.token);
      setRequest(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "인증 코드를 다시 확인하세요.");
    } finally {
      setPassword("");
      setCode("");
      setBusy(false);
    }
  }
  if (!request) return null;
  return (
    <EditorDialog
      title="검토한 고위험 작업 · 일회성 추가 인증"
      onClose={() => {
        if (!busy) close();
      }}
    >
      <p>
        이 요청의 대상·입력·제작자 세션을 확인합니다. 인증 후 검토한 같은
        요청에만 토큰을 한 번 사용합니다.
      </p>
      <p>
        {request.method} · {request.path.split("?")[0]}
      </p>
      <ChangeReview before={{}} after={reviewInput(request.payload)} />
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
        일회용 복구 코드 사용
      </label>
      <label>
        {recovery ? "복구 코드" : "인증 앱 코드"}
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          maxLength={recovery ? 64 : 6}
        />
      </label>
      <p>
        인증 앱이 없으면 요청을 취소하고 운영 → 시스템 고도화 → 추가 인증에서
        먼저 등록하세요.
      </p>
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={busy || !password || !code}
        onClick={() => void verify()}
      >
        {busy ? "인증 확인 중…" : "이 작업만 인증·계속"}
      </button>
      <button type="button" disabled={busy} onClick={close}>
        인증 취소·입력 보존
      </button>
    </EditorDialog>
  );
}
