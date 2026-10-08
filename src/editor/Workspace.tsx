import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { Block, BlockType, Project } from "../domain/types";
import { CATALOG, uid } from "../domain/catalog";
import {
  guidePosition,
  canvasPoint,
  duplicateBlocks,
  historyChange,
  snap,
} from "../domain/commands";
import SiteApp from "../runtime/SiteApp";
import type { StudioState } from "./useStudio";
import { trackStudioEvent } from "../infrastructure/telemetry";
export default function Workspace({
  studio: s,
  onTemplates,
}: {
  studio: StudioState;
  onTemplates: () => void;
}) {
  const p = s.project;
  const [viewport, setViewport] = useState(1440),
    [zoom, setZoom] = useState(0.65),
    [grid, setGrid] = useState(true),
    [guides, setGuides] = useState<Array<{ axis: "x" | "y"; value: number }>>(
      [],
    ),
    [draft, setDraft] = useState<Project | null>(null);
  const [inline, setInline] = useState<{
      id: string;
      key: "title" | "body";
      value: string;
    } | null>(null),
    [dropTarget, setDropTarget] = useState("");
  const finishInline = () => {
    if (!inline) return;
    s.apply((p) => {
      const b = p.blocks.find((x) => x.id === inline.id);
      if (b) b.props[inline.key] = inline.value;
    });
    setInline(null);
  };
  const paper = useRef<HTMLDivElement>(null),
    draftRef = useRef<Project | null>(null),
    drag = useRef<{
      blockId: string;
      start: { x: number; y: number };
      original: Project;
      resize: boolean;
      ids: string[];
    } | null>(null);
  const select = (b: Block, shift = false) => {
    s.setInspectorOpen(true);
    s.setSelected((current) =>
      shift
        ? current.includes(b.id)
          ? current.filter((id) => id !== b.id)
          : [...current, b.id]
        : b.groupId
          ? p.blocks.filter((x) => x.groupId === b.groupId).map((x) => x.id)
          : [b.id],
    );
  };
  const start = (
    event: PointerEvent<HTMLElement>,
    b: Block,
    resize = false,
  ) => {
    if (
      inline?.id === b.id ||
      s.testMode ||
      b.locked ||
      b.layout.mode !== "absolute" ||
      viewport < 641
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!s.selected.includes(b.id) || event.shiftKey) select(b, event.shiftKey);
    drag.current = {
      blockId: b.id,
      start: { x: event.clientX, y: event.clientY },
      original: p,
      resize,
      ids: b.groupId
        ? p.blocks
            .filter((x) => x.groupId === b.groupId && !x.locked)
            .map((x) => x.id)
        : s.selected.includes(b.id)
          ? s.selected
          : [b.id],
    };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state) return;
    const dx = (event.clientX - state.start.x) / zoom,
      dy = (event.clientY - state.start.y) / zoom;
    const next = structuredClone(state.original);
    const b = next.blocks.find((x) => x.id === state.blockId)!;
    const align = (value: number) =>
      grid ? snap(value, p.canvas.gridSize) : Math.round(value);
    if (state.resize) {
      b.layout.width = Math.max(
        24,
        Math.min(viewport, align(b.layout.width + dx)),
      );
      b.layout.height = Math.max(24, align(b.layout.height + dy));
    } else {
      let x = align(b.layout.x + dx),
        y = align(b.layout.y + dy);
      if (grid) {
        const result = guidePosition(
          b,
          x,
          y,
          next.blocks.filter(
            (peer) => !state.ids.includes(peer.id) && peer.pageId === b.pageId,
          ),
          viewport,
          6 / zoom,
        );
        x = result.x;
        y = result.y;
        setGuides(result.guides);
      } else setGuides([]);
      const selected = next.blocks.filter(
        (peer) =>
          state.ids.includes(peer.id) &&
          !peer.locked &&
          peer.layout.mode === "absolute",
      );
      const deltaX = Math.max(
        -Math.min(...selected.map((peer) => peer.layout.x)),
        Math.min(
          x - b.layout.x,
          viewport -
            Math.max(
              ...selected.map((peer) => peer.layout.x + peer.layout.width),
            ),
        ),
      );
      const deltaY = Math.max(
        -Math.min(...selected.map((peer) => peer.layout.y)),
        y - b.layout.y,
      );
      for (const peer of selected) {
        peer.layout.x = Math.max(0, Math.round(peer.layout.x + deltaX));
        peer.layout.y = Math.max(0, Math.round(peer.layout.y + deltaY));
      }
    }
    draftRef.current = next;
    setDraft(next);
  };
  const end = () => {
    if (!drag.current) return;
    const next = draftRef.current;
    if (next)
      s.setHistory((current) =>
        historyChange(current, {
          ...next,
          revision: current.present.revision + 1,
          updatedAt: new Date().toISOString(),
        }),
      );
    drag.current = null;
    draftRef.current = null;
    setDraft(null);
    setGuides([]);
  };
  const cancel = () => {
    drag.current = null;
    draftRef.current = null;
    setDraft(null);
    setGuides([]);
  };
  const decorate = (b: Block, node: ReactNode) => (
    <div
      key={b.id}
      className={`edit-block ${p.blocks.length>100&&b.layout.mode==="flow"&&!s.selected.includes(b.id)?"deferred-block":""} ${s.selected.includes(b.id) ? "selected" : ""} ${dropTarget === b.id ? "drop-target" : ""}`}
      data-edit-id={b.id}
      tabIndex={0}
      role="group"
      aria-label={`${b.name} 편집 블록`}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select(b, event.shiftKey);
          s.setInspectorOpen(true);
        }
      }}
      style={
        b.layout.mode === "absolute"
          ? {
              position: "absolute",
              left: b.layout.x,
              top: b.layout.y,
              width: b.layout.width,
              minHeight: b.layout.height,
              zIndex: b.layout.zIndex,
            }
          : undefined
      }
      draggable={!b.locked && b.layout.mode === "flow"}
      onDragStart={(e) =>
        e.dataTransfer.setData("application/x-automade-move", b.id)
      }
      onDragOver={(e) => {
        e.preventDefault();
        if (!b.locked) setDropTarget(b.id);
      }}
      onDragLeave={() => setDropTarget("")}
      onDrop={(event) => {
        setDropTarget("");
        const id = event.dataTransfer.getData("application/x-automade-move");
        if (id && id !== b.id) {
          event.stopPropagation();
          s.apply((p) => {
            const source = p.blocks.find((x) => x.id === id);
            if (!source || source.locked) return;
            source.parentId = b.parentId;
            source.pageId = b.pageId;
            const ordered = p.blocks.filter((x) => x.id !== id);
            const index = ordered.findIndex((x) => x.id === b.id);
            ordered.splice(index, 0, source);
            ordered.forEach((x, i) => (x.layout.zIndex = i + 1));
            p.blocks = ordered;
          });
        }
      }}
      onClickCapture={(event) => {
        if (inline?.id === b.id) return;
        event.preventDefault();
        event.stopPropagation();
        if (!s.selected.includes(b.id) || event.shiftKey)
          select(b, event.shiftKey);
      }}
      onDoubleClick={(event) => {
        if (b.locked || !["hero", "text", "footer"].includes(b.type)) return;
        event.stopPropagation();
        const target = event.target as HTMLElement;
        const key = target.closest("h1,h2,h3") ? "title" : "body";
        setInline({ id: b.id, key, value: b.props[key] });
        select(b);
      }}
      onPointerDown={(event) => start(event, b)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={cancel}
    >
      {node}
      {inline?.id === b.id ? (
        <div
          className="inline-text-editor"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <label>
            {inline.key === "title" ? "제목" : "본문"} 바로 편집
            <textarea
              autoFocus
              value={inline.value}
              onChange={(e) => setInline({ ...inline, value: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setInline(null);
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter")
                  finishInline();
              }}
            />
          </label>
          <button type="button" onClick={finishInline}>
            텍스트 적용
          </button>
          <button type="button" onClick={() => setInline(null)}>
            취소
          </button>
        </div>
      ) : null}
      {s.selected.includes(b.id) ? (
        <>
          <span className="selection-label">
            {b.name}
            {b.locked ? " · 잠김" : ""}
            {` · ${b.layout.mode === "flow" ? "흐름" : `${Math.round(b.layout.width)}×${Math.round(b.layout.height)}`}`}
          </span>
          {b.layout.mode === "absolute" && !b.locked && viewport > 640 ? (
            <button
              className="resize-handle"
              type="button"
              aria-label={`${b.name} 크기 조절`}
              onPointerDown={(event) => start(event, b, true)}
              onPointerMove={move}
              onPointerUp={end}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
  const alignSelection = (kind: "left" | "top" | "horizontal" | "vertical") =>
    s.apply((p) => {
      const blocks = p.blocks.filter(
        (b) =>
          s.selected.includes(b.id) &&
          b.layout.mode === "absolute" &&
          !b.locked,
      );
      if (blocks.length < 2) return;
      const minX = Math.min(...blocks.map((b) => b.layout.x)),
        minY = Math.min(...blocks.map((b) => b.layout.y));
      if (kind === "left") blocks.forEach((b) => (b.layout.x = minX));
      else if (kind === "top") blocks.forEach((b) => (b.layout.y = minY));
      else {
        const axis = kind === "horizontal" ? "x" : "y";
        const sorted = blocks.sort((a, b) => a.layout[axis] - b.layout[axis]);
        const begin = sorted[0]!.layout[axis],
          finish = sorted.at(-1)!.layout[axis];
        sorted.forEach(
          (b, i) =>
            (b.layout[axis] = Math.round(
              begin + ((finish - begin) * i) / (sorted.length - 1),
            )),
        );
      }
    });
  return (
    <section className="workspace">
      <div className="workspace-toolbar">
        <label>
          페이지
          <select
            value={s.activePage.id}
            onChange={(e) => {
              s.setPageId(e.target.value);
              s.setSelected([]);
            }}
          >
            {p.pages.map((page) => (
              <option value={page.id} key={page.id}>
                {page.title}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented">
          {[
            [1440, "PC"],
            [768, "태블릿"],
            [390, "모바일"],
          ].map(([width, label]) => (
            <button
              className={viewport === width ? "active" : ""}
              type="button"
              key={width}
              onClick={() => {
                cancel();
                setViewport(Number(width));
                if (Number(width) === 390)
                  void trackStudioEvent(p.id, "preview.mobile");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label>
          확대
          <select
            aria-label="확대"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          >
            {[0.25, 0.5, 0.65, 0.75, 1, 1.25, 1.5].map((v) => (
              <option value={v} key={v}>
                {Math.round(v * 100)}%
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary"
          type="button"
          onClick={() =>
            setZoom(
              Math.min(
                1,
                Math.max(
                  0.25,
                  ((paper.current?.parentElement?.clientWidth ?? 900) /
                    viewport) *
                    0.9,
                ),
              ),
            )
          }
        >
          화면 맞춤
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={grid}
            onChange={(e) => setGrid(e.target.checked)}
          />
          스냅
        </label>
        <button
          className={s.testMode ? "primary" : "secondary"}
          type="button"
          onClick={() => {
            cancel();
            s.setTestMode(!s.testMode);
          }}
        >
          {s.testMode ? "편집으로 돌아가기" : "동작 미리보기"}
        </button>
      </div>
      {s.selected.length && !s.testMode ? (
        <div className="selection-toolbar">
          <span>{s.selected.length}개 선택</span>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              s.setHistory((current) =>
                historyChange(
                  current,
                  duplicateBlocks(current.present, s.selected),
                ),
              )
            }
          >
            복제
          </button>
          <button type="button" className="danger" onClick={s.removeSelection}>
            삭제
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() =>
              s.apply((p) => {
                const group = uid();
                p.blocks
                  .filter((b) => s.selected.includes(b.id))
                  .forEach((b) => (b.groupId = group));
              })
            }
          >
            그룹
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() =>
              s.apply((p) => {
                p.blocks
                  .filter((b) => s.selected.includes(b.id))
                  .forEach((b) => (b.groupId = null));
              })
            }
          >
            그룹 해제
          </button>
          {s.selected.length > 1 ? (
            <>
              {(["left", "top", "horizontal", "vertical"] as const).map(
                (kind, i) => (
                  <button
                    key={kind}
                    className="secondary"
                    type="button"
                    onClick={() => alignSelection(kind)}
                  >
                    {["왼쪽 정렬", "위쪽 정렬", "가로 분배", "세로 분배"][i]}
                  </button>
                ),
              )}
            </>
          ) : null}
          <button
            className="secondary"
            type="button"
            onClick={() => s.setSelected([])}
          >
            선택 해제
          </button>
        </div>
      ) : null}
      <div className="canvas-area">
        <div className="canvas-label">
          {s.activePage.title} · {viewport}px ·{" "}
          {s.testMode ? "입력과 클릭 확인 (저장 안 됨)" : "화면 편집"}
        </div>
        <div
          className="canvas-paper"
          ref={paper}
          style={{
            width: viewport * zoom,
            minHeight:
              (p.blocks.some((b) => b.layout.mode === "absolute")
                ? p.canvas.height
                : 700) * zoom,
          }}
        >
          <div
            className={`canvas-surface ${grid ? "show-grid" : ""}`}
            style={
              {
                width: viewport,
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
                "--grid": `${p.canvas.gridSize}px`,
              } as CSSProperties
            }
            onKeyDown={(e) => {
              if (e.key === "Escape") cancel();
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (s.testMode) return;
              const type = event.dataTransfer.getData(
                "application/x-automade-block",
              );
              if (CATALOG.some((x) => x.type === type)) {
                const bounds = event.currentTarget.getBoundingClientRect();
                const point = canvasPoint(
                  event.clientX,
                  event.clientY,
                  bounds,
                  { width: viewport, height: bounds.height / zoom },
                );
                s.addBlock(type as BlockType, {
                  x: grid ? snap(point.x, p.canvas.gridSize) : point.x,
                  y: grid ? snap(point.y, p.canvas.gridSize) : point.y,
                });
              }
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget) s.setSelected([]);
            }}
          >
            <SiteApp
              project={draft ?? p}
              pageId={s.activePage.id}
              onPageChange={s.setPageId}
              mode="preview"
              apiBase="/"
              decorate={s.testMode ? undefined : decorate}
            />
            {guides.map((guide, i) => (
              <div
                key={i}
                className={"canvas-guide guide-" + guide.axis}
                style={
                  guide.axis === "x"
                    ? { left: guide.value }
                    : { top: guide.value }
                }
                aria-hidden="true"
              />
            ))}
            {!p.blocks.some(
              (b) => b.pageId === s.activePage.id || b.pageId === "*",
            ) ? (
              <div className="empty-canvas">
                <span>▦</span>
                <h2>사이트의 첫 블록을 추가하세요</h2>
                <p>왼쪽에서 블록을 클릭하거나 템플릿으로 시작하세요.</p>
                <button className="primary" type="button" onClick={onTemplates}>
                  템플릿으로 시작
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <footer className="workspace-status">
        <span>
          {p.blocks.length}블록 · {p.pages.length}페이지
        </span>
        <span>Shift 클릭 다중 선택 · 방향키 이동 · Ctrl+Z 취소</span>
      </footer>
    </section>
  );
}
