import { uid } from "../domain/catalog";
import {
  deletePage,
  duplicatePage,
  historyChange,
  setHomePage,
} from "../domain/commands";
import type { StudioState } from "./useStudio";
import { lazy, Suspense } from "react";
const ContentPanel = lazy(() => import("./ContentPanel"));
import { languageLabel } from "../domain/languages";
export default function PagePanel({
  studio: s,
  expansion,
}: {
  studio: StudioState;
  expansion: import("./useExpansion").ExpansionState;
}) {
  const p = s.project;
  const update = (
    id: string,
    change: (page: (typeof p.pages)[number]) => void,
  ) =>
    s.apply((x) => {
      change(x.pages.find((page) => page.id === id)!);
    });
  return (
    <>
      <button
        type="button"
        className="secondary full"
        onClick={() => {
          const page = {
            id: uid(),
            title: "새 페이지",
            path: `/page-${p.pages.length + 1}`,
            description: "",
            published: true,
            home: false,
          };
          s.apply((x) => {
            x.pages.push(page);
          });
          s.setPageId(page.id);
          s.setSelected([]);
        }}
      >
        페이지 추가
      </button>
      {p.pages.map((page, index) => (
        <article
          className={`page-card ${page.id === s.activePage.id ? "active" : ""}`}
          key={page.id}
        >
          <button
            type="button"
            className="page-select"
            onClick={() => {
              s.setPageId(page.id);
              s.setSelected([]);
            }}
          >
            {page.home ? "⌂ " : ""}
            {page.title}
          </button>
          {page.id === s.activePage.id ? (
            <>
              <label>
                제목
                <input
                  value={page.title}
                  onChange={(e) =>
                    update(page.id, (x) => {
                      x.title = e.target.value;
                    })
                  }
                />
              </label>
              <label>
                주소
                <input
                  value={page.path}
                  onChange={(e) =>
                    update(page.id, (x) => {
                      x.path = e.target.value;
                    })
                  }
                />
              </label>
              <label>
                검색 설명
                <textarea
                  rows={2}
                  value={page.description}
                  onChange={(e) =>
                    update(page.id, (x) => {
                      x.description = e.target.value;
                    })
                  }
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={page.published}
                  onChange={(e) =>
                    update(page.id, (x) => {
                      x.published = e.target.checked;
                    })
                  }
                />
                공개 페이지
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={page.navigation !== false}
                  onChange={(e) =>
                    update(page.id, (x) => {
                      x.navigation = e.target.checked;
                    })
                  }
                />
                메뉴에 표시
              </label>
              <label>
                페이지 접근
                <select
                  value={page.access || "public"}
                  disabled={page.home}
                  onChange={(e) =>
                    update(page.id, (x) => {
                      x.access = e.target.value as "public" | "members";
                    })
                  }
                >
                  <option value="public">모든 방문자</option>
                  <option value="members">로그인한 회원</option>
                </select>
              </label>
              <label>
                이전 주소 (한 줄에 하나)
                <textarea
                  value={(page.aliases || []).join("\n")}
                  onChange={(e) =>
                    update(page.id, (x) => {
                      x.aliases = e.target.value
                        .split("\n")
                        .map((x) => x.trim())
                        .filter(Boolean);
                    })
                  }
                />
              </label>
              <details>
                <summary>검색·공유 미리보기</summary>
                <label>
                  검색 제목
                  <input
                    value={page.seo?.title || ""}
                    placeholder={page.title}
                    onChange={(e) =>
                      update(page.id, (x) => {
                        x.seo = {
                          ...{
                            title: "",
                            description: "",
                            imageAssetId: "",
                            noIndex: false,
                          },
                          ...x.seo,
                          title: e.target.value,
                        };
                      })
                    }
                  />
                </label>
                <label>
                  공유 이미지
                  <select
                    value={page.seo?.imageAssetId || ""}
                    onChange={(e) =>
                      update(page.id, (x) => {
                        x.seo = {
                          ...{
                            title: "",
                            description: "",
                            imageAssetId: "",
                            noIndex: false,
                          },
                          ...x.seo,
                          imageAssetId: e.target.value,
                        };
                      })
                    }
                  >
                    <option value="">없음</option>
                    {p.assets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={page.seo?.noIndex || false}
                    onChange={(e) =>
                      update(page.id, (x) => {
                        x.seo = {
                          ...{
                            title: "",
                            description: "",
                            imageAssetId: "",
                            noIndex: false,
                          },
                          ...x.seo,
                          noIndex: e.target.checked,
                        };
                      })
                    }
                  />
                  검색 색인 제외
                </label>
                <div className="seo-preview">
                  <small>
                    {p.settings.siteUrl || "공개 주소 미설정"}
                    {page.path}
                  </small>
                  <strong>
                    {page.seo?.title || page.title} · {p.name}
                  </strong>
                  <p>
                    {page.seo?.description ||
                      page.description ||
                      p.settings.description ||
                      "검색 설명을 입력하세요."}
                  </p>
                </div>
              </details>
              <details>
                <summary>페이지 번역</summary>
                {[
                  ...new Set([
                    p.settings.language,
                    ...(p.settings.languages || []),
                    "ko",
                    "en",
                  ]),
                ].map((language) => (
                  <fieldset key={language}>
                    <legend>
                      {languageLabel(language)} ({language})
                    </legend>
                    {(["title", "description"] as const).map((key) => (
                      <label key={key}>
                        {key}
                        <input
                          value={page.translations?.[language]?.[key] || ""}
                          onChange={(e) =>
                            update(page.id, (x) => {
                              x.translations ??= {};
                              x.translations[language] = {
                                title: "",
                                description: "",
                                ...x.translations[language],
                                [key]: e.target.value,
                              };
                            })
                          }
                        />
                      </label>
                    ))}
                  </fieldset>
                ))}
              </details>
              <div className="button-row">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() =>
                    s.apply((x) => {
                      const item = x.pages.splice(index, 1)[0]!;
                      x.pages.splice(index - 1, 0, item);
                    })
                  }
                >
                  메뉴 순서 위로
                </button>
                <button
                  type="button"
                  disabled={index === p.pages.length - 1}
                  onClick={() =>
                    s.apply((x) => {
                      const item = x.pages.splice(index, 1)[0]!;
                      x.pages.splice(index + 1, 0, item);
                    })
                  }
                >
                  메뉴 순서 아래로
                </button>
                <button
                  type="button"
                  onClick={() =>
                    s.setHistory((current) =>
                      historyChange(
                        current,
                        duplicatePage(current.present, page.id),
                      ),
                    )
                  }
                >
                  페이지 복제
                </button>
                <button
                  type="button"
                  disabled={page.home}
                  onClick={() =>
                    s.setHistory((current) =>
                      historyChange(
                        current,
                        setHomePage(current.present, page.id),
                      ),
                    )
                  }
                >
                  홈으로 설정
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={p.pages.length === 1}
                  onClick={() => {
                    if (
                      window.confirm(
                        "페이지와 블록을 삭제하고 연결된 이동을 해제할까요? 실행 취소로 복구할 수 있습니다.",
                      )
                    ) {
                      const next = deletePage(p, page.id);
                      s.setHistory((current) => historyChange(current, next));
                      s.setPageId(next.pages[0]!.id);
                      s.setSelected([]);
                    }
                  }}
                >
                  페이지 삭제
                </button>
              </div>
            </>
          ) : null}
        </article>
      ))}
      <Suspense fallback={<p role="status">콘텐츠 컬렉션 도구 불러오는 중…</p>}>
        <ContentPanel studio={s} expansion={expansion} />
      </Suspense>
    </>
  );
}
