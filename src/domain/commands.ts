import { uid } from "./catalog";
import type { Block, Project } from "./types";
export function commit(
  project: Project,
  change: (draft: Project) => void,
): Project {
  const next = structuredClone(project);
  change(next);
  next.revision = project.revision + 1;
  next.updatedAt = new Date().toISOString();
  return next;
}
export function deleteBlocks(project: Project, ids: string[]): Project {
  const removed = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of project.blocks)
      if (b.parentId && removed.has(b.parentId) && !removed.has(b.id)) {
        removed.add(b.id);
        changed = true;
      }
  }
  return commit(project, (p) => {
    p.blocks = p.blocks.filter((b) => !removed.has(b.id));
    for (const b of p.blocks) {
      for (const key of ["action", "secondary"] as const) {
        const a = b.props[key];
        if (
          (a.kind === "modal" || a.kind === "scroll") &&
          removed.has(a.target)
        )
          b.props[key] = { kind: "none" };
      }
      b.props.items = b.props.items.map((i) => ({
        ...i,
        action:
          (i.action.kind === "modal" || i.action.kind === "scroll") &&
          removed.has(i.action.target)
            ? { kind: "none" }
            : i.action,
      }));
    }
  });
}
export function duplicateBlocks(project: Project, ids: string[]): Project {
  const chosen = new Set(ids);
  let count = -1;
  while (count !== chosen.size) {
    count = chosen.size;
    for (const b of project.blocks)
      if (b.parentId && chosen.has(b.parentId)) chosen.add(b.id);
  }
  const mapping = new Map([...chosen].map((id) => [id, uid()]));
  return commit(project, (p) => {
    for (const b of project.blocks.filter((x) => chosen.has(x.id))) {
      const copy = structuredClone(b);
      copy.id = mapping.get(b.id)!;
      copy.name = `${b.name} 복사`;
      copy.parentId = b.parentId
        ? (mapping.get(b.parentId) ?? b.parentId)
        : null;
      copy.groupId = null;
      copy.layout.x += p.canvas.gridSize;
      copy.layout.y += p.canvas.gridSize;
      copy.layout.zIndex = p.blocks.length + 1;
      for (const key of ["action", "secondary"] as const) {
        const action = copy.props[key];
        if (
          (action.kind === "modal" || action.kind === "scroll") &&
          mapping.has(action.target)
        )
          copy.props[key] = { ...action, target: mapping.get(action.target)! };
      }
      copy.props.items = copy.props.items.map((item) => ({
        ...item,
        id: uid(),
        action:
          (item.action.kind === "modal" || item.action.kind === "scroll") &&
          mapping.has(item.action.target)
            ? { ...item.action, target: mapping.get(item.action.target)! }
            : item.action,
      }));
      p.blocks.push(copy);
    }
  });
}
export function deletePage(project: Project, pageId: string): Project {
  if (project.pages.length < 2)
    throw new Error("마지막 페이지는 삭제할 수 없습니다.");
  const next = deleteBlocks(
    project,
    project.blocks.filter((b) => b.pageId === pageId).map((b) => b.id),
  );
  return commit(next, (p) => {
    const home = p.pages.find((x) => x.id === pageId)?.home;
    p.pages = p.pages.filter((x) => x.id !== pageId);
    if (home) {
      p.pages[0]!.home = true;
      p.pages[0]!.path = "/";
      p.pages[0]!.published = true;
    }
    for (const b of p.blocks) {
      for (const key of ["action", "secondary"] as const) {
        const action = b.props[key];
        if (action.kind === "navigate" && action.target === pageId)
          b.props[key] = { kind: "none" };
      }
      b.props.items = b.props.items.map((i) => ({
        ...i,
        action:
          i.action.kind === "navigate" && i.action.target === pageId
            ? { kind: "none" }
            : i.action,
      }));
    }
  });
}
export interface History {
  past: Project[];
  present: Project;
  future: Project[];
}
export function historyChange(history: History, next: Project): History {
  return {
    past: [...history.past, history.present].slice(-100),
    present: next,
    future: [],
  };
}
export function undo(history: History): History {
  const previous = history.past.at(-1);
  return previous
    ? {
        past: history.past.slice(0, -1),
        present: {
          ...previous,
          revision: history.present.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        future: [history.present, ...history.future],
      }
    : history;
}
export function redo(history: History): History {
  const next = history.future[0];
  return next
    ? {
        past: [...history.past, history.present],
        present: {
          ...next,
          revision: history.present.revision + 1,
          updatedAt: new Date().toISOString(),
        },
        future: history.future.slice(1),
      }
    : history;
}
export function snap(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}
export function canvasPoint(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  documentSize: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: ((clientX - bounds.left) * documentSize.width) / bounds.width,
    y: ((clientY - bounds.top) * documentSize.height) / bounds.height,
  };
}
export function orderBlocks(blocks: Block[]): Block[] {
  return [...blocks].sort((a, b) => a.layout.zIndex - b.layout.zIndex);
}

export function guidePosition(
  block: Block,
  x: number,
  y: number,
  peers: Block[],
  viewport: number,
  tolerance = 6,
): { x: number; y: number; guides: Array<{ axis: "x" | "y"; value: number }> } {
  const guides: Array<{ axis: "x" | "y"; value: number }> = [];
  const candidatesX = [0, viewport / 2, viewport],
    candidatesY = [0];
  for (const p of peers) {
    if (
      p.id === block.id ||
      p.hidden ||
      p.parentId !== block.parentId ||
      p.layout.mode !== "absolute"
    )
      continue;
    candidatesX.push(
      p.layout.x,
      p.layout.x + p.layout.width / 2,
      p.layout.x + p.layout.width,
    );
    candidatesY.push(
      p.layout.y,
      p.layout.y + p.layout.height / 2,
      p.layout.y + p.layout.height,
    );
  }
  const find = (
    value: number,
    size: number,
    lines: number[],
    axis: "x" | "y",
  ) => {
    let best = tolerance,
      adjust = 0,
      line: number | null = null;
    for (const target of lines)
      for (const edge of [0, size / 2, size]) {
        const delta = target - (value + edge);
        if (Math.abs(delta) < best) {
          best = Math.abs(delta);
          adjust = delta;
          line = target;
        }
      }
    if (line !== null) guides.push({ axis, value: line });
    return value + adjust;
  };
  return {
    x: find(x, block.layout.width, candidatesX, "x"),
    y: find(y, block.layout.height, candidatesY, "y"),
    guides,
  };
}

export function setHomePage(project: Project, pageId: string): Project {
  return commit(project, (p) => {
    const home = p.pages.find((page) => page.home);
    const next = p.pages.find((page) => page.id === pageId);
    if (!next || next.home) return;
    const priorPath = next.path;
    for (const page of p.pages) page.home = page.id === pageId;
    if (home) home.path = priorPath;
    next.path = "/";
    next.published = true;
  });
}
