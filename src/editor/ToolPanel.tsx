import { lazy, Suspense, useRef, useState } from "react";
import { CATALOG, createBlock } from "../domain/catalog";
import { historyChange, insertSection, saveSection } from "../domain/commands";
import type { BlockType } from "../domain/types";
import type { StudioState } from "./useStudio";
import type { GenerationState } from "./useGeneration";
import PagePanel from "./PagePanel";
import LayerPanel from "./LayerPanel";
import OperationsPanel from "./OperationsPanel";
import { AssetsPanel, ProjectsPanel } from "./LibraryPanels";
import { previewQualityFix, type QualityFix } from "../domain/quality";
import EditorDialog from "./EditorDialog";
import type { ExpansionState } from "./useExpansion";
import { usePanelView } from "./usePanelView";
const ExpansionWorkspacePanel = lazy(() => import("./ExpansionWorkspacePanel"));
const SharedLibraryPanel = lazy(() => import("./SharedLibraryPanel"));
const PackPanel = lazy(() => import("./PackPanel"));
const BlobAssetsPanel = lazy(() => import("./BlobAssetsPanel"));
const SystemPanel = lazy(() => import("./SystemPanel"));
const ExpansionOperationsPanel = lazy(
  () => import("./ExpansionOperationsPanel"),
);
export default function ToolPanel({
  studio: s,
  generation: g,
  expansion: x,
  onTemplates,
}: {
  studio: StudioState;
  generation: GenerationState;
  expansion: ExpansionState;
  onTemplates: () => void;
}) {
  const p = s.project,
    [sectionName, setSectionName] = useState("");
  const {
    query,
    setQuery,
    filter,
    setFilter,
    error: viewError,
  } = usePanelView(s.project.id, x.environmentId, "blocks");
  const [qualityFix, setQualityFix] = useState<QualityFix | null>(null),
    [fixRevision, setFixRevision] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const favorites = p.extensions?.favorites || [],
    recent = p.extensions?.recentBlocks || [];
  const catalog = CATALOG.filter(
    (item) =>
      (item.name + item.description + item.type)
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "favorites" && favorites.includes(item.type)) ||
        (filter === "recent" && recent.includes(item.type))),
  );
  const checklist = [
    {
      id: "info",
      label: "사이트 이름·검색 설명",
      done: Boolean(p.name.trim() && p.settings.description.trim()),
      panel: "pages",
    },
    {
      id: "content",
      label: "실제 콘텐츠 입력",
      done: p.blocks.some((b) => Boolean(b.props.body.trim())),
      panel: "blocks",
    },
    {
      id: "actions",
      label: "주요 버튼 연결",
      done: !p.blocks.some(
        (b) =>
          b.type === "hero" &&
          b.props.primaryAction &&
          b.props.action.kind === "none",
      ),
      panel: "quality",
    },
    {
      id: "mobile",
      label: "모바일 화면 직접 확인",
      done:
        p.extensions?.checklist?.some((x) => x.id === "mobile" && x.checked) ||
        false,
      panel: "quality",
    },
    {
      id: "quality",
      label: "생성 오류 해결",
      done: !s.issues.some((i) => i.severity === "error"),
      panel: "quality",
    },
  ];
  const panels = [
    ["blocks", "블록", "▦"],
    ["pages", "페이지", "▤"],
    ["layers", "레이어", "▱"],
    ["assets", "이미지", "▧"],
    ["projects", "프로젝트", "▣"],
    ["quality", "품질 검사", "✓"],
    ["output", "결과물", "↗"],
    ["operations", "운영", "◉"],
  ];
  return (
    <>
      <nav className="tool-rail" aria-label="편집 도구">
        {panels.map(([id, label, icon]) => (
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
        <h2 tabIndex={-1}>
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
        <Suspense
          fallback={<p role="status">선택한 편집 도구를 불러오는 중…</p>}
        >
          {s.panel === "blocks" ? (
            <>
              <SharedLibraryPanel studio={s} expansion={x} />
              <PackPanel studio={s} expansion={x} />
              <details className="completion-guide">
                <summary>
                  사이트 완성 안내 · {checklist.filter((x) => x.done).length}/
                  {checklist.length}
                </summary>
                {checklist.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="checklist-item"
                    onClick={() => {
                      s.setPanel(item.panel);
                      if (item.id === "info") {
                        s.setSelected([]);
                        s.setInspectorOpen(true);
                      }
                    }}
                  >
                    {item.done ? "✓" : "○"} {item.label}
                  </button>
                ))}
              </details>
              <label className="search-field">
                <span>블록 검색</span>
                <input
                  placeholder="폼, 메뉴, 차트…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              {viewError && <p role="status">{viewError}</p>}
              <div className="panel-tabs">
                {[
                  ["all", "전체"],
                  ["favorites", "즐겨찾기"],
                  ["recent", "최근"],
                ].map(([value, name]) => (
                  <button
                    key={value}
                    type="button"
                    className={filter === value ? "active" : ""}
                    onClick={() => setFilter(value!)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              {[...new Set(catalog.map((x) => x.category))].map((category) => (
                <section key={category} className="catalog-group">
                  <h3>{category}</h3>
                  {catalog
                    .filter((x) => x.category === category)
                    .map((item) => (
                      <div className="catalog-entry" key={item.type}>
                        <button
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
                          <span
                            className={`block-thumb block-thumb-${item.type}`}
                            aria-hidden="true"
                          >
                            {["table", "chart", "form"].includes(item.type)
                              ? "▤ ▥"
                              : "▰ ▱"}
                          </span>
                          <strong>
                            {item.name}
                            <span>＋</span>
                          </strong>
                          <small>{item.description}</small>
                        </button>
                        <button
                          type="button"
                          className="favorite-button"
                          aria-label={`${item.name} 즐겨찾기`}
                          aria-pressed={favorites.includes(item.type)}
                          onClick={() =>
                            s.apply((x) => {
                              x.extensions ??= {};
                              x.extensions.favorites = favorites.includes(
                                item.type,
                              )
                                ? favorites.filter((t) => t !== item.type)
                                : [...favorites, item.type];
                            })
                          }
                        >
                          {favorites.includes(item.type) ? "★" : "☆"}
                        </button>
                      </div>
                    ))}
                </section>
              ))}
              {!catalog.length ? (
                <div className="empty-panel">
                  <p>조건에 맞는 블록이 없습니다.</p>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    검색 초기화
                  </button>
                </div>
              ) : null}
              <p className="hint">
                클릭은 반응형 흐름, 캔버스로 끌면 자유 배치입니다. 자유 배치는
                작은 화면에서 흐름으로 정리되므로 모바일 화면을 확인하세요.
              </p>
              <details>
                <summary>목적별 섹션 묶음</summary>
                {[
                  { name: "소개·문의", types: ["hero", "cards", "form"] },
                  { name: "서비스·가격", types: ["hero", "pricing", "faq"] },
                  { name: "업무·수치", types: ["table", "chart", "form"] },
                ].map((pack) => (
                  <button
                    type="button"
                    key={pack.name}
                    onClick={() =>
                      s.apply((x) => {
                        for (const type of pack.types) {
                          const block = createBlock(
                            type as BlockType,
                            x,
                            s.activePage.id,
                          );
                          block.design.themeMode = "theme";
                          x.blocks.push(block);
                        }
                      })
                    }
                  >
                    {pack.name} 추가
                  </button>
                ))}
              </details>
              <details>
                <summary>내 재사용 섹션</summary>
                <label>
                  선택 블록 저장 이름
                  <input
                    value={sectionName}
                    onChange={(e) => setSectionName(e.target.value)}
                    maxLength={200}
                  />
                </label>
                <button
                  type="button"
                  disabled={!s.selected.length || !sectionName.trim()}
                  onClick={() => {
                    s.setHistory((current) =>
                      historyChange(
                        current,
                        saveSection(current.present, s.selected, sectionName),
                      ),
                    );
                    setSectionName("");
                  }}
                >
                  선택을 섹션으로 저장
                </button>
                {p.extensions?.reusableSections?.map((section) => (
                  <div className="project-card" key={section.id}>
                    <strong>{section.name}</strong>
                    <small>{section.blocks.length}블록</small>
                    <button
                      type="button"
                      onClick={() =>
                        s.setHistory((current) =>
                          historyChange(
                            current,
                            insertSection(
                              current.present,
                              section.id,
                              s.activePage.id,
                            ),
                          ),
                        )
                      }
                    >
                      현재 페이지에 추가
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        s.apply((x) => {
                          x.extensions!.reusableSections =
                            x.extensions!.reusableSections!.filter(
                              (item) => item.id !== section.id,
                            );
                        })
                      }
                    >
                      섹션 삭제
                    </button>
                  </div>
                ))}
              </details>
            </>
          ) : null}
          {s.panel === "pages" ? <PagePanel studio={s} expansion={x} /> : null}
          {s.panel === "layers" ? (
            <LayerPanel studio={s} environmentId={x.environmentId} />
          ) : null}
          {s.panel === "assets" ? (
            <>
              <BlobAssetsPanel
                key={`${s.project.id}:${x.environmentId}`}
                studio={s}
                expansion={x}
              />
              <AssetsPanel studio={s} />
            </>
          ) : null}
          {s.panel === "projects" ? (
            <>
              <ExpansionWorkspacePanel studio={s} expansion={x} />
              <ProjectsPanel
                studio={s}
                onTemplates={onTemplates}
                onImport={() => fileRef.current?.click()}
              />
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
                  <div key={`${issue.code}-${i}`}>
                    <button
                      type="button"
                      className={`issue ${issue.severity}`}
                      key={`${issue.code}-${i}`}
                      onClick={() => s.focusIssue(issue)}
                    >
                      <strong>
                        {issue.severity === "error" ? "수정 필요" : "확인 권장"}
                      </strong>
                      <span>{issue.message}</span>
                      {issue.impact ? <small>{issue.impact}</small> : null}
                      {issue.remedy ? (
                        <small>수정: {issue.remedy}</small>
                      ) : null}
                    </button>
                    {previewQualityFix(p, issue) ? (
                      <button
                        type="button"
                        className="secondary full"
                        onClick={() => {
                          setQualityFix(previewQualityFix(p, issue));
                          setFixRevision(p.revision);
                        }}
                      >
                        수정안 검토
                      </button>
                    ) : null}
                  </div>
                ))
              )}
              <fieldset>
                <legend>사람이 확인할 항목</legend>
                {[
                  ["mobile", "모바일 화면·넘침 확인"],
                  ["facts", "문구·연락처·가격 확인"],
                  ["keyboard", "키보드 이동·버튼 동작 확인"],
                ].map(([id, label]) => (
                  <label className="check" key={id}>
                    <input
                      type="checkbox"
                      checked={
                        p.extensions?.checklist?.find((x) => x.id === id)
                          ?.checked || false
                      }
                      onChange={(e) =>
                        s.apply((x) => {
                          x.extensions ??= {};
                          x.extensions.checklist ??= [];
                          const item = x.extensions.checklist.find(
                            (x) => x.id === id,
                          );
                          if (item) item.checked = e.target.checked;
                          else
                            x.extensions.checklist.push({
                              id: id!,
                              label: label!,
                              checked: e.target.checked,
                            });
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <p className="hint">
                자동 검사 통과는 실제 기기·문구·시각 균형 확인을 대신하지
                않습니다.
              </p>
            </>
          ) : null}
          {s.panel === "output" ? (
            <>
              {g.result ? (
                <>
                  <div className="output-success">
                    ✓ 사이트가 준비되었습니다
                  </div>
                  <p>
                    {g.operations
                      ? g.operations.running.some(
                          (run) => run.id === g.result?.id,
                        )
                        ? "이 컴퓨터에서 실행 중"
                        : "로컬 실행이 종료되었습니다"
                      : "로컬 실행 상태 확인 필요"}{" "}
                    · 공개 배포 미확인
                  </p>
                  <p>
                    생성 편집본 v{g.resultRevision ?? "?"} / 현재 v{p.revision}
                  </p>
                  {g.stale ? (
                    <p className="hint">
                      결과의 원본 버전 또는 환경이 현재 선택과 다릅니다. 생성
                      범위를 확인하거나 현재 환경으로 새로 생성하세요.
                    </p>
                  ) : null}
                  {g.operations &&
                  !g.operations.running.some(
                    (run) => run.id === g.result?.id,
                  ) ? (
                    <button
                      type="button"
                      className="secondary full"
                      onClick={() => void g.restart(g.result!.id)}
                    >
                      로컬 사이트 다시 실행
                    </button>
                  ) : (
                    <a
                      className="button-link"
                      href={g.result.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      웹사이트 바로 열기 ↗
                    </a>
                  )}
                  <a
                    className="button-link"
                    href={`/api/exports/${g.result.id}/download`}
                    download
                  >
                    소스·실행파일 ZIP 다운로드
                  </a>
                  <button
                    type="button"
                    className="secondary full"
                    onClick={s.exportOriginal}
                  >
                    편집 원본 JSON 다운로드
                  </button>
                  <p className="hint">
                    ZIP은 소스·실행파일·편집 원본을 포함합니다. 실제 문의·표
                    DB는 운영 데이터 백업에서 별도로 다운로드하세요.
                  </p>
                  <label>
                    실행 주소
                    <input readOnly value={g.result.url} />
                  </label>
                  <details>
                    <summary>결과물 위치·실행</summary>
                    <textarea readOnly rows={3} value={g.result.path} />
                    <p className="hint">
                      다음에도 생성 폴더의 start-site.cmd를 실행하면 사이트와
                      저장 데이터가 열립니다.
                    </p>
                  </details>
                  <p>
                    {(g.result.durationMs / 1000).toFixed(1)}초 · 자동 검사 권장{" "}
                    {g.result.issues.length}개
                  </p>
                </>
              ) : (
                <p className="hint">
                  상단 ‘사이트 만들고 열기’를 누르면 검사·생성·로컬 실행을
                  진행합니다.
                </p>
              )}
              {g.job ? <p role="status">진행 상태: {g.job.stage}</p> : null}
              {g.busy ? (
                <button type="button" className="danger" onClick={g.cancel}>
                  생성 취소
                </button>
              ) : null}
              {g.job?.status === "failed" ? (
                <button type="button" onClick={() => void g.retry()}>
                  실패 작업 재시도
                </button>
              ) : null}
            </>
          ) : null}
          {s.panel === "operations" ? (
            <>
              <SystemPanel
                key={p.id + ":" + x.environmentId}
                studio={s}
                expansion={x}
              />
              <ExpansionOperationsPanel
                key={p.id + ":" + x.environmentId}
                studio={s}
                expansion={x}
              />
              <OperationsPanel
                key={p.id + ":" + x.environmentId}
                studio={s}
                generation={g}
                environmentId={x.environmentId}
              />
            </>
          ) : null}
        </Suspense>
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
      {qualityFix ? (
        <EditorDialog
          title="품질 수정안 검토"
          onClose={() => setQualityFix(null)}
        >
          <p>{qualityFix.summary}</p>
          {qualityFix.changes.map((change, index) => (
            <article key={index} className="page-card">
              <strong>
                {p.blocks.find((x) => x.id === change.blockId)?.name} ·{" "}
                {change.field}
              </strong>
              <p>현재: {change.before}</p>
              <p>수정: {change.after}</p>
            </article>
          ))}
          <button
            type="button"
            className="primary"
            disabled={p.revision !== fixRevision}
            onClick={() => {
              s.setHistory((current) =>
                historyChange(current, qualityFix.project),
              );
              setQualityFix(null);
              s.setMessage(
                "검토한 수정안을 적용했습니다. 한 번의 실행 취소로 복구할 수 있습니다.",
              );
            }}
          >
            검토한 수정안 적용
          </button>
        </EditorDialog>
      ) : null}
    </>
  );
}
