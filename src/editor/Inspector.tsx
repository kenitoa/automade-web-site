import type { Action, Block, Field, Project } from "../domain/types";
import { uid } from "../domain/catalog";
import { languageLabel } from "../domain/languages";
import { projectBlockDefinition } from "../domain/blockRegistry";
interface Props {
  project: Project;
  block: Block | null;
  update: (change: (project: Project) => void) => void;
  selected: string[];
}
export function ActionEditor({
  label,
  action,
  onChange,
  project,
  block,
}: {
  label: string;
  action: Action;
  onChange: (a: Action) => void;
  project: Project;
  block?: Block;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <label>
        동작
        <select
          value={action.kind}
          onChange={(event) => {
            const kind = event.target.value as Action["kind"];
            if (kind === "none" || kind === "submit" || kind === "download")
              onChange({ kind });
            else if (kind === "link") onChange({ kind, url: "", newTab: true });
            else
              onChange({
                kind,
                target:
                  (kind === "navigate"
                    ? project.pages[0]?.id
                    : project.blocks.find(
                        (b) => kind !== "modal" || b.type === "modal",
                      )?.id) ?? "",
              });
          }}
        >
          <option value="none">연결 안 됨</option>
          <option value="navigate">페이지 이동</option>
          <option value="scroll">블록으로 이동</option>
          <option value="link">외부 링크</option>
          <option value="modal">모달 열기</option>
          {block?.type === "form" ? (
            <option value="submit">폼 제출</option>
          ) : null}
          {block?.type === "table" ? (
            <option value="download">CSV 다운로드</option>
          ) : null}
        </select>
      </label>
      {action.kind === "navigate" ||
      action.kind === "scroll" ||
      action.kind === "modal" ? (
        <label>
          대상
          <select
            value={action.target}
            onChange={(event) =>
              onChange({ ...action, target: event.target.value })
            }
          >
            <option value="">대상을 선택하세요</option>
            {action.kind === "navigate"
              ? project.pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))
              : project.blocks
                  .filter((b) => action.kind !== "modal" || b.type === "modal")
                  .map((b) => (
                    <option value={b.id} key={b.id}>
                      {b.props.title || b.name}
                    </option>
                  ))}
          </select>
        </label>
      ) : null}
      {action.kind === "link" ? (
        <>
          <label>
            주소
            <input
              type="url"
              value={action.url}
              onChange={(event) =>
                onChange({ ...action, url: event.target.value })
              }
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={action.newTab}
              onChange={(event) =>
                onChange({ ...action, newTab: event.target.checked })
              }
            />
            새 창에서 열기
          </label>
        </>
      ) : null}
    </fieldset>
  );
}
export default function Inspector({ project, block, update, selected }: Props) {
  const patch = (change: (block: Block) => void) =>
    update((p) => {
      const b = p.blocks.find((x) => x.id === block?.id);
      if (b) {
        const designBefore = JSON.stringify(b.design);
        change(b);
        if (JSON.stringify(b.design) !== designBefore)
          b.design.themeMode = "custom";
      }
    });
  const prop = (
    key:
      | "title"
      | "body"
      | "primaryAction"
      | "secondaryAction"
      | "navigationLabel"
      | "alt",
    value: string,
  ) =>
    patch((b) => {
      b.props[key] = value;
    });
  if (!block)
    return (
      <div className="inspector">
        <h3>사이트 설정</h3>
        <details>
          <summary>고급 언어 JSON</summary>
          <label>
            사용자 언어 문구 (JSON)
            <textarea
              rows={3}
              value={project.settings.customLanguageText}
              onChange={(e) =>
                update((p) => {
                  p.settings.customLanguageText = e.target.value;
                })
              }
            />
            <small>기본 문구를 키로, 표시할 문구를 값으로 입력하세요.</small>
          </label>
        </details>
        <label>
          사이트 이름
          <input
            value={project.name}
            onChange={(event) =>
              update((p) => {
                p.name = event.target.value;
              })
            }
          />
        </label>
        <label>
          검색·공유 설명
          <textarea
            rows={3}
            value={project.settings.description}
            onChange={(event) =>
              update((p) => {
                p.settings.description = event.target.value;
              })
            }
          />
        </label>
        <label>
          사이트 언어
          <select
            value={project.settings.language}
            onChange={(event) =>
              update((p) => {
                p.settings.language = event.target.value;
              })
            }
          >
            {[
              ...new Set([
                project.settings.language,
                ...(project.settings.languages || []),
                "ko",
                "en",
              ]),
            ].map((language) => (
              <option key={language} value={language}>
                {languageLabel(language)}
              </option>
            ))}
          </select>
        </label>
        <label>
          글꼴
          <select
            value={project.theme.font}
            onChange={(event) =>
              update((p) => {
                p.theme.font = event.target.value as Project["theme"]["font"];
              })
            }
          >
            <option value="system">기본 산세리프</option>
            <option value="serif">세리프</option>
            <option value="mono">고정 폭</option>
          </select>
        </label>
        {(["brandColor", "accentColor", "surfaceColor"] as const).map(
          (key, index) => (
            <label key={key}>
              {["대표 색상", "보조 색상", "표면 색상"][index]}
              <input
                type="color"
                value={project.theme[key]}
                onChange={(e) =>
                  update((p) => {
                    p.theme[key] = e.target.value;
                  })
                }
              />
            </label>
          ),
        )}
        <label>
          배경
          <input
            type="color"
            value={project.canvas.background}
            onChange={(e) =>
              update((p) => {
                p.canvas.background = e.target.value;
              })
            }
          />
        </label>
        <label>
          콘텐츠 최대 너비
          <input
            type="number"
            min={320}
            max={10000}
            value={project.canvas.width}
            onChange={(e) =>
              update((p) => {
                p.canvas.width = Number(e.target.value);
              })
            }
          />
        </label>
        <label>
          작업 영역 높이
          <input
            type="number"
            min={320}
            max={50000}
            value={project.canvas.height}
            onChange={(e) =>
              update((p) => {
                p.canvas.height = Number(e.target.value);
              })
            }
          />
        </label>
        <label>
          그리드 이동 단위
          <input
            type="number"
            min={1}
            max={200}
            value={project.canvas.gridSize}
            onChange={(e) =>
              update((p) => {
                p.canvas.gridSize = Number(e.target.value);
              })
            }
          />
        </label>
        <label>
          간격 밀도
          <select
            value={project.theme.density}
            onChange={(e) =>
              update((p) => {
                p.theme.density = e.target.value as Project["theme"]["density"];
              })
            }
          >
            <option value="compact">좁게</option>
            <option value="comfortable">기본</option>
            <option value="spacious">넓게</option>
          </select>
        </label>
        <label>
          사이트 아이콘
          <select
            value={project.settings.faviconAssetId}
            onChange={(e) =>
              update((p) => {
                p.settings.faviconAssetId = e.target.value;
              })
            }
          >
            <option value="">없음</option>
            {project.assets.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  return (
    <div className="inspector">
      <h3>
        {selected.length > 1
          ? `${selected.length}개 선택 · 대표 속성`
          : block.name}
      </h3>
      <label>
        레이어 이름
        <input
          value={block.name}
          onChange={(e) =>
            patch((b) => {
              b.name = e.target.value;
            })
          }
        />
      </label>
      <details open>
        <summary>콘텐츠</summary>
        {(["title", "body", "navigationLabel"] as const).map((key, index) => (
          <label key={key}>
            {["제목", "본문", "메뉴 이름"][index]}
            {key === "body" ? (
              <textarea
                rows={4}
                value={block.props[key]}
                onChange={(e) => prop(key, e.target.value)}
              />
            ) : (
              <input
                value={block.props[key]}
                onChange={(e) => prop(key, e.target.value)}
              />
            )}
          </label>
        ))}
        {["hero", "text", "footer", "modal"].includes(block.type) ? (
          <>
            {(["primaryAction", "secondaryAction"] as const).map(
              (key, index) => (
                <label key={key}>
                  {index === 0 ? "주요 버튼 이름" : "보조 버튼 이름"}
                  <input
                    value={block.props[key]}
                    onChange={(e) => prop(key, e.target.value)}
                  />
                </label>
              ),
            )}
          </>
        ) : null}
        {block.type === "navigation" || block.type === "sidebar" ? (
          <label>
            메뉴 생성 방식
            <select
              value={block.props.menuMode}
              onChange={(e) =>
                patch((b) => {
                  b.props.menuMode =
                    e.target.value === "blocks" ? "blocks" : "pages";
                })
              }
            >
              <option value="pages">공개 페이지 자동 연결</option>
              <option value="blocks">현재 페이지 블록 자동 연결</option>
            </select>
          </label>
        ) : null}
        {block.type === "image" ? (
          <>
            <label>
              이미지
              <select
                value={block.props.assetId}
                onChange={(e) =>
                  patch((b) => {
                    b.props.assetId = e.target.value;
                  })
                }
              >
                <option value="">이미지를 선택하세요</option>
                {project.assets.map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              대체 텍스트
              <input
                value={block.props.alt}
                onChange={(e) => prop("alt", e.target.value)}
              />
            </label>
          </>
        ) : null}
        {block.type === "chart" ? (
          <>
            <label>
              숫자 데이터 (쉼표로 구분)
              <input
                defaultValue={block.props.series.join(", ")}
                key={`${block.id}-series-${block.props.series.join(",")}`}
                onBlur={(e) => {
                  const parts = e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  const values = parts.map(Number);
                  if (values.some((v) => !Number.isFinite(v))) {
                    e.target.setCustomValidity("숫자만 입력하세요.");
                    e.target.reportValidity();
                    return;
                  }
                  e.target.setCustomValidity("");
                  patch((b) => {
                    b.props.series = values;
                  });
                }}
              />
            </label>
            <label>
              기본 차트
              <select
                value={block.props.chartType}
                onChange={(e) =>
                  patch((b) => {
                    b.props.chartType = e.target
                      .value as Block["props"]["chartType"];
                  })
                }
              >
                <option value="bar">막대</option>
                <option value="line">선</option>
                <option value="summary">요약</option>
              </select>
            </label>
          </>
        ) : null}
      </details>
      {block.type === "form" ? (
        <details open>
          <summary>폼 필드와 저장</summary>
          <label>
            저장 대상
            <select
              value={block.props.dataSource}
              onChange={(e) =>
                patch((b) => {
                  b.props.dataSource =
                    e.target.value === "local" ? "local" : "none";
                })
              }
            >
              <option value="local">생성 사이트의 로컬 DB</option>
              <option value="none">연결 안 됨</option>
            </select>
          </label>
          <p className="hint">
            미리보기에서는 검증만 수행합니다. 생성 사이트에서 실제 저장됩니다.
          </p>
          {block.props.fields.map((field, index) => (
            <FieldEditor
              key={field.id}
              field={field}
              onChange={(next) =>
                patch((b) => {
                  b.props.fields[index] = next;
                })
              }
              onRemove={() =>
                patch((b) => {
                  b.props.fields.splice(index, 1);
                })
              }
            />
          ))}
          <button
            type="button"
            className="secondary"
            onClick={() =>
              patch((b) => {
                b.props.fields.push({
                  id: `field-${uid()}`,
                  label: "새 필드",
                  type: "text",
                  required: false,
                  placeholder: "",
                  min: 0,
                  max: 2000,
                  options: [],
                });
              })
            }
          >
            필드 추가
          </button>
        </details>
      ) : null}
      {block.type === "table" ? (
        <details open>
          <summary>표 구조와 초기 데이터</summary>
          <label>
            저장 대상
            <select
              value={block.props.dataSource}
              onChange={(e) =>
                patch((b) => {
                  b.props.dataSource =
                    e.target.value === "local" ? "local" : "none";
                })
              }
            >
              <option value="local">생성 사이트의 로컬 DB</option>
              <option value="none">읽기 전용 원본</option>
            </select>
          </label>
          {block.props.columns.map((column, index) => (
            <div className="editor-item" key={column.id}>
              <label>
                열 이름
                <input
                  value={column.label}
                  onChange={(e) =>
                    patch((b) => {
                      b.props.columns[index]!.label = e.target.value;
                    })
                  }
                />
              </label>
              <label>
                자료형
                <select
                  value={column.type}
                  onChange={(e) =>
                    patch((b) => {
                      b.props.columns[index]!.type = e.target
                        .value as typeof column.type;
                    })
                  }
                >
                  <option value="text">문자</option>
                  <option value="number">숫자</option>
                  <option value="date">날짜</option>
                </select>
              </label>
              <button
                type="button"
                className="danger"
                onClick={() =>
                  patch((b) => {
                    b.props.columns.splice(index, 1);
                    b.props.rows.forEach((r) => r.values.splice(index, 1));
                  })
                }
              >
                열 삭제
              </button>
            </div>
          ))}
          <button
            className="secondary"
            type="button"
            onClick={() =>
              patch((b) => {
                b.props.columns.push({
                  id: uid(),
                  label: "열 수",
                  type: "text",
                });
                b.props.rows.forEach((r) => r.values.push(""));
              })
            }
          >
            열 추가
          </button>
          {block.props.rows.map((row, index) => (
            <div className="editor-item" key={row.id}>
              {block.props.columns.map((column, i) => (
                <label key={column.id}>
                  {column.label}
                  <input
                    value={row.values[i] ?? ""}
                    onChange={(e) =>
                      patch((b) => {
                        b.props.rows[index]!.values[i] = e.target.value;
                      })
                    }
                  />
                </label>
              ))}
              <button
                className="danger"
                type="button"
                onClick={() =>
                  patch((b) => {
                    b.props.rows.splice(index, 1);
                  })
                }
              >
                초기 행 삭제
              </button>
            </div>
          ))}
          <button
            className="secondary"
            type="button"
            onClick={() =>
              patch((b) => {
                b.props.rows.push({
                  id: uid(),
                  values: b.props.columns.map(() => ""),
                });
              })
            }
          >
            초기 행 추가
          </button>
        </details>
      ) : null}
      {projectBlockDefinition(project, block)?.propertyProfile === "items" ||
      ["tabs", "cards", "faq", "pricing"].includes(block.type) ? (
        <details open>
          <summary>항목 구성</summary>
          {block.props.items.map((item, index) => (
            <details className="editor-item" key={item.id}>
              <summary>{item.title || `항목 ${index + 1}`}</summary>
              <label>
                제목
                <input
                  value={item.title}
                  onChange={(e) =>
                    patch((b) => {
                      b.props.items[index]!.title = e.target.value;
                    })
                  }
                />
              </label>
              <label>
                내용
                <textarea
                  value={item.body}
                  rows={3}
                  onChange={(e) =>
                    patch((b) => {
                      b.props.items[index]!.body = e.target.value;
                    })
                  }
                />
              </label>
              {block.type === "pricing" ? (
                <label>
                  가격
                  <input
                    value={item.price ?? ""}
                    onChange={(e) =>
                      patch((b) => {
                        b.props.items[index]!.price = e.target.value;
                      })
                    }
                  />
                </label>
              ) : null}
              {block.type === "cards" ? (
                <label>
                  이미지
                  <select
                    value={item.imageId ?? ""}
                    onChange={(e) =>
                      patch((b) => {
                        b.props.items[index]!.imageId =
                          e.target.value || undefined;
                      })
                    }
                  >
                    <option value="">없음</option>
                    {project.assets.map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <ActionEditor
                project={project}
                label="항목 동작"
                action={item.action}
                onChange={(action) =>
                  patch((b) => {
                    b.props.items[index]!.action = action;
                  })
                }
              />
              <button
                className="secondary"
                type="button"
                disabled={index === 0}
                onClick={() =>
                  patch((b) => {
                    const value = b.props.items.splice(index, 1)[0]!;
                    b.props.items.splice(index - 1, 0, value);
                  })
                }
              >
                위로
              </button>
              <button
                className="danger"
                type="button"
                onClick={() =>
                  patch((b) => {
                    b.props.items.splice(index, 1);
                  })
                }
              >
                항목 삭제
              </button>
            </details>
          ))}
          <button
            className="secondary"
            type="button"
            onClick={() =>
              patch((b) => {
                b.props.items.push({
                  id: uid(),
                  title: "새 항목",
                  body: "",
                  action: { kind: "none" },
                });
              })
            }
          >
            항목 추가
          </button>
        </details>
      ) : null}
      <details>
        <summary>레이아웃</summary>
        <label>
          배치 방식
          <select
            value={block.layout.mode}
            onChange={(e) =>
              patch((b) => {
                b.layout.mode =
                  e.target.value === "absolute" ? "absolute" : "flow";
              })
            }
          >
            <option value="flow">반응형 흐름</option>
            <option value="absolute">자유 배치</option>
          </select>
        </label>
        <label>
          부모 컨테이너
          <select
            value={block.parentId ?? ""}
            onChange={(e) =>
              patch((b) => {
                b.parentId = e.target.value || null;
              })
            }
          >
            <option value="">페이지</option>
            {project.blocks
              .filter(
                (b) =>
                  b.type === "container" &&
                  b.pageId === block.pageId &&
                  b.id !== block.id,
              )
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={block.pageId === "*"}
            onChange={(e) =>
              patch((b) => {
                b.pageId = e.target.checked
                  ? "*"
                  : project.pages.find((p) => p.home)!.id;
                b.parentId = null;
              })
            }
          />
          모든 페이지에 표시
        </label>
        {(["columns", "mobileColumns", "gap", "minHeight"] as const).map(
          (key, index) => (
            <label key={key}>
              {["열 수", "모바일 열 수", "간격", "최소 높이"][index]}
              <input
                type="number"
                value={block.layout[key]}
                min={key.includes("Columns") || key === "columns" ? 1 : 0}
                max={
                  key === "columns"
                    ? 12
                    : key === "mobileColumns"
                      ? 4
                      : key === "gap"
                        ? 200
                        : 50000
                }
                onChange={(e) =>
                  patch((b) => {
                    b.layout[key] = Number(e.target.value);
                  })
                }
              />
            </label>
          ),
        )}
        {block.layout.mode === "absolute" ? (
          <div className="number-grid">
            {(["x", "y", "width", "height", "zIndex"] as const).map((key) => (
              <label key={key}>
                {key}
                <input
                  type="number"
                  value={block.layout[key]}
                  min={key === "width" || key === "height" ? 24 : 0}
                  onChange={(e) =>
                    patch((b) => {
                      b.layout[key] = Number(e.target.value);
                    })
                  }
                />
              </label>
            ))}
          </div>
        ) : null}
        {(["mobileHidden", "tabletHidden", "desktopHidden"] as const).map(
          (key, index) => (
            <label className="check" key={key}>
              <input
                type="checkbox"
                checked={block.layout[key]}
                onChange={(e) =>
                  patch((b) => {
                    b.layout[key] = e.target.checked;
                  })
                }
              />
              {["모바일 숨김", "태블릿 숨김", "PC 숨김"][index]}
            </label>
          ),
        )}
      </details>
      <details>
        <summary>스타일</summary>
        {(["background", "color", "borderColor"] as const).map((key, index) => (
          <label key={key}>
            {["배경", "글자", "테두리"][index]}
            <input
              type="color"
              value={block.design[key]}
              onChange={(e) =>
                patch((b) => {
                  b.design[key] = e.target.value;
                })
              }
            />
          </label>
        ))}
        {(["padding", "radius"] as const).map((key, index) => (
          <label key={key}>
            {index === 0 ? "안쪽 여백" : "모서리"}
            <input
              type="number"
              min={0}
              max={key === "padding" ? 200 : 100}
              value={block.design[key]}
              onChange={(e) =>
                patch((b) => {
                  b.design[key] = Number(e.target.value);
                })
              }
            />
          </label>
        ))}
        <label className="check">
          <input
            type="checkbox"
            checked={block.design.shadow}
            onChange={(e) =>
              patch((b) => {
                b.design.shadow = e.target.checked;
              })
            }
          />
          그림자
        </label>
      </details>
      {["hero", "text", "footer", "modal"].includes(block.type) ? (
        <details>
          <summary>버튼 동작</summary>
          <ActionEditor
            label="주요 동작"
            project={project}
            block={block}
            action={block.props.action}
            onChange={(action) =>
              patch((b) => {
                b.props.action = action;
              })
            }
          />
          <ActionEditor
            label="보조 동작"
            project={project}
            block={block}
            action={block.props.secondary}
            onChange={(action) =>
              patch((b) => {
                b.props.secondary = action;
              })
            }
          />
        </details>
      ) : null}
    </div>
  );
}
function FieldEditor({
  field,
  onChange,
  onRemove,
}: {
  field: Field;
  onChange: (field: Field) => void;
  onRemove: () => void;
}) {
  return (
    <details className="editor-item">
      <summary>{field.label}</summary>
      <label>
        라벨
        <input
          value={field.label}
          onChange={(e) => onChange({ ...field, label: e.target.value })}
        />
      </label>
      <label>
        종류
        <select
          value={field.type}
          onChange={(e) =>
            onChange({ ...field, type: e.target.value as Field["type"] })
          }
        >
          {(
            [
              "text",
              "email",
              "tel",
              "number",
              "textarea",
              "select",
              "checkbox",
            ] as const
          ).map((type, i) => (
            <option key={type} value={type}>
              {["문자", "이메일", "전화", "숫자", "긴 글", "선택", "체크"][i]}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={field.required}
          onChange={(e) => onChange({ ...field, required: e.target.checked })}
        />
        필수 입력
      </label>
      <label>
        입력 안내
        <input
          value={field.placeholder}
          onChange={(e) => onChange({ ...field, placeholder: e.target.value })}
        />
      </label>
      <div className="number-grid">
        <label>
          최소
          <input
            type="number"
            value={field.min}
            onChange={(e) =>
              onChange({ ...field, min: Number(e.target.value) })
            }
          />
        </label>
        <label>
          최대
          <input
            type="number"
            value={field.max}
            onChange={(e) =>
              onChange({ ...field, max: Number(e.target.value) })
            }
          />
        </label>
      </div>
      {field.type === "select" ? (
        <label>
          선택 항목 (한 줄에 하나)
          <textarea
            key={field.options.join("\n")}
            defaultValue={field.options.join("\n")}
            onBlur={(e) =>
              onChange({
                ...field,
                options: e.target.value
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
      ) : null}
      <button className="danger" type="button" onClick={onRemove}>
        필드 삭제
      </button>
    </details>
  );
}
