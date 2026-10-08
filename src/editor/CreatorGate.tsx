import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, setCreatorCsrf, setProjectContext } from "../infrastructure/api";
import { setLibraryNamespace } from "../infrastructure/library";
import { record } from "../domain/validation";
import type { CreatorSession } from "../domain/expansion";

const CreatorContext = createContext<{
  session: CreatorSession;
  logout: () => Promise<void>;
} | null>(null);
export function useCreatorSession() {
  const context = useContext(CreatorContext);
  if (!context) throw new Error("제작자 세션을 확인하세요.");
  return context;
}
function parseSession(value: unknown): CreatorSession {
  const data = record(value);
  if (typeof data.csrf !== "string" || typeof data.localOwner !== "boolean")
    throw new Error("제작자 세션 응답을 확인하지 못했습니다.");
  const account = data.account === null ? null : record(data.account);
  if (
    account &&
    (typeof account.id !== "string" ||
      typeof account.email !== "string" ||
      typeof account.displayName !== "string")
  )
    throw new Error("제작자 계정 응답을 확인하지 못했습니다.");
  return {
    csrf: data.csrf,
    localOwner: data.localOwner,
    account: account
      ? {
          id: String(account.id),
          email: String(account.email),
          displayName: String(account.displayName),
        }
      : null,
  };
}
export default function CreatorGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<CreatorSession | null>(null),
    [mode, setMode] = useState("login"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const next = parseSession(await api<unknown>("/api/expansion/session"));
      setCreatorCsrf(next.csrf);
      setLibraryNamespace(next.localOwner ? null : next.account?.id || null);
      setSession(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "제작자 연결을 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
    const expired = () => {
      setSession(null);
      setCreatorCsrf("");
      setProjectContext(null);
      setLibraryNamespace(null);
      void refresh();
    };
    window.addEventListener("automade:creator-expired", expired);
    return () =>
      window.removeEventListener("automade:creator-expired", expired);
  }, []);
  async function logout() {
    setBusy(true);
    try {
      await api("/api/expansion/logout", "POST", {});
      setSession(null);
      setCreatorCsrf("");
      setProjectContext(null);
      setLibraryNamespace(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const fields = Object.fromEntries(form.entries());
      const result = await api<unknown>(
        `/api/expansion/${mode === "register" ? "accounts" : mode === "reset" ? "password-reset/request" : mode === "confirm" ? "password-reset/confirm" : "login"}`,
        "POST",
        fields,
      );
      if (mode === "reset") {
        const delivery = record(result).delivery;
        setNotice(
          delivery === "pending"
            ? "등록 여부와 관계없이 재설정 요청을 접수했습니다. 설정된 발송 대기열의 결과를 확인하세요."
            : "등록 여부와 관계없이 재설정 요청을 접수했습니다. 재설정 메일 공급자가 연결되지 않아 발송되지 않았습니다. 조직 관리자에게 복구를 요청하세요.",
        );
      } else if (mode === "confirm") {
        setMode("login");
        setNotice(
          "비밀번호 재설정 결과를 확인했습니다. 새 비밀번호로 로그인하세요.",
        );
      } else if (mode === "register") {
        setMode("login");
        setNotice(
          "제작자 계정 등록을 확인했습니다. 등록한 계정으로 로그인하세요.",
        );
        await refresh();
      } else await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "계정 요청을 처리하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (session && (session.localOwner || session.account))
    return (
      <CreatorContext.Provider value={{ session, logout }}>
        {children}
      </CreatorContext.Provider>
    );
  return (
    <main className="creator-gate">
      <div className="creator-card">
        <h1>Automade 제작 작업 공간</h1>
        <p>제작자 계정은 생성 사이트 방문자 계정과 별도로 관리합니다.</p>
        {!session ? (
          <>
            <p role="status">
              {busy ? "제작자 서비스 연결 중…" : "제작자 서비스를 확인하세요."}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              연결 다시 확인
            </button>
          </>
        ) : (
          <>
            <div className="panel-tabs">
              {[
                ["login", "로그인"],
                ["register", "계정 만들기"],
                ["reset", "재설정 요청"],
                ["confirm", "재설정 완료"],
              ].map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={mode === id}
                  onClick={() => {
                    setMode(id!);
                    setError("");
                    setNotice("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <form onSubmit={submit}>
              {mode !== "confirm" && (
                <label>
                  제작자 이메일
                  <input
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    maxLength={254}
                  />
                </label>
              )}
              {mode === "register" && (
                <label>
                  제작자 초대 토큰 · 초대받은 경우
                  <input
                    name="inviteToken"
                    autoComplete="off"
                    maxLength={100}
                  />
                </label>
              )}
              {mode === "register" && (
                <label>
                  이름
                  <input
                    name="displayName"
                    required
                    maxLength={100}
                    autoComplete="name"
                  />
                </label>
              )}
              {mode === "confirm" && (
                <label>
                  일회용 재설정 토큰
                  <input name="token" required autoComplete="off" />
                </label>
              )}
              {mode !== "reset" && (
                <label>
                  비밀번호
                  <input
                    name="password"
                    type="password"
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                    minLength={mode === "login" ? 1 : 12}
                    maxLength={200}
                    required
                  />
                </label>
              )}
              <button className="primary" disabled={busy}>
                {busy
                  ? "처리 중…"
                  : mode === "register"
                    ? "제작자 계정 등록"
                    : mode === "reset"
                      ? "재설정 요청"
                      : mode === "confirm"
                        ? "새 비밀번호 저장"
                        : "제작자 로그인"}
              </button>
            </form>
          </>
        )}
        {error && (
          <p role="alert" className="bad">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </main>
  );
}
