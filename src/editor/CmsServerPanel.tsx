import { useEffect, useState } from "react";
import type { ContentCollection, ContentRecord } from "../domain/types";
import type { CmsManagementPage, CmsUpsertResult } from "../domain/expansion";
import { parseProject } from "../domain/validation";
import type { ExpansionState } from "./useExpansion";
import type { StudioState } from "./useStudio";
import EditorDialog from "./EditorDialog";
import ChangeReview from "./ChangeReview";
export default function CmsServerPanel({
  studio: s,
  expansion: x,
  collection,
}: {
  studio: StudioState;
  expansion: ExpansionState;
  collection: ContentCollection;
}) {
  const [page, setPage] = useState<CmsManagementPage | null>(null),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("title"),
    [cursor, setCursor] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [draft, setDraft] = useState<ContentRecord | null>(null),
    [before, setBefore] = useState<ContentRecord | null>(null),
    [review, setReview] = useState(false);
  async function load(next = "") {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({
        limit: "20",
        q: query,
        sort,
        ...(next ? { cursor: next } : {}),
      });
      setPage(
        await x.request<CmsManagementPage>(
          `cms/${collection.id}/records?${params}`,
        ),
      );
      setCursor(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "콘텐츠 조회를 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    setPage(null);
    setCursor("");
  }, [collection.id]);
  return (
    <details className="cms-server-panel">
      <summary>서버 목록·개별 저장</summary>
      <label>
        방문자 자료 제공 방식
        <select
          value={collection.queryMode || "snapshot"}
          onChange={(e) =>
            s.apply((p) => {
              p.collections!.find((c) => c.id === collection.id)!.queryMode = e
                .target.value as "snapshot" | "server";
            })
          }
        >
          <option value="snapshot">생성 시 공개 콘텐츠 포함</option>
          <option value="server">공개 서버 목록·검색·다음 페이지</option>
        </select>
      </label>
      <p className="hint">
        관리 목록은 초안을 포함해 권한을 검사합니다. 공개 조회는 발행된 자료와
        공개 필드만 제공합니다.
      </p>
      <label>
        서버 콘텐츠 검색
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={200}
        />
      </label>
      <label>
        서버 정렬
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="title">제목 오름차순</option>
          <option value="-title">제목 내림차순</option>
          <option value="-publishedAt">최근 발행순</option>
          {collection.schema?.map((field) => (
            <option key={field.id} value={field.id}>
              {field.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={busy} onClick={() => void load()}>
        서버 목록 조회
      </button>
      {page && (
        <>
          <p>
            전체 {page.total}개 · 표시 {page.records.length}개 · 서버 v
            {page.projectRevision} · 모델 v{page.schemaRevision}
          </p>
          {page.records.map((record) => (
            <button
              type="button"
              className="project-card"
              key={record.id}
              onClick={() => {
                setBefore(structuredClone(record));
                setDraft(structuredClone(record));
                setReview(false);
              }}
            >
              {record.title}
              <small>
                {record.workflow?.state || record.status} · 자료 v
                {record.contentRevision || 0}
              </small>
            </button>
          ))}
          {!page.records.length && <p>조회 조건에 맞는 콘텐츠가 없습니다.</p>}
          <div className="button-row">
            <button
              type="button"
              disabled={busy || !cursor}
              onClick={() => void load()}
            >
              처음부터 조회
            </button>
            <button
              type="button"
              disabled={busy || !page.nextCursor}
              onClick={() => void load(page.nextCursor!)}
            >
              서버 다음 20개
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
      {draft && before && (
        <EditorDialog
          title="콘텐츠 개별 변경·서버 저장"
          onClose={() => setDraft(null)}
        >
          <label>
            서버 자료 제목
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              maxLength={1000}
            />
          </label>
          <label>
            서버 자료 본문
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              maxLength={100000}
              rows={5}
            />
          </label>
          <p>
            자료 {draft.id}만 PUT으로 저장합니다. 서버 v{page?.projectRevision}
            와 현재 편집본 v{s.project.revision}이 같아야 하며 내용 수정 시
            승인·예약은 회수합니다.
          </p>
          {review ? (
            <>
              <ChangeReview before={before} after={draft} />
              <button
                type="button"
                className="primary"
                disabled={
                  busy ||
                  page?.projectRevision !== s.project.revision ||
                  !s.editable
                }
                onClick={() => {
                  setBusy(true);
                  void x
                    .request<CmsUpsertResult>(
                      `cms/${collection.id}/records`,
                      "PUT",
                      {
                        projectId: s.project.id,
                        baseRevision: page!.projectRevision,
                        record: draft,
                      },
                    )
                    .then(async (result) => {
                      await s.acceptServerProject(
                        parseProject(result.project),
                        page!.projectRevision,
                      );
                      setDraft(null);
                      await load();
                      s.setMessage(
                        "선택한 콘텐츠 한 건의 서버 저장을 확인했습니다.",
                      );
                    })
                    .catch((e) =>
                      setError(
                        e instanceof Error
                          ? e.message
                          : "개별 저장 충돌을 확인하세요.",
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                검토한 한 건 저장
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!s.editable}
              onClick={() => setReview(true)}
            >
              변경 내용 검토
            </button>
          )}
        </EditorDialog>
      )}
    </details>
  );
}
