import type { Block, Project } from "./types";
import { effectiveDesign } from "./content";

type Rgb = [number, number, number];
interface Rgba {
  rgb: Rgb;
  alpha: number;
}
function parseColor(hex: string): Rgba {
  if (!/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(hex))
    throw new Error("올바른 HEX 색상이 필요합니다.");
  let value = hex.slice(1);
  if (value.length === 3)
    value = value
      .split("")
      .map((channel) => channel + channel)
      .join("");
  return {
    rgb: [0, 2, 4].map(
      (offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255,
    ) as Rgb,
    alpha: value.length === 8 ? Number.parseInt(value.slice(6), 16) / 255 : 1,
  };
}
function composite(foreground: Rgba, background: Rgb): Rgb {
  return foreground.rgb.map(
    (channel, index) =>
      channel * foreground.alpha + background[index]! * (1 - foreground.alpha),
  ) as Rgb;
}
function luminance(rgb: Rgb): number {
  const linear = rgb.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}
export function blockColors(
  project: Project,
  block: Block,
): { background: Rgb; foreground: Rgb } {
  const ancestors: Block[] = [],
    visited = new Set<string>();
  let current: Block | undefined = block;
  while (current && !visited.has(current.id)) {
    ancestors.unshift(current);
    visited.add(current.id);
    current = current.parentId
      ? project.blocks.find((candidate) => candidate.id === current!.parentId)
      : undefined;
  }
  let background = composite(parseColor(project.canvas.background), [1, 1, 1]);
  for (const ancestor of ancestors)
    background = composite(
      parseColor(effectiveDesign(project, ancestor).background),
      background,
    );
  return {
    background,
    foreground: composite(
      parseColor(effectiveDesign(project, block).color),
      background,
    ),
  };
}
export function blockContrast(project: Project, block: Block): number {
  const { background, foreground } = blockColors(project, block),
    a = luminance(background),
    b = luminance(foreground);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function contrastingText(project: Project, block: Block): string {
  return luminance(blockColors(project, block).background) > 0.179
    ? "#000000"
    : "#ffffff";
}
