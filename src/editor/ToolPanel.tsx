import { useRef, useState } from "react";
import { CATALOG, uid } from "../domain/catalog";
import { deletePage, historyChange, setHomePage } from "../domain/commands";
import { record } from "../domain/validation";
import type { StudioState } from "./useStudio";
import type { GenerationState } from "./useGeneration";
export default function ToolPanel({
  studio: s,
  generation: g,
  onTemplates,
}: {
  studio: StudioState;
  generation: GenerationState;
  onTemplates: () => void;
}) {
  const p = s.project;
  const [query, setQuery] = useState("");
  const fileRef = useRef<HTMLInputElement>(null),
    assetRef = useRef<HTMLInputElement>(null);
  const select = (id: string, shift: boolean) =>
    s.setSelected((current) =>
      shift
        ? current.includes(id)
          ? current.filter((x) => x !== id)
          : [...current, id]
        : [id],
    );
  return (
    <>
      <nav className="tool-rail" aria-label="편집 도구">
        {[
          ["blocks", "블록", "▦"],
          ["pages", "페이지", "▤"],
          ["layers", "레이어", "▱"],
          ["assets", "이미지", "▧"],
          ["projects", "프로젝트", "▣"],
          ["quality", "품질 검사", "✓"],
          ["output", "결과물", "↗"],
          ["operations", "운영", "◉"],
        ].map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className={s.panel === id ? "active" : ""}
            onClick={() => {
              s.setPanel(id!);
              if (id === "operations") void g.refresh();
            }}
            aria-pressed={s.panel === id}
            aria-label={label}
          >
            <span>{icon}</span>
            {label}
          </button>
        ))}
      </nav>
      <aside className="tool-panel">
        <h2>
          {
            (
              {
                blocks: "블록 라이브러리",
                pages: "사이트 페이지",
                layers: "레이어",
                assets: "이미지 자산",
                projects: "프로젝트 보관함",
                quality: "품질 검사",
                output: "생성 결과",
                operations: "운영 현황",
              } as Record<string, string>
            )[s.panel]
          }
        </h2>
        {s.panel === "blocks" ? (
          <>
            <label className="search-field">
              <span>블록 검색</span>
              <input
                placeholder="폼, 메뉴, 차트…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {[...new Set(CATALOG.map((x) => x.category))].map((category) => (
              <section key={category} className="catalog-group">
                <h3>{category}</h3>
                {CATALOG.filter(
                  (x) =>
                    x.category === category &&
                    (x.name + x.description).includes(query),
                ).map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    className="catalog-item"
                    aria-label={item.name}
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer.setData(
                        "application/x-automade-block",
                        item.type,
                      )
                    }
                    onClick={() => s.addBlock(item.type)}
                  >
                    <strong>
                      {item.name}
                      <span>＋</span>
                    </strong>
                    <small>{item.description}</small>
                  </button>
                ))}
              </section>
            ))}
            <p className="hint">
              클릭해 반응형 블록을 추가하거나 캔버스로 끌어 자유 배치하세요.
            </p>
          </>
        ) : null}
        {s.panel === "pages" ? (
          <>
            <button
              className="secondary full"
              type="button"
              onClick={() => {
                const page = {
                  id: uid(),
                  title: "새 페이지",
                  path: `/page-${p.pages.length + 1}`,
                  description: "",
                  published: true,
                  home: false,
                };
                s.apply((p) => {
                  p.pages.push(page);
                });
                s.setPageId(page.id);
                s.setSelected([]);
              }}
            >
              페이지 추가
            </button>
            {p.pages.map((page) => (
              <div
                className={`page-card ${page.id === s.activePage.id ? "active" : ""}`}
                key={page.id}
              >
                <button
                  className="page-select"
                  type="button"
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
                          s.apply((p) => {
                            p.pages.find((x) => x.id === page.id)!.title =
                              e.target.value;
                          })
                        }
                      />
                    </label>
                    <label>
                      주소
                      <input
                        value={page.path}
                        onChange={(e) =>
                          s.apply((p) => {
                            p.pages.find((x) => x.id === page.id)!.path =
                              e.target.value;
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
                          s.apply((p) => {
                            p.pages.find((x) => x.id === page.id)!.description =
                              e.target.value;
                          })
                        }
                      />
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={page.published}
                        onChange={(e) =>
                          s.apply((p) => {
                            p.pages.find((x) => x.id === page.id)!.published =
                              e.target.checked;
                          })
                        }
                      />
                      공개 페이지
                    </label>
                    <button
                      className="secondary"
                      disabled={page.home}
                      type="button"
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
                      className="danger"
                      disabled={p.pages.length === 1}
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            "페이지와 블록을 삭제하고 연결된 이동을 해제하시겠습니까? 실행 취소로 복구할 수 있습니다.",
                          )
                        ) {
                          const next = deletePage(p, page.id);
                          s.setHistory((current) =>
                            historyChange(current, next),
                          );
                          s.setPageId(next.pages[0]!.id);
                          s.setSelected([]);
                        }
                      }}
                    >
                      페이지 삭제
                    </button>
                  </>
                ) : null}
              </div>
            ))}
          </>
        ) : null}
        {s.panel === "layers" ? (
          <>
            {p.blocks
              .filter((b) => b.pageId === s.activePage.id || b.pageId === "*")
              .sort((a, b) => b.layout.zIndex - a.layout.zIndex)
              .map((b) => (
                <div
                  className={`layer-row ${s.selected.includes(b.id) ? "active" : ""}`}
                  key={b.id}
                >
                  <button
                    type="button"
                    className="layer-name"
                    onClick={(e) => select(b.id, e.shiftKey)}
                  >
                    {b.parentId ? "↳ " : ""}
                    {b.props.title || b.name}
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`${b.name} 숨김 전환`}
                    onClick={() =>
                      s.apply((p) => {
                        const x = p.blocks.find((x) => x.id === b.id)!;
                        x.hidden = !x.hidden;
                      })
                    }
                  >
                    {b.hidden ? "○" : "●"}
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`${b.name} 잠금 전환`}
                    onClick={() =>
                      s.apply((p) => {
                        const x = p.blocks.find((x) => x.id === b.id)!;
                        x.locked = !x.locked;
                      })
                    }
                  >
                    {b.locked ? "▣" : "□"}
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    title="앞으로"
                    onClick={() =>
                      s.apply((p) => {
                        p.blocks.find((x) => x.id === b.id)!.layout.zIndex =
                          Math.max(...p.blocks.map((x) => x.layout.zIndex)) + 1;
                      })
                    }
                  >
                    ↑
                  </button>
                </div>
              ))}
            <p className="hint">
              Shift 클릭으로 다중 선택합니다. 잠긴 블록은 이동·삭제되지
              않습니다.
            </p>
          </>
        ) : null}
        {s.panel === "assets" ? (
          <>
            <button
              className="secondary full"
              type="button"
              onClick={() => assetRef.current?.click()}
            >
              이미지 업로드
            </button>
            <p className="hint">PNG · JPEG · WEBP · GIF / 각 5MB 이하</p>
            {p.assets.map((asset) => (
              <article className="asset-card" key={asset.id}>
                <img src={asset.data} alt={asset.alt} />
                <strong>{asset.name}</strong>
                <label>
                  대체 텍스트
                  <input
                    value={asset.alt}
                    onChange={(e) =>
                      s.apply((p) => {
                        p.assets.find((a) => a.id === asset.id)!.alt =
                          e.target.value;
                      })
                    }
                  />
                </label>
                <button
                  className="danger"
                  type="button"
                  onClick={() => {
                    if (
                      p.settings.faviconAssetId === asset.id ||
                      p.blocks.some(
                        (b) =>
                          b.props.assetId === asset.id ||
                          b.props.items.some((i) => i.imageId === asset.id),
                      )
                    ) {
                      s.setMessage(
                        "사용 중인 이미지입니다. 블록과 아이콘 연결을 먼저 해제하세요.",
                      );
                      return;
                    }
                    s.apply((p) => {
                      p.assets = p.assets.filter((a) => a.id !== asset.id);
                    });
                  }}
                >
                  이미지 삭제
                </button>
              </article>
            ))}
          </>
        ) : null}
        {s.panel === "projects" ? (
          <>
            <div className="button-stack">
              <button className="primary" type="button" onClick={onTemplates}>
                새 프로젝트
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => fileRef.current?.click()}
              >
                프로젝트 파일 가져오기
              </button>
              <button
                className="secondary"
                type="button"
                onClick={s.exportOriginal}
              >
                원본 내보내기
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  const copy = {
                    ...structuredClone(p),
                    id: uid(),
                    name: `${p.name} 복사`,
                    revision: 0,
                    updatedAt: new Date().toISOString(),
                  };
                  s.openProject(copy);
                  s.setLoaded(true);
                }}
              >
                프로젝트 복제
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  void s.showBackups();
                }}
              >
                이전 저장본 복구
              </button>
            </div>
            {s.restore.map((backup, i) => (
              <button
                type="button"
                className="project-card"
                key={`${backup.revision}-${i}`}
                onClick={() => {
                  s.openProject({
                    ...backup,
                    revision: p.revision + 1,
                    updatedAt: new Date().toISOString(),
                  });
                  s.setMessage(
                    "이전 저장본을 복구했습니다. 현재 내용도 백업으로 보존됩니다.",
                  );
                }}
              >
                버전 {backup.revision}
                <small>{new Date(backup.updatedAt).toLocaleString()}</small>
              </button>
            ))}
            {s.library.map((project) => (
              <button
                className={`project-card ${project.id === p.id ? "active" : ""}`}
                type="button"
                key={project.id}
                onClick={() => s.openProject(project)}
              >
                <strong>{project.name}</strong>
                <small>
                  {project.pages.length}페이지 · {project.blocks.length}블록
                </small>
                <small>{new Date(project.updatedAt).toLocaleString()}</small>
              </button>
            ))}
          </>
        ) : null}
        {s.panel === "quality" ? (
          <>
            <div className="quality-summary">
              <strong>
                {s.issues.filter((i) => i.severity === "error").length} 오류
              </strong>
              <span>
                {s.issues.filter((i) => i.severity === "warning").length} 권장
                사항
              </span>
            </div>
            {!s.issues.length ? (
              <p>자동 검사에서 문제가 발견되지 않았습니다.</p>
            ) : (
              s.issues.map((issue, i) => (
                <button
                  className={`issue ${issue.severity}`}
                  key={`${issue.code}-${i}`}
                  type="button"
                  onClick={() => {
                    if (issue.pageId && issue.pageId !== "*")
                      s.setPageId(issue.pageId);
                    s.setSelected(issue.blockId ? [issue.blockId] : []);
                  }}
                >
                  <strong>
                    {issue.severity === "error" ? "수정 필요" : "확인 권장"}
                  </strong>
                  <span>{issue.message}</span>
                </button>
              ))
            )}
            <p className="hint">
              자동 검사는 실제 기기·문구·시각적 균형 검증을 대신하지 않습니다.
            </p>
          </>
        ) : null}
        {s.panel === "output" ? (
          <>
            {g.result ? (
              <>
                <div className="output-success">✓ 사이트가 준비되었습니다</div>
                {g.stale ? (
                  <p className="hint">
                    이 결과는 이전 편집본입니다. 현재 내용을 반영하려면 다시
                    생성하세요.
                  </p>
                ) : null}
                <a
                  className="button-link"
                  href={g.result.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  웹사이트 바로 열기 ↗
                </a>
                <a
                  className="button-link"
                  href={"/api/exports/" + g.result.id + "/download"}
                  download
                >
                  소스·실행파일 ZIP 다운로드
                </a>
                <p className="hint">
                  ZIP은 편집 원본과 실행파일을 포함합니다. 실제 문의·표
                  데이터베이스는 개인정보 보호를 위해 포함하지 않습니다.
                </p>
                <label>
                  실행 주소
                  <input readOnly value={g.result.url} />
                </label>
                <label>
                  결과물 위치
                  <textarea rows={3} readOnly value={g.result.path} />
                </label>
                <p className="hint">
                  다음에도 생성 폴더의 start-site.cmd를 실행하면 사이트와 저장
                  데이터가 열립니다.
                </p>
                <p>
                  {(g.result.durationMs / 1000).toFixed(1)}초 · 자동 검사 권장{" "}
                  {g.result.issues.length}개
                </p>
              </>
            ) : (
              <p className="hint">
                상단 ‘사이트 만들고 열기’를 누르면 검사·생성·실행을 한 번에
                진행합니다.
              </p>
            )}
            {g.job ? <p role="status">진행 상태: {g.job.stage}</p> : null}
            {g.busy ? (
              <button className="danger" type="button" onClick={g.cancel}>
                생성 취소
              </button>
            ) : null}
          </>
        ) : null}
        {s.panel === "operations" ? (
          <>
            <button
              className="secondary full"
              type="button"
              onClick={() => {
                void g.refresh();
              }}
            >
              상태 새로고침
            </button>
            {g.operations ? (
              <>
                <div className="stat-grid">
                  <div>
                    <strong>{g.operations.stats.projects}</strong>프로젝트
                  </div>
                  <div>
                    <strong>{g.operations.stats.exports}</strong>생성 작업
                  </div>
                </div>
                <h3>실행 중인 사이트</h3>
                {g.operations.running.map((site) => (
                  <div className="run-card" key={site.id}>
                    <a href={site.url} target="_blank" rel="noreferrer">
                      사이트 열기 ↗
                    </a>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => {
                        void g.loadSubmissions(site.id);
                      }}
                    >
                      문의 조회
                    </button>
                    <button
                      className="danger"
                      type="button"
                      onClick={() => {
                        void g.stop(site.id);
                      }}
                    >
                      실행 종료
                    </button>
                  </div>
                ))}
                <h3>최근 생성 기록</h3>
                {g.operations.jobs.slice(0, 15).map((j) => (
                  <div key={j.id} className="job-row">
                    <span>
                      {j.status === "ready"
                        ? "완료"
                        : j.status === "failed"
                          ? "실패"
                          : "생성 중"}
                    </span>
                    {j.status === "ready" &&
                    !g.operations?.running.some((site) => site.id === j.id) ? (
                      <button
                        type="button"
                        onClick={() => {
                          void g.restart(j.id);
                        }}
                      >
                        다시 실행
                      </button>
                    ) : null}
                    <small>{new Date(j.created_at).toLocaleString()}</small>
                  </div>
                ))}
              </>
            ) : (
              <p>로컬 서비스 상태를 불러오세요.</p>
            )}
            {g.submissions.length ? (
              <>
                <h3>저장된 문의</h3>
                {g.submissions.map((value, i) => {
                  const row = record(value);
                  return (
                    <div className="submission" key={i}>
                      <small>{String(row.created_at)}</small>
                      {Object.entries(record(row.values)).map(
                        ([key, value]) => (
                          <p key={key}>
                            <strong>{key}: </strong>
                            {String(value)}
                          </p>
                        ),
                      )}
                    </div>
                  );
                })}
              </>
            ) : null}
          </>
        ) : null}
      </aside>
      <input
        hidden
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void s.importFile(file);
          e.target.value = "";
        }}
      />
      <input
        hidden
        ref={assetRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void s.addAsset(file);
          e.target.value = "";
        }}
      />
    </>
  );
}
