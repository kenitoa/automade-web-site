import { commit } from "./commands";
import { contrastingText } from "./colors";
import type { Issue, Project } from "./types";
export interface QualityFix {
  project: Project;
  summary: string;
  changes: { blockId: string; field: string; before: string; after: string }[];
}

/** Returns a reversible draft for review; it never guesses content or changes the input. */
export function previewQualityFix(
  project: Project,
  issue: Issue,
): QualityFix | null {
  const block = project.blocks.find((b) => b.id === issue.blockId);
  if (!block || block.locked) return null;
  const changes: QualityFix["changes"] = [];
  const next = commit(project, (p) => {
    const b = p.blocks.find((b) => b.id === block.id)!;
    const change = (field: string, before: unknown, after: unknown) => {
      if (before !== after)
        changes.push({
          blockId: b.id,
          field,
          before: String(before),
          after: String(after),
        });
    };
    if (issue.code === "CONTRAST") {
      const color = contrastingText(p, b);
      change("design.color", b.design.color, color);
      b.design.color = color;
    } else if (issue.code === "OVERFLOW" && b.layout.mode === "absolute") {
      const width = Math.min(b.layout.width, p.canvas.width),
        x = Math.max(0, Math.min(b.layout.x, p.canvas.width - width));
      change("layout.x", b.layout.x, x);
      change("layout.width", b.layout.width, width);
      b.layout.x = x;
      b.layout.width = width;
    } else if (issue.code === "IMAGE_ALT") {
      const alt = p.assets.find((a) => a.id === b.props.assetId)?.alt.trim();
      if (alt) {
        change("props.alt", b.props.alt, alt);
        b.props.alt = alt;
      }
    } else if (issue.code === "FIELD_RANGE") {
      for (const f of b.props.fields)
        if (f.min > f.max) {
          change(`props.fields.${f.id}.min`, f.min, f.max);
          change(`props.fields.${f.id}.max`, f.max, f.min);
          [f.min, f.max] = [f.max, f.min];
        }
    }
  });
  return changes.length
    ? { project: next, summary: issue.message, changes }
    : null;
}
