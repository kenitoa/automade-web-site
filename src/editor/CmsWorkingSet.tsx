import { useEffect, useRef, useState } from "react";
import type {
  ContentPage,
  ContentRecordResult,
  ContentTransition,
} from "../domain/contentContracts";
import type {
  ContentCollection,
  ContentRecord,
  CmsValue,
} from "../domain/types";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import { api, ApiError } from "../infrastructure/api";
import { systemEndpoint } from "./useSystemActions";
import EditorDialog from "./EditorDialog";
import ChangeReview from "./ChangeReview";
import CmsLocalizedFields from "./CmsLocalizedFields";
export default function CmsWorkingSet({
  studio: s,
  expansion: x,
  collection,
}: {
  studio: StudioState;
  expansion: ExpansionState;
  collection: ContentCollection;
}) {
  const [page, setPage] = useState<ContentPage | null>(null),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("title"),
    [cursor, setCursor] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [before, setBefore] = useState<ContentRecordResult | null>(null),
    [draft, setDraft] = useState<ContentRecord | null>(null),
    [review, setReview] = useState(false),
    [scheduled, setScheduled] = useState("");
  const current = useRef("");
  const loadSequence = useRef(0);
  current.current = `${s.project.id}/${x.environmentId}/${collection.id}`;
  const endpoint = (suffix: string) =>
    systemEndpoint(
      `content/${collection.id}${suffix}`,
      s.project.id,
      x.environmentId,
    );
  async function load(next = "") {
    const scope = current.current,
      request = ++loadSequence.current;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({
          limit: "20",
          q: query,
          sort,
          ...(next ? { cursor: next } : {}),
        }),
        result = await api<ContentPage>(endpoint("?" + params));
      if (current.current !== scope || request !== loadSequence.current) return;
      if (!Array.isArray(result.records) || typeof result.total !== "number")
        throw new Error("콘텐츠 목록 응답 형식을 확인하세요.");
      setPage(result);
      setCursor(next);
    } catch (e) {
      if (current.current !== scope || request !== loadSequence.current) return;
      setError(
        e instanceof Error ? e.message : "목록 조회를 완료하지 못했습니다.",
      );
      if (e instanceof ApiError && e.status === 409) setCursor("");
    } finally {
      if (current.current === scope && request === loadSequence.current)
        setBusy(false);
    }
  }
  useEffect(() => {
    setPage(null);
    setDraft(null);
    setBefore(null);
    setCursor("");
    if (x.scope) void load();
    return () => {
      loadSequence.current++;
    };
  }, [collection.id, s.project.id, x.environmentId]);
  async function open(id: string) {
    const scope = current.current;
    setBusy(true);
    try {
      const result = await api<ContentRecordResult>(
        endpoint("/" + encodeURIComponent(id)),
      );
      if (current.current !== scope) return;
      setBefore(result);
      setDraft(structuredClone(result.record));
      setReview(false);
      setError("");
    } catch (e) {
      if (current.current !== scope) return;
      setError(
        e instanceof Error ? e.message : "콘텐츠 한 건을 조회하지 못했습니다.",
      );
    } finally {
      if (current.current === scope) setBusy(false);
    }
  }
  const patch = (change: (record: ContentRecord) => void) =>
    setDraft((value) => {
      if (!value) return value;
      const next = structuredClone(value);
      change(next);
      return next;
    });
  async function save() {
    if (!draft || !before) return;
    const scope = current.current,
      submitted = structuredClone(draft);
    setBusy(true);
    try {
      const result = await api<ContentRecordResult>(
        endpoint("/" + draft.id),
        "PUT",
        {
          record: submitted,
          expectedRevision: before.recordRevision,
          commandId: crypto.randomUUID(),
        },
      );
      if (current.current !== scope) return;
      await s.acceptServerRecord(
        collection.id,
        result.record,
        before.recordRevision,
      );
      setBefore(result);
      setDraft(structuredClone(result.record));
      setReview(false);
      await load();
      s.setMessage(
        "선택한 콘텐츠 한 건의 저장을 확인했습니다. 이전 공개본은 발행 교체 전까지 유지됩니다.",
      );
    } catch (e) {
      if (current.current !== scope) return;
      setError(
        e instanceof Error
          ? e.message
          : "저장 충돌을 확인하세요. 편집 입력은 보존했습니다.",
      );
    } finally {
      if (current.current === scope) setBusy(false);
    }
  }
  async function transition(state: ContentTransition["state"]) {
    if (!before) return;
    setBusy(true);
    const scope = current.current;
    try {
      const result = await api<ContentRecordResult>(
        endpoint("/" + before.record.id + "/transitions"),
        "POST",
        {
          state,
          expectedRevision: before.recordRevision,
          commandId: crypto.randomUUID(),
          ...(state === "scheduled"
            ? { publishAt: new Date(scheduled).toISOString() }
            : {}),
        },
      );
      if (current.current !== scope) return;
      await s.acceptServerRecord(
        collection.id,
        result.record,
        before.recordRevision,
      );
      setBefore(result);
      setDraft(structuredClone(result.record));
      await load();
    } catch (e) {
      if (current.current !== scope) return;
      setError(e instanceof Error ? e.message : "검토·발행 상태를 확인하세요.");
    } finally {
      if (current.current === scope) setBusy(false);
    }
  }
  const changed =
    before && draft && JSON.stringify(before.record) !== JSON.stringify(draft);
  return (
    <details className="cms-working-set" open={collection.records.length > 100}>
      <summary>콘텐츠 작업집합 · 레코드별 저장</summary>
      <p>
        전체 문서를 다시 보내지 않고 필요한 자료 20건을 조회합니다. 다른 자료의
        편집과 독립적으로 revision을 검사합니다.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          작업집합 검색
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={200}
          />
        </label>
        <label>
          작업집합 정렬
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="title">제목순</option>
            <option value="-title">제목 역순</option>
            <option value="-publishedAt">최근 공개순</option>
            {collection.schema?.map((field) => (
              <option key={field.id} value={field.id}>
                {field.label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy}>필요한 콘텐츠 조회</button>
      </form>
      {page && (
        <>
          <p>
            전체 {page.total}건 · 현재 {page.records.length}건 · 목록 v
            {page.collectionRevision} · 모델 v{page.schemaRevision}
          </p>
          {page.records.map((record) => (
            <button
              type="button"
              className="project-card"
              key={record.id}
              disabled={busy}
              onClick={() => void open(record.id)}
            >
              {record.title}
              <small>
                작업본 {record.workflow?.state || record.status} · 내용 v
                {record.contentRevision || 0} · 공개본{" "}
                {record.publication
                  ? `v${record.publication.revision}`
                  : "없음"}
              </small>
            </button>
          ))}
          {!page.records.length && <p>조건에 맞는 콘텐츠가 없습니다.</p>}
          <div className="button-row">
            <button
              type="button"
              disabled={busy || !cursor}
              onClick={() => void load()}
            >
              목록 처음부터
            </button>
            <button
              type="button"
              disabled={busy || !page.nextCursor}
              onClick={() => void load(page.nextCursor!)}
            >
              다음 작업집합 20건
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
          title="콘텐츠 한 건 · 독립 변경 검토"
          onClose={() => {
            if (!busy) setDraft(null);
          }}
        >
          <p>
            자료 v{before.recordRevision} · 현재 공개{" "}
            {before.publishedRevision === null
              ? "없음"
              : `v${before.publishedRevision}`}{" "}
            · 공개 순서 {before.publicationSequence}
          </p>
          <fieldset disabled={busy || !s.editable}>
            <legend>작업본 입력</legend>
            {(["title", "slug", "category", "body"] as const).map((key) => (
              <label key={key}>
                {
                  {
                    title: "작업집합 자료 제목",
                    slug: "주소 이름",
                    category: "분류",
                    body: "작업집합 자료 본문",
                  }[key]
                }
                {key === "body" ? (
                  <textarea
                    rows={5}
                    value={draft[key]}
                    onChange={(e) =>
                      patch((record) => {
                        record[key] = e.target.value;
                      })
                    }
                    maxLength={100000}
                  />
                ) : (
                  <input
                    value={draft[key]}
                    onChange={(e) =>
                      patch((record) => {
                        record[key] = e.target.value;
                      })
                    }
                    maxLength={1000}
                  />
                )}
              </label>
            ))}
            {collection.schema?.map((field) => {
              const val = draft.values?.[field.id];
              const update = (next: CmsValue) =>
                patch((record) => {
                  record.values ??= {};
                  record.values[field.id] = next;
                });
              return (
                <label key={field.id}>
                  {field.label}
                  {field.type === "boolean" ? (
                    <input
                      type="checkbox"
                      checked={val === true}
                      onChange={(e) => update(e.target.checked)}
                      disabled={field.readOnly}
                    />
                  ) : field.type === "enum" ? (
                    <select
                      value={String(val ?? "")}
                      onChange={(e) => update(e.target.value)}
                      disabled={field.readOnly}
                    >
                      <option value="">선택</option>
                      {field.options?.map((option) => (
                        <option value={option} key={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={
                        field.type === "number"
                          ? "number"
                          : field.type === "date"
                            ? "date"
                            : "text"
                      }
                      value={
                        typeof val === "string" || typeof val === "number"
                          ? val
                          : Array.isArray(val)
                            ? val.join(",")
                            : ""
                      }
                      onChange={(e) =>
                        update(
                          field.type === "number"
                            ? e.target.value === ""
                              ? null
                              : Number(e.target.value)
                            : field.type === "reference"
                              ? e.target.value
                                  .split(",")
                                  .map((v) => v.trim())
                                  .filter(Boolean)
                              : e.target.value,
                        )
                      }
                      disabled={field.readOnly}
                      required={field.required}
                      min={field.type === "number" ? field.min : undefined}
                      max={field.type === "number" ? field.max : undefined}
                    />
                  )}
                </label>
              );
            })}
          </fieldset>
          <fieldset disabled={busy || !s.editable}>
            <legend>레코드의 언어별 자료·원문 검토</legend>
            {[...new Set(s.project.settings.languages || [])]
              .filter((language) => language !== s.project.settings.language)
              .map((language) => (
                <details key={language}>
                  <summary>
                    {language} ·{" "}
                    {before.translations[language]?.state || "초안"}
                  </summary>
                  {(["title", "body"] as const).map((key) => (
                    <label key={key}>
                      {language} {key === "title" ? "자료 제목" : "자료 본문"}
                      <textarea
                        value={draft.translations?.[language]?.[key] || ""}
                        onChange={(e) =>
                          patch((record) => {
                            record.translations ??= {};
                            record.translations[language] ??= {
                              title: "",
                              body: "",
                            };
                            record.translations[language]![key] =
                              e.target.value;
                          })
                        }
                        maxLength={100000}
                      />
                    </label>
                  ))}
                  <CmsLocalizedFields
                    studio={s}
                    collection={collection}
                    record={draft}
                    language={language}
                    patch={patch}
                  />
                  {(["draft", "review", "approved"] as const).map((state) => (
                    <button
                      type="button"
                      key={state}
                      disabled={
                        Boolean(changed) ||
                        !x.can(
                          state === "approved"
                            ? "review.approve"
                            : "project.edit",
                        )
                      }
                      onClick={() => {
                        const scope = current.current;
                        setBusy(true);
                        void api<ContentRecordResult>(
                          endpoint("/" + before.record.id + "/translations"),
                          "POST",
                          {
                            language,
                            state,
                            expectedRevision: before.recordRevision,
                            commandId: crypto.randomUUID(),
                          },
                        )
                          .then(async (result) => {
                            if (current.current !== scope) return;
                            await s.acceptServerRecord(
                              collection.id,
                              result.record,
                              before.recordRevision,
                            );
                            setBefore(result);
                            setDraft(structuredClone(result.record));
                          })
                          .catch((e) =>
                            setError(
                              e instanceof Error
                                ? e.message
                                : "번역 원문 검토를 확인하세요.",
                            ),
                          )
                          .finally(() => {
                            if (current.current === scope) setBusy(false);
                          });
                      }}
                    >
                      {
                        {
                          draft: "번역 검토 준비",
                          review: "현재 원문 번역 검토 요청",
                          approved: "검토한 원문 번역 승인",
                        }[state]
                      }
                    </button>
                  ))}
                </details>
              ))}
          </fieldset>
          {review ? (
            <>
              <ChangeReview before={before.record} after={draft} />
              <button
                type="button"
                disabled={busy || !s.editable}
                onClick={() => void save()}
              >
                검토한 한 건 실제 저장
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || !changed}
              onClick={() => setReview(true)}
            >
              한 건 변경 검토
            </button>
          )}
          <fieldset disabled={busy || Boolean(changed)}>
            <legend>저장한 현재 자료의 검토·발행</legend>
            <p>
              초안 수정은 이전 공개본을 유지합니다. 발행은 승인된 새 자료로 공개
              포인터를 교체하며, 발행 취소는 별도 동작입니다.
            </p>
            {(
              [
                "review",
                "approved",
                "published",
                "archived",
                "unpublish",
              ] as const
            ).map((state) => (
              <button
                type="button"
                key={state}
                disabled={
                  !x.can(
                    state === "approved"
                      ? "review.approve"
                      : state === "published" || state === "unpublish"
                        ? "project.publish"
                        : "project.edit",
                  )
                }
                onClick={() => void transition(state)}
              >
                {
                  {
                    review: "자료 검토 요청",
                    approved: "현재 자료 승인",
                    published: "승인 자료 공개 교체",
                    archived: "작업본 보관",
                    unpublish: "자료 공개 취소",
                  }[state]
                }
              </button>
            ))}
            <label>
              자료 예약 시각
              <input
                type="datetime-local"
                value={scheduled}
                onChange={(e) => setScheduled(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={!scheduled || !x.can("project.publish")}
              onClick={() => void transition("scheduled")}
            >
              승인 자료 예약 발행
            </button>
          </fieldset>
          {Object.entries(before.translations).map(([language, review]) => (
            <p key={language}>
              {language} · {review.state} · 검토 원문 v{review.sourceRevision} ·
              변경 필드 {review.changedFields.join(", ") || "없음"}
            </p>
          ))}
          {error && (
            <p role="alert" className="bad">
              {error}
            </p>
          )}
        </EditorDialog>
      )}
    </details>
  );
}
