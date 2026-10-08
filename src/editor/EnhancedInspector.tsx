import { lazy, Suspense, useState } from "react";
import type {
  Block,
  Design,
  ResponsiveStyle,
  RichParagraph,
} from "../domain/types";
import { safeUrl } from "../domain/validation";
import type { StudioState } from "./useStudio";
import Inspector, { ActionEditor } from "./Inspector";
const AIAssistant = lazy(() => import("./AIAssistant"));
import TableImport from "./TableImport";
const LanguageSettings = lazy(() => import("./LanguageSettings"));
import { languageLabel } from "../domain/languages";
import { detachComponent, setComponentOverride } from "../domain/shared";
import { historyChange } from "../domain/commands";
export default function EnhancedInspector({
  studio: s,
}: {
  studio: StudioState;
}) {
  const p = s.project,
    b = s.selectedBlock;
  const [clipboard, setClipboard] = useState<Design | null>(null);
  const patch = (change: (block: Block) => void) =>
    s.apply((project) => {
      const target = project.blocks.find((x) => x.id === b?.id);
      if (target) change(target);
    });
  const batch = (change: (block: Block) => void) =>
    s.apply((project) => {
      project.blocks.filter((x) => s.selected.includes(x.id)).forEach(change);
    });
  if (s.selected.length > 1 && b) {
    const selected = p.blocks.filter((x) => s.selected.includes(x.id));
    const mixed = (key: "background" | "color" | "padding" | "radius") =>
      selected.some((x) => x.design[key] !== b.design[key]);
    return (
      <div className="inspector">
        <h3>{selected.length}개 선택 · 공통 속성</h3>
        <p className="hint">
          변경한 항목만 모든 선택 블록에 적용됩니다. 서로 다른 값은 혼합값으로
          표시합니다.
        </p>
        {(["background", "color", "padding", "radius"] as const).map((key) => (
          <label key={key}>
            {
              {
                background: "배경",
                color: "글자",
                padding: "여백",
                radius: "모서리",
              }[key]
            }{" "}
            {mixed(key) ? "· 혼합값" : ""}
            <input
              aria-label={`일괄 ${key}`}
              type={
                key === "background" || key === "color" ? "color" : "number"
              }
              value={b.design[key]}
              min={0}
              max={key === "padding" ? 200 : 100}
              onChange={(e) =>
                batch((x) => {
                  if (key === "background" || key === "color")
                    x.design[key] = e.target.value;
                  else x.design[key] = Number(e.target.value);
                  x.design.themeMode = "custom";
                })
              }
            />
          </label>
        ))}
        <label>
          테마 상속
          <select
            value={
              selected.every((x) => x.design.themeMode === "theme")
                ? "theme"
                : "custom"
            }
            onChange={(e) =>
              batch((x) => {
                x.design.themeMode = e.target.value as "theme" | "custom";
              })
            }
          >
            <option value="theme">사이트 테마</option>
            <option value="custom">개별 스타일</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() =>
            batch((x) => {
              x.hidden = false;
            })
          }
        >
          모두 표시
        </button>
        <button
          type="button"
          onClick={() =>
            batch((x) => {
              x.hidden = true;
            })
          }
        >
          모두 숨김
        </button>
      </div>
    );
  }
  if (!b)
    return (
      <>
        <Inspector project={p} block={null} selected={[]} update={s.apply} />
        <div className="inspector">
          <details open>
            <summary>문구 번역</summary>
            <TranslationTable studio={s} />
          </details>
          <details>
            <summary>사이트 주소·테마 규모</summary>
            <label>
              공개 기본 주소
              <input
                type="url"
                value={p.settings.siteUrl || ""}
                onChange={(e) =>
                  s.apply((x) => {
                    x.settings.siteUrl = e.target.value;
                  })
                }
                placeholder="https://example.com"
              />
            </label>
            <p className="hint">
              검색·공유 주소 설정입니다. 공개 배포는 연결 설정과 실제 접속
              확인이 필요합니다.
            </p>
            {(
              [
                "bodySize",
                "headingSize",
                "lineHeight",
                "sectionGap",
                "contentWidth",
              ] as const
            ).map((key) => (
              <label key={key}>
                {
                  {
                    bodySize: "본문 크기",
                    headingSize: "제목 크기",
                    lineHeight: "줄 간격",
                    sectionGap: "영역 간격",
                    contentWidth: "내용 너비",
                  }[key]
                }
                <input
                  type="number"
                  min={
                    key === "lineHeight"
                      ? 1
                      : key === "contentWidth"
                        ? 320
                        : key === "sectionGap"
                          ? 0
                          : 12
                  }
                  max={
                    key === "contentWidth"
                      ? 10000
                      : key === "sectionGap"
                        ? 200
                        : key === "lineHeight"
                          ? 3
                          : 96
                  }
                  step={key === "lineHeight" ? 0.1 : 1}
                  value={
                    p.theme.typography?.[key] ??
                    {
                      bodySize: 16,
                      headingSize: 32,
                      lineHeight: 1.6,
                      sectionGap: 24,
                      contentWidth: p.canvas.width,
                    }[key]
                  }
                  onChange={(e) =>
                    s.apply((x) => {
                      x.theme.typography = {
                        ...{
                          bodySize: 16,
                          headingSize: 32,
                          lineHeight: 1.6,
                          sectionGap: 24,
                          contentWidth: x.canvas.width,
                        },
                        ...x.theme.typography,
                        [key]: Number(e.target.value),
                      };
                    })
                  }
                />
              </label>
            ))}
            <label>
              사이트 기본 모서리
              <input
                type="number"
                min={0}
                max={100}
                value={p.theme.radius}
                onChange={(e) =>
                  s.apply((x) => {
                    x.theme.radius = Number(e.target.value);
                  })
                }
              />
            </label>
            <button
              type="button"
              onClick={() =>
                s.apply((x) => {
                  x.blocks.forEach((item) => {
                    item.design.themeMode = "theme";
                  });
                })
              }
            >
              모든 블록에 테마 상속 적용
            </button>
            <p className="hint">
              개별 지정이 테마 상속으로 바뀝니다. 실행 취소로 복구할 수
              있습니다.
            </p>
          </details>
        </div>
      </>
    );
  const image = b.props.imageSettings ?? {
    decorative: false,
    fit: "cover" as const,
    ratio: 1.5,
    focalX: 50,
    focalY: 50,
  };
  const form = b.props.formSettings ?? {
    successMessage: "접수되었습니다.",
    successAction: { kind: "none" as const },
    privacyNotice: "",
    consentRequired: false,
    category: "",
  };
  const binding = b.props.collectionBinding ?? {
    collectionId: "",
    category: "",
    limit: 12,
    detailLinks: true,
  };
  return (
    <>
      <Inspector project={p} block={b} selected={s.selected} update={s.apply} />
      <div className="inspector enhanced-inspector">
        <Suspense fallback={<p role="status">AI 검토 도구를 불러오는 중…</p>}>
          <AIAssistant studio={s} />
        </Suspense>
        {b.componentLink && (
          <details>
            <summary>공유 구성 요소 연결·개별 변경</summary>
            <p>
              원본 {b.componentLink.componentId} · 연결 버전{" "}
              {b.componentLink.version} · 개별 변경{" "}
              {b.componentLink.overrides.length}개
            </p>
            {b.componentLink.overrides.map((path) => (
              <div className="page-card" key={path}>
                <strong>{path}</strong>
                <button
                  type="button"
                  onClick={() =>
                    s.setHistory((h) =>
                      historyChange(
                        h,
                        setComponentOverride(h.present, b.id, path, false),
                      ),
                    )
                  }
                >
                  다음 공유 업데이트 허용
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                if (
                  !confirm(
                    "선택한 구성 요소 연결을 해제합니다. 현재 내용은 유지하고 이후 공유 업데이트는 적용하지 않습니다.",
                  )
                )
                  return;
                s.setHistory((h) =>
                  historyChange(h, detachComponent(h.present, s.selected)),
                );
              }}
            >
              현재 선택 연결 해제
            </button>
            <p className="hint">
              직접 수정한 필드는 개별 변경으로 보존합니다. 업데이트 허용을
              선택한 후 라이브러리 변경 영향 검토에서 적용하세요.
            </p>
          </details>
        )}
        <details open>
          <summary>빠른 스타일·상속</summary>
          <div className="button-row">
            <button
              type="button"
              onClick={() => {
                setClipboard(structuredClone(b.design));
                s.setMessage(
                  "스타일을 복사했습니다. 다른 블록에 붙여 넣을 수 있습니다.",
                );
              }}
            >
              스타일 복사
            </button>
            <button
              type="button"
              disabled={!clipboard}
              onClick={() =>
                clipboard &&
                patch((x) => {
                  x.design = structuredClone(clipboard);
                })
              }
            >
              스타일 붙여넣기
            </button>
          </div>
          <label>
            스타일 기준
            <select
              value={b.design.themeMode || "custom"}
              onChange={(e) =>
                patch((x) => {
                  x.design.themeMode = e.target.value as "theme" | "custom";
                })
              }
            >
              <option value="custom">개별 스타일</option>
              <option value="theme">사이트 테마 상속</option>
            </select>
          </label>
          <p className="hint">
            테마 상속은 사이트 표면색·반경·문자 크기를 따릅니다.
          </p>
        </details>
        <details>
          <summary>기기별 예외</summary>
          <p className="hint">
            기본값은 모든 기기에 적용됩니다. 아래 값은 해당 기기만 덮어씁니다.
            읽기 순서는 모든 기기에서 동일합니다.
          </p>
          {(["tablet", "mobile"] as const).map((device) => (
            <fieldset key={device}>
              <legend>{device === "mobile" ? "모바일" : "태블릿"}</legend>
              {(
                [
                  "columns",
                  "gap",
                  "padding",
                  "fontSize",
                  "headingSize",
                ] as const
              ).map((key) => (
                <label key={key}>
                  {
                    {
                      columns: "열 수",
                      gap: "간격",
                      padding: "안쪽 여백",
                      fontSize: "본문 크기",
                      headingSize: "제목 크기",
                    }[key]
                  }
                  <input
                    type="number"
                    min={
                      key === "columns"
                        ? 1
                        : key === "fontSize" || key === "headingSize"
                          ? 12
                          : 0
                    }
                    max={
                      key === "columns"
                        ? 12
                        : key === "fontSize" || key === "headingSize"
                          ? 96
                          : 200
                    }
                    placeholder="기본값 상속"
                    value={b.layout.responsive?.[device]?.[key] ?? ""}
                    onChange={(e) =>
                      patch((x) => {
                        x.layout.responsive ??= {};
                        const value: ResponsiveStyle = {
                          ...x.layout.responsive[device],
                        };
                        if (e.target.value === "") delete value[key];
                        else value[key] = Number(e.target.value);
                        x.layout.responsive[device] = value;
                      })
                    }
                  />
                </label>
              ))}
              <button
                type="button"
                onClick={() =>
                  patch((x) => {
                    if (x.layout.responsive) delete x.layout.responsive[device];
                  })
                }
              >
                이 기기 예외 초기화
              </button>
            </fieldset>
          ))}
        </details>
        {["hero", "text", "footer"].includes(b.type) ? (
          <details>
            <summary>제목 단계·안전한 서식</summary>
            <label>
              제목 단계
              <select
                value={b.props.headingLevel || (b.type === "hero" ? 1 : 2)}
                onChange={(e) =>
                  patch((x) => {
                    x.props.headingLevel = Number(e.target.value) as 1 | 2 | 3;
                  })
                }
              >
                <option value={1}>H1 · 페이지 대표 제목</option>
                <option value={2}>H2 · 영역 제목</option>
                <option value={3}>H3 · 하위 제목</option>
              </select>
            </label>
            {(b.props.richText || []).map((paragraph, index) => (
              <fieldset key={index}>
                <legend>문단 {index + 1}</legend>
                <label>
                  문단 형식
                  <select
                    value={paragraph.kind}
                    onChange={(e) =>
                      patch((x) => {
                        x.props.richText![index]!.kind = e.target
                          .value as RichParagraph["kind"];
                      })
                    }
                  >
                    <option value="paragraph">문단</option>
                    <option value="bullet">점 목록</option>
                    <option value="ordered">번호 목록</option>
                  </select>
                </label>
                {paragraph.spans.map((span, i) => (
                  <div key={i} className="editor-item">
                    <label>
                      문구
                      <textarea
                        value={span.text}
                        onChange={(e) =>
                          patch((x) => {
                            x.props.richText![index]!.spans[i]!.text =
                              e.target.value;
                          })
                        }
                      />
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={Boolean(span.bold)}
                        onChange={(e) =>
                          patch((x) => {
                            x.props.richText![index]!.spans[i]!.bold =
                              e.target.checked;
                          })
                        }
                      />
                      굵게
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={Boolean(span.italic)}
                        onChange={(e) =>
                          patch((x) => {
                            x.props.richText![index]!.spans[i]!.italic =
                              e.target.checked;
                          })
                        }
                      />
                      기울임
                    </label>
                    <label>
                      링크
                      <input
                        type="url"
                        value={span.href || ""}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (value && !safeUrl(value)) {
                            e.target.setCustomValidity(
                              "https:// 또는 안전한 상대 주소를 입력하세요.",
                            );
                            return;
                          }
                          e.target.setCustomValidity("");
                          patch((x) => {
                            x.props.richText![index]!.spans[i]!.href =
                              value || undefined;
                          });
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        patch((x) => {
                          x.props.richText![index]!.spans.splice(i, 1);
                        })
                      }
                    >
                      문구 삭제
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    patch((x) => {
                      x.props.richText![index]!.spans.push({ text: "" });
                    })
                  }
                >
                  문구 조각 추가
                </button>
                <button
                  type="button"
                  onClick={() =>
                    patch((x) => {
                      x.props.richText!.splice(index, 1);
                    })
                  }
                >
                  문단 삭제
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              onClick={() =>
                patch((x) => {
                  x.props.richText ??= [];
                  x.props.richText.push({
                    kind: "paragraph",
                    spans: [
                      { text: x.props.richText.length ? "" : x.props.body },
                    ],
                  });
                })
              }
            >
              서식 문단 추가
            </button>
            <p className="hint">
              서식 문단이 있으면 본문 대신 표시합니다. HTML은 실행하지 않습니다.
            </p>
          </details>
        ) : null}
        {b.type === "image" ? (
          <details open>
            <summary>이미지 비율·초점</summary>
            <label className="check">
              <input
                type="checkbox"
                checked={image.decorative}
                onChange={(e) =>
                  patch((x) => {
                    x.props.imageSettings = {
                      ...image,
                      decorative: e.target.checked,
                    };
                  })
                }
              />
              장식 이미지 (대체 텍스트 제외)
            </label>
            <label>
              맞춤 방식
              <select
                value={image.fit}
                onChange={(e) =>
                  patch((x) => {
                    x.props.imageSettings = {
                      ...image,
                      fit: e.target.value as "cover" | "contain",
                    };
                  })
                }
              >
                <option value="cover">영역 채우기·잘라내기</option>
                <option value="contain">이미지 전체 보기</option>
              </select>
            </label>
            {(["ratio", "focalX", "focalY"] as const).map((key) => (
              <label key={key}>
                {
                  {
                    ratio: "가로/세로 비율",
                    focalX: "가로 초점 %",
                    focalY: "세로 초점 %",
                  }[key]
                }
                <input
                  type="number"
                  value={image[key]}
                  min={key === "ratio" ? 0.1 : 0}
                  max={key === "ratio" ? 10 : 100}
                  step={key === "ratio" ? 0.1 : 1}
                  onChange={(e) =>
                    patch((x) => {
                      x.props.imageSettings = {
                        ...image,
                        [key]: Number(e.target.value),
                      };
                    })
                  }
                />
              </label>
            ))}
          </details>
        ) : null}
        {b.type === "form" ? (
          <details open>
            <summary>접수 완료·동의</summary>
            <label>
              접수 완료 문구
              <input
                value={form.successMessage}
                onChange={(e) =>
                  patch((x) => {
                    x.props.formSettings = {
                      ...form,
                      successMessage: e.target.value,
                    };
                  })
                }
              />
            </label>
            <ActionEditor
              label="접수 후 동작"
              action={form.successAction}
              project={p}
              block={b}
              onChange={(successAction) =>
                patch((x) => {
                  x.props.formSettings = { ...form, successAction };
                })
              }
            />
            <label>
              개인정보 안내
              <textarea
                value={form.privacyNotice}
                onChange={(e) =>
                  patch((x) => {
                    x.props.formSettings = {
                      ...form,
                      privacyNotice: e.target.value,
                    };
                  })
                }
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.consentRequired}
                onChange={(e) =>
                  patch((x) => {
                    x.props.formSettings = {
                      ...form,
                      consentRequired: e.target.checked,
                    };
                  })
                }
              />
              제출 전 동의 필수
            </label>
            <label>
              문의 분류
              <input
                value={form.category}
                onChange={(e) =>
                  patch((x) => {
                    x.props.formSettings = {
                      ...form,
                      category: e.target.value,
                    };
                  })
                }
              />
            </label>
            {b.props.fields.map((field, i) => (
              <label key={field.id}>
                {field.label} 설명
                <input
                  value={field.description || ""}
                  onChange={(e) =>
                    patch((x) => {
                      x.props.fields[i]!.description = e.target.value;
                    })
                  }
                />
              </label>
            ))}
          </details>
        ) : null}
        {b.type === "cards" ? (
          <details>
            <summary>콘텐츠 컬렉션 연결</summary>
            <label>
              컬렉션
              <select
                value={binding.collectionId}
                onChange={(e) =>
                  patch((x) => {
                    x.props.collectionBinding = e.target.value
                      ? { ...binding, collectionId: e.target.value }
                      : undefined;
                  })
                }
              >
                <option value="">직접 입력한 항목</option>
                {(p.collections || []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              분류 필터
              <input
                value={binding.category}
                onChange={(e) =>
                  patch((x) => {
                    x.props.collectionBinding = {
                      ...binding,
                      category: e.target.value,
                    };
                  })
                }
              />
            </label>
            <label>
              최대 항목
              <input
                type="number"
                min={1}
                max={200}
                value={binding.limit}
                onChange={(e) =>
                  patch((x) => {
                    x.props.collectionBinding = {
                      ...binding,
                      limit: Number(e.target.value),
                    };
                  })
                }
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={binding.detailLinks}
                onChange={(e) =>
                  patch((x) => {
                    x.props.collectionBinding = {
                      ...binding,
                      detailLinks: e.target.checked,
                    };
                  })
                }
              />
              상세 페이지 링크
            </label>
          </details>
        ) : null}
        {b.type === "navigation" || b.type === "sidebar" ? (
          <details>
            <summary>블록 메뉴 동작</summary>
            <label>
              선택 시
              <select
                value={b.props.navigationBehavior || "section"}
                onChange={(e) =>
                  patch((x) => {
                    x.props.navigationBehavior = e.target.value as
                      "section" | "scroll";
                  })
                }
              >
                <option value="section">선택한 영역으로 화면 전환</option>
                <option value="scroll">현재 페이지에서 스크롤 이동</option>
              </select>
            </label>
          </details>
        ) : null}
        {b.type === "chart" ? (
          <ChartConnection block={b} studio={s} patch={patch} />
        ) : null}
        {b.type === "table" ? (
          <details>
            <summary>열 정책</summary>
            <TableImport block={b} studio={s} />
            {b.props.columns.map((col, i) => (
              <fieldset key={col.id}>
                <legend>{col.label}</legend>
                {(["required", "unique", "readOnly", "hidden"] as const).map(
                  (key) => (
                    <label className="check" key={key}>
                      <input
                        type="checkbox"
                        checked={Boolean(col[key])}
                        onChange={(e) =>
                          patch((x) => {
                            x.props.columns[i]![key] = e.target.checked;
                          })
                        }
                      />
                      {
                        {
                          required: "필수",
                          unique: "중복 금지",
                          readOnly: "읽기 전용",
                          hidden: "화면에서 숨김",
                        }[key]
                      }
                    </label>
                  ),
                )}
                <label>
                  열 너비
                  <input
                    type="number"
                    value={col.width || 160}
                    min={40}
                    max={1000}
                    onChange={(e) =>
                      patch((x) => {
                        x.props.columns[i]!.width = Number(e.target.value);
                      })
                    }
                  />
                </label>
              </fieldset>
            ))}
          </details>
        ) : null}
        <details>
          <summary>블록 번역</summary>
          {[
            ...new Set([
              p.settings.language,
              ...(p.settings.languages || []),
              "ko",
              "en",
            ]),
          ].map((language) => (
            <fieldset key={language}>
              <legend>{languageLabel(language)}</legend>
              {(
                ["title", "body", "primaryAction", "secondaryAction"] as const
              ).map((key) => (
                <label key={key}>
                  {key}
                  <input
                    value={b.props.translations?.[language]?.[key] || ""}
                    placeholder={b.props[key]}
                    onChange={(e) =>
                      patch((x) => {
                        x.props.translations ??= {};
                        x.props.translations[language] = {
                          title: "",
                          body: "",
                          primaryAction: "",
                          secondaryAction: "",
                          ...x.props.translations[language],
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
      </div>
    </>
  );
}
function TranslationTable({ studio: s }: { studio: StudioState }) {
  let entries: [string, string][] = [];
  let invalid = false;
  try {
    const value: unknown = JSON.parse(
      s.project.settings.customLanguageText || "{}",
    );
    if (value && typeof value === "object" && !Array.isArray(value))
      entries = Object.entries(value).filter(
        (pair): pair is [string, string] => typeof pair[1] === "string",
      );
  } catch {
    invalid = true;
  }
  const [key, setKey] = useState(""),
    [value, setValue] = useState("");
  function write(next: [string, string][]) {
    s.apply((p) => {
      p.settings.customLanguageText = JSON.stringify(
        Object.fromEntries(next),
        null,
        2,
      );
    });
  }
  return (
    <>
      {invalid ? (
        <p role="alert" className="bad">
          기존 번역 JSON이 올바르지 않습니다. 고급 언어 JSON에서 수정하거나 새
          문구로 교체하세요.
        </p>
      ) : null}
      <Suspense fallback={<p role="status">언어 설정 도구 불러오는 중…</p>}>
        <LanguageSettings studio={s} />
      </Suspense>
      <label className="check">
        <input
          type="checkbox"
          checked={s.project.settings.languages?.includes("en") || false}
          onChange={(e) =>
            s.apply((p) => {
              p.settings.languages = e.target.checked
                ? [
                    ...new Set([
                      p.settings.language,
                      ...(p.settings.languages || []),
                      "en",
                    ]),
                  ]
                : [
                    ...new Set([
                      p.settings.language,
                      ...(p.settings.languages || []).filter(
                        (lang) => lang !== "en",
                      ),
                    ]),
                  ];
            })
          }
        />
        방문자 한국어/영어 선택 허용
      </label>
      {entries.map(([entry, text], i) => (
        <div className="translation-row" key={entry}>
          <strong>{entry}</strong>
          <input
            aria-label={`${entry} 번역`}
            value={text}
            onChange={(e) =>
              write(
                entries.map((item, n) =>
                  n === i ? [entry, e.target.value] : item,
                ),
              )
            }
          />
          <button
            type="button"
            aria-label={`${entry} 번역 삭제`}
            onClick={() => write(entries.filter((_, n) => n !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <label>
        기본 문구
        <input value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <label>
        표시할 문구
        <input value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button
        type="button"
        disabled={!key.trim()}
        onClick={() => {
          write([...entries.filter((item) => item[0] !== key), [key, value]]);
          setKey("");
          setValue("");
        }}
      >
        번역 추가
      </button>
    </>
  );
}
function ChartConnection({
  block: b,
  studio: s,
  patch,
}: {
  block: Block;
  studio: StudioState;
  patch: (change: (b: Block) => void) => void;
}) {
  const binding = b.props.chartBinding || {
      tableBlockId: "",
      labelColumnId: "",
      valueColumnId: "",
      unit: "",
      xLabel: "",
      yLabel: "",
    },
    table = s.project.blocks.find((x) => x.id === binding.tableBlockId);
  return (
    <details>
      <summary>표 연결·축 정보</summary>
      <label>
        표 데이터
        <select
          value={binding.tableBlockId}
          onChange={(e) =>
            patch((x) => {
              x.props.chartBinding = e.target.value
                ? {
                    ...binding,
                    tableBlockId: e.target.value,
                    labelColumnId: "",
                    valueColumnId: "",
                  }
                : undefined;
            })
          }
        >
          <option value="">직접 입력한 숫자</option>
          {s.project.blocks
            .filter((x) => x.type === "table")
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.props.title || x.name}
              </option>
            ))}
        </select>
      </label>
      {(["labelColumnId", "valueColumnId"] as const).map((key) => (
        <label key={key}>
          {key === "labelColumnId" ? "항목 이름 열" : "숫자 열"}
          <select
            value={binding[key]}
            onChange={(e) =>
              patch((x) => {
                x.props.chartBinding = { ...binding, [key]: e.target.value };
              })
            }
          >
            <option value="">열 선택</option>
            {table?.props.columns
              .filter((col) => key === "labelColumnId" || col.type === "number")
              .map((col) => (
                <option key={col.id} value={col.id}>
                  {col.label}
                </option>
              ))}
          </select>
        </label>
      ))}
      {(["unit", "xLabel", "yLabel"] as const).map((key) => (
        <label key={key}>
          {{ unit: "단위", xLabel: "가로축 이름", yLabel: "세로축 이름" }[key]}
          <input
            value={binding[key]}
            onChange={(e) =>
              patch((x) => {
                x.props.chartBinding = { ...binding, [key]: e.target.value };
              })
            }
          />
        </label>
      ))}
      <label>
        직접 데이터 항목 이름 (한 줄에 하나)
        <textarea
          value={(b.props.chartLabels || []).join("\n")}
          onChange={(e) =>
            patch((x) => {
              x.props.chartLabels = e.target.value.split("\n");
            })
          }
        />
      </label>
    </details>
  );
}
