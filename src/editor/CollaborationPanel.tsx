import { useEffect, useRef, useState } from "react";
import type {
  FieldComment,
  PresenceEntry,
  RevisionReview,
} from "../domain/expansion";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import type { RuntimeCollaboration } from "../domain/systemRuntime";
import { api } from "../infrastructure/api";
import { libraryIdentity } from "../infrastructure/library";
import { systemEndpoint } from "./useSystemActions";
import { parseProject } from "../domain/validation";
export default function CollaborationPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const [comments, setComments] = useState<
      (FieldComment & { targetStatus?: "active" | "missing" })[]
    >([]),
    [reviews, setReviews] = useState<RevisionReview[]>([]),
    [presence, setPresence] = useState<PresenceEntry[]>([]),
    [body, setBody] = useState(""),
    [field, setField] = useState("props.title"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [all, setAll] = useState(false),
    [serverRevision, setServerRevision] = useState<number | null>(null),
    [resumeNotice, setResumeNotice] = useState("");
  const scopeKey = `${libraryIdentity()}/${s.project.id}/${x.environmentId}`,
    currentScope = useRef(scopeKey),
    requestSequence = useRef(0),
    cursor = useRef({ scope: "", value: "" });
  const panel = useRef<HTMLDetailsElement>(null);
  currentScope.current = scopeKey;
  const target = s.selectedBlock
    ? `blocks.${s.selectedBlock.id}.${field}`
    : "project";
  async function refresh() {
    const scope = scopeKey,
      request = ++requestSequence.current,
      storageKey = `automade:collaboration:v1:${encodeURIComponent(scope)}`;
    try {
      if (cursor.current.scope !== scope) {
        let value = "";
        try {
          value = localStorage.getItem(storageKey) || "";
        } catch {
          setResumeNotice(
            "이 기기 재개 위치를 보관하지 못했습니다. 현재 상태를 다시 조회합니다.",
          );
        }
        cursor.current = { scope, value };
      }
      let snapshot: RuntimeCollaboration | null = null;
      for (let batch = 0; batch < 3; batch++) {
        snapshot = await api<RuntimeCollaboration>(
          systemEndpoint(
            `runtime/collaboration${cursor.current.value ? "?after=" + encodeURIComponent(cursor.current.value) : ""}`,
            s.project.id,
            x.environmentId,
          ),
        );
        if (
          scope !== currentScope.current ||
          request !== requestSequence.current
        )
          return;
        if (
          !Array.isArray(snapshot.events) ||
          !Array.isArray(snapshot.comments) ||
          !Array.isArray(snapshot.reviews) ||
          !Array.isArray(snapshot.presence) ||
          typeof snapshot.cursor !== "string"
        )
          throw new Error("협업 재개 응답 형식을 확인하세요.");
        cursor.current = { scope, value: snapshot.cursor };
        try {
          localStorage.setItem(storageKey, snapshot.cursor);
        } catch {
          setResumeNotice(
            "협업 위치를 보관하지 못했습니다. 연결 후 현재 상태를 다시 확인합니다.",
          );
        }
        if (snapshot.resetRequired)
          setResumeNotice(
            "재개 위치가 만료되어 현재 의견·승인 상태를 다시 조회했습니다. 편집본은 보존합니다.",
          );
        else if (snapshot.events.length)
          setResumeNotice(
            `저장된 변경 이력을 재개했습니다. 현재 원본과 검토 상태를 확인하세요.${snapshot.hasMore ? " 추가 이력은 다음 조회에서 이어집니다." : ""}`,
          );
        if (!snapshot.hasMore) break;
      }
      if (!snapshot) return;
      setComments(snapshot.comments);
      setReviews(snapshot.reviews);
      setPresence(snapshot.presence);
      setServerRevision(snapshot.projectRevision ?? null);
      setError("");
    } catch (e) {
      if (scope !== currentScope.current || request !== requestSequence.current)
        return;
      setError(e instanceof Error ? e.message : "검토 상태를 확인하세요.");
    }
  }
  useEffect(() => {
    if (!x.scope) return;
    setComments([]);
    setReviews([]);
    setPresence([]);
    setServerRevision(null);
    setResumeNotice("");
    void refresh();
    const timer = setInterval(() => {
      if (
        navigator.onLine &&
        !document.hidden &&
        panel.current?.getClientRects().length
      )
        void refresh();
    }, 15000);
    const reconnect = () => void refresh();
    window.addEventListener("online", reconnect);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", reconnect);
      requestSequence.current++;
    };
  }, [s.project.id, x.environmentId]);
  useEffect(() => {
    if (!x.session.account || !x.scope) return;
    const heartbeat = () => {
      if (
        navigator.onLine &&
        !document.hidden &&
        panel.current?.getClientRects().length
      )
        void x
          .request("presence", "POST", {
            projectId: s.project.id,
            revision: s.project.revision,
            targetPath: target,
          })
          .catch((e) =>
            setError(
              e instanceof Error ? e.message : "동시 편집 상태를 확인하세요.",
            ),
          );
    };
    heartbeat();
    const timer = setInterval(heartbeat, 20000);
    return () => clearInterval(timer);
  }, [s.project.id, s.project.revision, target, x.environmentId]);
  async function run(action: () => Promise<void>) {
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      await action();
      if (scope !== currentScope.current) return;
      await refresh();
    } catch (e) {
      if (scope !== currentScope.current) return;
      setError(e instanceof Error ? e.message : "검토 요청을 확인하세요.");
    } finally {
      if (scope === currentScope.current) setBusy(false);
    }
  }
  return (
    <details ref={panel} className="collaboration-panel">
      <summary>
        필드 의견·문서 검토{" "}
        {comments.filter((c) => !c.resolved).length
          ? `· 미해결 ${comments.filter((c) => !c.resolved).length}`
          : ""}
      </summary>
      <p>
        {s.online ? "온라인" : "오프라인 · 의견과 승인은 연결 후 저장됩니다"} ·
        원본 v{s.project.revision}
      </p>
      {resumeNotice && <p role="status">{resumeNotice}</p>}
      {serverRevision !== null && serverRevision !== s.project.revision && (
        <p>
          서버 원본 v{serverRevision} · 이 기기 원본 v{s.project.revision}.
          의견을 읽어도 문서 변경을 자동 덮어쓰지 않습니다.
        </p>
      )}
      <button
        type="button"
        disabled={busy || !s.online}
        onClick={() =>
          void run(async () => {
            await s.openServerProject(
              parseProject(await api<unknown>(`/api/projects/${s.project.id}`)),
            );
          })
        }
      >
        현재 서버 원본 비교·다시 확인
      </button>
      {presence.map((person) => (
        <p key={person.accountId}>
          {person.displayName} · v{person.revision} · {person.targetPath} ·{" "}
          {new Date(person.expiresAt).toLocaleTimeString()}까지 유효
        </p>
      ))}
      {!presence.length && (
        <p className="hint">
          최근 접속 제작자 기록이 없습니다. 동시 편집 상태는 계정 로그인 후
          공유합니다.
        </p>
      )}
      <label>
        의견 필드
        <select
          value={field}
          onChange={(e) => setField(e.target.value)}
          disabled={!s.selectedBlock}
        >
          {[
            ["props.title", "제목"],
            ["props.body", "본문"],
            ["props.action", "버튼 연결"],
            ["design", "디자인"],
            ["layout", "배치"],
          ].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">{target}</p>
      <label>
        검토 의견
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={5000}
        />
      </label>
      <button
        type="button"
        disabled={busy || !s.online || !body.trim() || !x.can("project.read")}
        onClick={() =>
          void run(async () => {
            if (!(await s.syncProject(s.project)))
              throw new Error("현재 원본 동기화를 먼저 완료하세요.");
            await x.request("comments", "POST", {
              projectId: s.project.id,
              revision: s.project.revision,
              targetPath: target,
              body,
            });
            setBody("");
          })
        }
      >
        현재 필드에 의견 저장
      </button>
      <label className="check">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        전체 필드·해결 의견 보기
      </label>
      {comments
        .filter(
          (c) =>
            all ||
            (!c.resolved &&
              (c.targetPath === target ||
                c.targetPath === "project" ||
                c.targetStatus === "missing")),
        )
        .map((c) => (
          <article className="page-card" key={c.id}>
            <small>
              v{c.revision} · {c.targetPath} · {c.authorId}
            </small>
            <p>{c.body}</p>
            {c.targetStatus === "missing" && (
              <p>
                의견을 남긴 항목이 삭제되거나 이동했습니다. 의견과 작성 당시
                버전을 보존했으니 현재 문서에서 후속 위치를 확인하세요.
              </p>
            )}
            {c.targetStatus === "active" &&
              c.targetPath.startsWith("blocks.") && (
                <button
                  type="button"
                  onClick={() => {
                    const id = c.targetPath.split(".")[1],
                      block = s.project.blocks.find((item) => item.id === id);
                    if (!block) {
                      setError(
                        "해당 항목은 현재 기기 원본에 없습니다. 서버 원본을 비교하세요.",
                      );
                      return;
                    }
                    s.setSelected([block.id]);
                    if (block.pageId !== "*") s.setPageId(block.pageId);
                    s.setInspectorOpen(true);
                    requestAnimationFrame(() =>
                      document
                        .querySelector<HTMLElement>(
                          ".properties input,.properties textarea,.properties select",
                        )
                        ?.focus(),
                    );
                  }}
                >
                  의견 대상 항목 열기
                </button>
              )}
            <button
              type="button"
              disabled={busy || !x.can("project.edit")}
              onClick={() =>
                void run(async () => {
                  await x.request(`comments/${c.id}`, "PUT", {
                    projectId: s.project.id,
                    resolved: !c.resolved,
                  });
                })
              }
            >
              {c.resolved ? "의견 다시 열기" : "해결 표시"}
            </button>
          </article>
        ))}
      <button
        type="button"
        disabled={busy || !x.can("project.edit")}
        onClick={() =>
          void run(async () => {
            if (!(await s.syncProject(s.project)))
              throw new Error("서버 변경 검토를 먼저 완료하세요.");
            await x.request("reviews", "POST", {
              projectId: s.project.id,
              revision: s.project.revision,
            });
          })
        }
      >
        현재 문서 버전 검토 요청
      </button>
      {reviews.map((review) => (
        <article className="page-card" key={review.id}>
          <strong>
            문서 v{review.revision} ·{" "}
            {
              {
                pending: "검토 대기",
                approved: "승인",
                changes_requested: "수정 요청",
              }[review.status]
            }
          </strong>
          <small>
            해시 {review.fingerprint.slice(0, 12)} · 요청자 {review.createdBy}
          </small>
          {review.status === "pending" && (
            <div className="button-row">
              {[
                ["approved", "검토한 현재 버전 승인"],
                ["changes_requested", "수정 요청"],
              ].map(([decision, label]) => (
                <button
                  type="button"
                  key={decision}
                  disabled={
                    busy ||
                    !x.can("review.approve") ||
                    review.revision !== s.project.revision ||
                    review.createdBy === x.session.account?.id
                  }
                  onClick={() => {
                    if (
                      !confirm(
                        `문서 v${review.revision}에 ${label} 결정을 저장합니다. 원본이 바뀌면 승인할 수 없습니다.`,
                      )
                    )
                      return;
                    void run(async () => {
                      await x.request(`reviews/${review.id}`, "PUT", {
                        projectId: s.project.id,
                        decision,
                      });
                    });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </article>
      ))}
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        협업 상태 새로고침
      </button>
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
    </details>
  );
}
