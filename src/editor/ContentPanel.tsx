import { lazy, Suspense, useState } from "react";
import { uid } from "../domain/catalog";
import type { ContentRecord } from "../domain/types";
import type { StudioState } from "./useStudio";
const CmsModelEditor = lazy(() => import("./CmsModelEditor"));
const CmsRecordValues = lazy(() => import("./CmsRecordValues"));
import { editContentRecord } from "../domain/cms";
import { languageLabel } from "../domain/languages";
const CmsServerPanel = lazy(() => import("./CmsServerPanel"));
const CmsLocalizedFields = lazy(() => import("./CmsLocalizedFields"));
const CmsWorkingSet = lazy(() => import("./CmsWorkingSet"));
export default function ContentPanel({
  studio: s,
  expansion,
}: {
  studio: StudioState;
  expansion: import("./useExpansion").ExpansionState;
}) {
  const [selected, setSelected] = useState(""),
    [recordId, setRecordId] = useState(""),
    [fieldName, setFieldName] = useState(""),
    [recordPage, setRecordPage] = useState(0);
  const collection =
      (s.project.collections || []).find((x) => x.id === selected) ||
      s.project.collections?.[0],
    record = collection?.records.find((x) => x.id === recordId);
  const patch = (
    change: (record: ContentRecord) => void,
    contentChange = true,
  ) =>
    s.apply((p) => {
      const target = p.collections
        ?.find((x) => x.id === collection?.id)
        ?.records.find((x) => x.id === recordId);
      if (target) {
        const next = structuredClone(target);
        change(next);
        Object.assign(
          target,
          contentChange
            ? {
                ...next,
                ...editContentRecord(next, {}),
                contentRevision: (target.contentRevision || 0) + 1,
              }
            : next,
        );
      }
    });
  return (
    <details className="content-management">
      <Suspense fallback={<p role="status">콘텐츠 편집 도구 불러오는 중…</p>}>
        <summary>콘텐츠 컬렉션</summary>
        <p className="hint">
          글·사례·공지 데이터를 한 번 입력하고 카드와 상세 페이지에 연결합니다.
          초안은 생성 사이트에 공개되지 않습니다.
        </p>
        <button
          type="button"
          onClick={() => {
            const id = uid();
            s.apply((p) => {
              p.collections ??= [];
              p.collections.push({
                id,
                name: "새 컬렉션",
                path: `/content-${p.collections.length + 1}`,
                records: [],
              });
            });
            setSelected(id);
            setRecordId("");
          }}
        >
          컬렉션 추가
        </button>
        <label>
          컬렉션 선택
          <select
            value={collection?.id || ""}
            onChange={(e) => {
              setSelected(e.target.value);
              setRecordId("");
            }}
          >
            <option value="">선택하세요</option>
            {s.project.collections?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        {collection ? (
          <>
            <CmsWorkingSet
              key={collection.id}
              studio={s}
              expansion={expansion}
              collection={collection}
            />
            <CmsModelEditor
              key={
                s.project.id +
                ":" +
                expansion.environmentId +
                ":" +
                collection.id +
                ":" +
                (collection.schemaRevision || 0)
              }
              collection={collection}
              studio={s}
              expansion={expansion}
            />
            <CmsServerPanel
              studio={s}
              expansion={expansion}
              collection={collection}
            />
            <label>
              컬렉션 이름
              <input
                value={collection.name}
                onChange={(e) =>
                  s.apply((p) => {
                    p.collections!.find((x) => x.id === collection.id)!.name =
                      e.target.value;
                  })
                }
              />
            </label>
            <label>
              콘텐츠 접근
              <select
                value={collection.access || "public"}
                onChange={(e) =>
                  s.apply((p) => {
                    p.collections!.find((x) => x.id === collection.id)!.access =
                      e.target.value as "public" | "members";
                  })
                }
              >
                <option value="public">모든 방문자</option>
                <option value="members">로그인한 회원</option>
              </select>
            </label>
            <label>
              상세 주소 시작 경로
              <input
                value={collection.path}
                onChange={(e) =>
                  s.apply((p) => {
                    p.collections!.find((x) => x.id === collection.id)!.path =
                      e.target.value;
                  })
                }
              />
            </label>
            <button
              type="button"
              onClick={() => {
                const id = uid();
                s.apply((p) => {
                  p.collections!.find(
                    (x) => x.id === collection.id,
                  )!.records.push({
                    id,
                    slug: `item-${collection.records.length + 1}`,
                    title: "새 콘텐츠",
                    body: "",
                    category: "",
                    imageId: "",
                    status: "draft",
                    publishedAt: "",
                    fields: {},
                  });
                });
                setRecordId(id);
              }}
            >
              콘텐츠 추가
            </button>
            {collection.records
              .slice(recordPage * 20, recordPage * 20 + 20)
              .map((x) => (
                <button
                  type="button"
                  className="project-card"
                  key={x.id}
                  onClick={() => setRecordId(x.id)}
                >
                  {x.title}
                  <small>
                    {x.status === "draft" ? "초안" : "공개"} · {x.slug}
                  </small>
                </button>
              ))}
            {collection.records.length > 20 && (
              <div className="button-row">
                <button
                  type="button"
                  disabled={!recordPage}
                  onClick={() => setRecordPage((page) => page - 1)}
                >
                  기기 콘텐츠 이전 20개
                </button>
                <span>
                  기기 목록 {recordPage + 1} /{" "}
                  {Math.ceil(collection.records.length / 20)}
                </span>
                <button
                  type="button"
                  disabled={(recordPage + 1) * 20 >= collection.records.length}
                  onClick={() => setRecordPage((page) => page + 1)}
                >
                  기기 콘텐츠 다음 20개
                </button>
              </div>
            )}
            {record ? (
              <fieldset>
                <legend>콘텐츠 편집</legend>
                <CmsRecordValues
                  expansion={expansion}
                  key={record.id}
                  studio={s}
                  collection={collection}
                  record={record}
                  patch={patch}
                />
                {(["title", "slug", "category", "body"] as const).map((key) => (
                  <label key={key}>
                    {
                      {
                        title: "제목",
                        slug: "주소 이름",
                        category: "분류",
                        body: "본문",
                      }[key]
                    }
                    {key === "body" ? (
                      <textarea
                        value={record[key]}
                        onChange={(e) =>
                          patch((x) => {
                            x[key] = e.target.value;
                          })
                        }
                      />
                    ) : (
                      <input
                        value={record[key]}
                        onChange={(e) =>
                          patch((x) => {
                            x[key] = e.target.value;
                          })
                        }
                      />
                    )}
                  </label>
                ))}
                <details>
                  <summary>콘텐츠 번역</summary>
                  <p className="hint">
                    언어별 제목과 본문입니다. 빈 번역은 원문을 사용합니다.
                    사이트 설정의 지원 언어를 켜면 해당 언어 주소에서
                    표시합니다.
                  </p>
                  {[
                    ...new Set([
                      s.project.settings.language,
                      ...(s.project.settings.languages || []),
                      "ko",
                      "en",
                    ]),
                  ].map((language) => (
                    <fieldset key={language}>
                      <legend>{languageLabel(language)}</legend>
                      <CmsLocalizedFields
                        studio={s}
                        collection={collection}
                        record={record}
                        language={language}
                        patch={patch}
                      />
                      {(["title", "body"] as const).map((key) => (
                        <label key={key}>
                          {language === "ko"
                            ? "한국어"
                            : language === "en"
                              ? "영어"
                              : languageLabel(language)}{" "}
                          {key === "title" ? "제목" : "본문"}
                          {key === "body" ? (
                            <textarea
                              value={
                                record.translations?.[language]?.[key] || ""
                              }
                              placeholder={record[key]}
                              onChange={(e) =>
                                patch((x) => {
                                  x.translations ??= {};
                                  x.translations[language] = {
                                    ...(x.translations[language] || {
                                      title: "",
                                      body: "",
                                    }),
                                    [key]: e.target.value,
                                  };
                                })
                              }
                            />
                          ) : (
                            <input
                              value={
                                record.translations?.[language]?.[key] || ""
                              }
                              placeholder={record[key]}
                              onChange={(e) =>
                                patch((x) => {
                                  x.translations ??= {};
                                  x.translations[language] = {
                                    ...(x.translations[language] || {
                                      title: "",
                                      body: "",
                                    }),
                                    [key]: e.target.value,
                                  };
                                })
                              }
                            />
                          )}
                        </label>
                      ))}
                    </fieldset>
                  ))}
                </details>
                <label>
                  상태
                  <select
                    value={record.status}
                    disabled={Boolean(record.workflow)}
                    onChange={(e) =>
                      patch((x) => {
                        x.status = e.target.value as "draft" | "published";
                        if (x.status === "published" && !x.publishedAt)
                          x.publishedAt = new Date().toISOString();
                      }, false)
                    }
                  >
                    <option value="draft">초안</option>
                    <option value="published">공개</option>
                  </select>
                </label>
                <label>
                  이미지
                  <select
                    value={record.imageId}
                    onChange={(e) =>
                      patch((x) => {
                        x.imageId = e.target.value;
                      })
                    }
                  >
                    <option value="">없음</option>
                    {s.project.assets.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
                {Object.entries(record.fields).map(([key, value]) => (
                  <div key={key}>
                    <label>
                      {key}
                      <input
                        value={value}
                        onChange={(e) =>
                          patch((x) => {
                            x.fields[key] = e.target.value;
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        patch((x) => {
                          delete x.fields[key];
                        })
                      }
                    >
                      필드 삭제
                    </button>
                  </div>
                ))}
                <label>
                  추가 필드 이름
                  <input
                    value={fieldName}
                    onChange={(e) => setFieldName(e.target.value)}
                    maxLength={100}
                  />
                </label>
                <button
                  type="button"
                  disabled={!fieldName.trim()}
                  onClick={() => {
                    patch((x) => {
                      x.fields[fieldName.trim()] = "";
                    });
                    setFieldName("");
                  }}
                >
                  필드 추가
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    s.apply((p) => {
                      const c = p.collections!.find(
                        (x) => x.id === collection.id,
                      )!;
                      c.records = c.records.filter((x) => x.id !== recordId);
                    });
                    setRecordId("");
                  }}
                >
                  콘텐츠 삭제
                </button>
              </fieldset>
            ) : null}
          </>
        ) : (
          <p>아직 컬렉션이 없습니다.</p>
        )}
      </Suspense>
    </details>
  );
}
