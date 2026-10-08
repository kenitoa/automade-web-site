import { useMemo, useRef, useState } from "react";
import type { Block } from "../domain/types";
import { historyChange, moveBlocks } from "../domain/commands";
import type { StudioState } from "./useStudio";
import { usePanelView } from "./usePanelView";
export default function LayerPanel({
  studio: s,
  environmentId,
}: {
  studio: StudioState;
  environmentId: string;
}) {
  const {
    query,
    setQuery,
    error: viewError,
  } = usePanelView(s.project.id, environmentId, "layers");
  const [collapsed, setCollapsed] = useState<string[]>([]),
    [page, setPage] = useState(s.activePage.id),
    [focused, setFocused] = useState("");
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const blocks = useMemo(
    () =>
      s.project.blocks
        .filter((b) => b.pageId === s.activePage.id || b.pageId === "*")
        .sort((a, b) => a.layout.zIndex - b.layout.zIndex),
    [s.project.blocks, s.activePage.id],
  );
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Block[]>();
    for (const b of blocks) {
      const key = b.parentId || "";
      const children = map.get(key) || [];
      children.push(b);
      map.set(key, children);
    }
    return map;
  }, [blocks]);
  const matches = useMemo(() => {
    const ids = new Set<string>(),
      byId = new Map(blocks.map((b) => [b.id, b]));
    for (const b of blocks)
      if (
        !query ||
        (b.name + b.props.title).toLowerCase().includes(query.toLowerCase())
      ) {
        let item: Block | undefined = b,
          depth = 0;
        while (item && depth++ < 21) {
          ids.add(item.id);
          item = item.parentId ? byId.get(item.parentId) : undefined;
        }
      }
    return ids;
  }, [blocks, query]);
  const visible: Block[] = [];
  const visit = (parent: string, depth = 0) => {
    if (depth > 20) return;
    for (const b of childrenByParent.get(parent) || []) {
      if (!matches.has(b.id)) continue;
      visible.push(b);
      if (query || !collapsed.includes(b.id)) visit(b.id, depth + 1);
    }
  };
  visit("");
  const focus = (id: string) => {
    setFocused(id);
    refs.current.get(id)?.focus();
  };
  const select = (b: Block, shift: boolean) => {
    s.setInspectorOpen(true);
    s.setSelected((current) =>
      shift
        ? current.includes(b.id)
          ? current.filter((x) => x !== b.id)
          : [...current, b.id]
        : [b.id],
    );
  };
  const reorder = (b: Block, delta: number) =>
    s.apply((p) => {
      const siblings = p.blocks
        .filter((x) => x.pageId === b.pageId && x.parentId === b.parentId)
        .sort((a, d) => a.layout.zIndex - d.layout.zIndex);
      const index = siblings.findIndex((x) => x.id === b.id),
        other = siblings[index + delta];
      if (other) {
        const value = other.layout.zIndex;
        other.layout.zIndex = b.layout.zIndex;
        p.blocks.find((x) => x.id === b.id)!.layout.zIndex = value;
      }
    });
  const node = (b: Block, depth: number): React.ReactNode => {
    if (depth > 20 || !matches.has(b.id)) return null;
    const children = childrenByParent.get(b.id) || [],
      siblings = (childrenByParent.get(b.parentId || "") || []).filter((item) =>
        matches.has(item.id),
      );
    return (
      <div
        key={b.id}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={s.selected.includes(b.id)}
        aria-expanded={children.length ? !collapsed.includes(b.id) : undefined}
        aria-posinset={siblings.findIndex((item) => item.id === b.id) + 1}
        aria-setsize={siblings.length}
      >
        <div
          className={`layer-row ${s.selected.includes(b.id) ? "active" : ""}`}
          style={{ paddingLeft: Math.min(depth, 8) * 12 }}
          onKeyDown={(event) => {
            if (event.target !== refs.current.get(b.id)) return;
            const index = visible.findIndex((item) => item.id === b.id);
            if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
              event.preventDefault();
              reorder(b, event.key === "ArrowUp" ? -1 : 1);
              s.setMessage(`${b.props.title || b.name} 순서를 변경했습니다.`);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              focus(
                visible[
                  Math.max(
                    0,
                    Math.min(
                      visible.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  )
                ]!.id,
              );
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              focus(visible[event.key === "Home" ? 0 : visible.length - 1]!.id);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              if (collapsed.includes(b.id))
                setCollapsed((value) => value.filter((id) => id !== b.id));
              else if (children[0]) focus(children[0].id);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              if (children.length && !collapsed.includes(b.id))
                setCollapsed((value) => [...value, b.id]);
              else if (b.parentId) focus(b.parentId);
            }
          }}
        >
          <button
            type="button"
            className="icon-button"
            disabled={!children.length}
            aria-label={`${b.name} 자식 접기`}
            onClick={() =>
              setCollapsed((current) =>
                current.includes(b.id)
                  ? current.filter((x) => x !== b.id)
                  : [...current, b.id],
              )
            }
          >
            {children.length ? (collapsed.includes(b.id) ? "▸" : "▾") : "·"}
          </button>
          <button
            type="button"
            className="layer-name"
            ref={(element) => {
              if (element) refs.current.set(b.id, element);
              else refs.current.delete(b.id);
            }}
            tabIndex={(focused || visible[0]?.id) === b.id ? 0 : -1}
            onFocus={() => setFocused(b.id)}
            aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home End Alt+ArrowUp Alt+ArrowDown"
            onClick={(e) => select(b, e.shiftKey)}
          >
            {b.props.title || b.name}
            <small>
              {b.pageId === "*" ? "공통 " : ""}
              {b.groupId ? "그룹 " : ""}
              {b.layout.mode === "absolute" ? "자유" : "흐름"}
            </small>
          </button>
          <button
            type="button"
            className="icon-button"
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
            type="button"
            className="icon-button"
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
            type="button"
            aria-label={`${b.name} 순서 위로`}
            className="icon-button"
            disabled={b.locked}
            onClick={() => reorder(b, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`${b.name} 순서 아래로`}
            className="icon-button"
            disabled={b.locked}
            onClick={() => reorder(b, 1)}
          >
            ↓
          </button>
        </div>
        {!collapsed.includes(b.id) || query ? (
          <div role="group">{children.map((x) => node(x, depth + 1))}</div>
        ) : null}
      </div>
    );
  };
  return (
    <>
      <label>
        레이어 검색
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {viewError && <p role="status">{viewError}</p>}
      <div
        role="tree"
        aria-label="현재 페이지 레이어"
        aria-multiselectable="true"
      >
        {(childrenByParent.get("") || []).map((b) => node(b, 0))}
      </div>
      <p className="hint">
        Shift 클릭으로 다중 선택합니다. 그룹은 함께 선택, 컨테이너는 자식
        배치입니다. 순서 버튼으로 키보드에서도 순서를 변경할 수 있습니다.
        화살표로 탐색·접기·펼치기, Home/End로 처음·끝, Alt+위/아래로 순서를
        변경합니다.
      </p>
      {s.selected.length ? (
        <fieldset>
          <legend>선택 레이어 이동</legend>
          <label>
            대상 페이지
            <select value={page} onChange={(e) => setPage(e.target.value)}>
              {s.project.pages.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              s.setHistory((current) =>
                historyChange(
                  current,
                  moveBlocks(current.present, s.selected, page),
                ),
              );
              s.setPageId(page);
            }}
          >
            이 페이지로 이동
          </button>
        </fieldset>
      ) : null}
    </>
  );
}
