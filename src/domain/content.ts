import type {
  Block,
  ContentCollection,
  ContentRecord,
  Design,
  Item,
  Project,
  Row,
  TableColumn,
} from "./types";
import { uid } from "./catalog";
import { isRecordPublished } from "./cms";
import { publicationRecord } from "./contentState";

export function effectiveDesign(project: Project, block: Block): Design {
  return block.design.themeMode === "theme"
    ? {
        ...block.design,
        background: project.theme.surfaceColor,
        radius: project.theme.radius,
        fontSize: block.design.fontSize ?? project.theme.typography?.bodySize,
        headingSize:
          block.design.headingSize ?? project.theme.typography?.headingSize,
        lineHeight:
          block.design.lineHeight ?? project.theme.typography?.lineHeight,
      }
    : block.design;
}
export const contentPath = (
  collection: ContentCollection,
  record: ContentRecord,
  language?: string,
): string =>
  `${collection.path === "/" ? "" : collection.path}/${language ? (record.localizedSlugs?.[language] ?? record.slug) : record.slug}`;
export function publishedRecords(
  collection: ContentCollection,
  project?: Project,
): ContentRecord[] {
  // Publication is explicit. The timestamp is content metadata rather than an unreliable client clock gate.
  return collection.records
    .map(publicationRecord)
    .filter((r) =>
      isRecordPublished(
        r,
        undefined,
        !project?.featurePins?.some(
          (pin) => pin.packageId === "automade.content",
        ),
      ),
    );
}
export function getBoundItems(
  project: Project,
  block: Block,
): Array<Item & { detailPath?: string }> {
  const binding = block.props.collectionBinding;
  if (!binding) return block.props.items;
  const collection = project.collections?.find(
    (c) => c.id === binding.collectionId,
  );
  if (!collection) return [];
  return publishedRecords(collection, project)
    .filter((r) => !binding.category || r.category === binding.category)
    .slice(0, binding.limit)
    .map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      imageId: r.imageId || undefined,
      action: { kind: "none" },
      ...(binding.detailLinks
        ? { detailPath: contentPath(collection, r) }
        : {}),
    }));
}
export function findContent(
  project: Project,
  path: string,
): { collection: ContentCollection; record: ContentRecord } | undefined {
  for (const collection of project.collections ?? []) {
    const record = publishedRecords(collection, project).find(
      (r) =>
        contentPath(collection, r) === path ||
        Object.values(r.localizedSlugs ?? {}).some(
          (slug) =>
            `${collection.path === "/" ? "" : collection.path}/${slug}` ===
            path,
        ),
    );
    if (record) return { collection, record };
  }
}
export function getChartData(
  project: Project,
  block: Block,
  rows?: Row[],
): { values: number[]; labels: string[]; unit: string } {
  const binding = block.props.chartBinding;
  if (!binding)
    return {
      values: block.props.series,
      labels:
        block.props.chartLabels ??
        block.props.series.map((_, i) => String(i + 1)),
      unit: "",
    };
  const table = project.blocks.find(
    (b) => b.id === binding.tableBlockId && b.type === "table",
  );
  if (!table) return { values: [], labels: [], unit: binding.unit };
  const labelIndex = table.props.columns.findIndex(
      (c) => c.id === binding.labelColumnId,
    ),
    valueIndex = table.props.columns.findIndex(
      (c) => c.id === binding.valueColumnId,
    );
  if (labelIndex < 0 || valueIndex < 0)
    return { values: [], labels: [], unit: binding.unit };
  const points = (rows ?? table.props.rows).filter(
    (r) =>
      r.values[valueIndex]?.trim() &&
      Number.isFinite(Number(r.values[valueIndex])),
  );
  return {
    values: points.map((r) => Number(r.values[valueIndex])),
    labels: points.map((r) => r.values[labelIndex] ?? ""),
    unit: binding.unit,
  };
}
export interface TableRuleError {
  row: number;
  column: string;
  message: string;
}
/** Validates full proposed state, including duplicate values and immutable existing cells. */
export function validateTableRows(
  columns: TableColumn[],
  rows: Row[],
  previous: Row[] = [],
): TableRuleError[] {
  const errors: TableRuleError[] = [];
  columns.forEach((c, index) => {
    const seen = new Set<string>();
    rows.forEach((row, rowIndex) => {
      const value = (row.values[index] ?? "").trim();
      const reject = (message: string) =>
        errors.push({
          row: rowIndex,
          column: c.id,
          message: `${c.label}: ${message}`,
        });
      if (c.required && !value) reject("필수값을 입력하세요.");
      if (value && c.type === "number" && !Number.isFinite(Number(value)))
        reject("숫자를 입력하세요.");
      const date =
        c.type === "date" && value ? new Date(`${value}T00:00:00Z`) : null;
      if (
        date &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 10) !== value)
      )
        reject("올바른 날짜를 입력하세요.");
      if (c.unique && value && seen.has(value))
        reject("중복값을 사용할 수 없습니다.");
      if (value) seen.add(value);
      const original = previous.find((r) => r.id === row.id);
      if (
        c.readOnly &&
        original &&
        original.values[index] !== row.values[index]
      )
        reject("읽기 전용 열은 수정할 수 없습니다.");
    });
  });
  return errors;
}
export function visibleColumns(
  columns: TableColumn[],
): Array<{ column: TableColumn; index: number }> {
  return columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !column.hidden)
    .sort((a, b) => (a.column.order ?? a.index) - (b.column.order ?? b.index));
}
/** RFC4180 parsing, with explicit column mapping and a reviewable error result. No data is mutated. */
export function importTableCsv(
  source: string,
  columns: TableColumn[],
  mapping?: Record<string, number>,
  existing: Row[] = [],
): { headers: string[]; rows: Row[]; errors: TableRuleError[] } {
  if (source.length > 8_000_000)
    throw new Error("CSV 파일은 8MB 이하여야 합니다.");
  const matrix: string[][] = [],
    row: string[] = [];
  let cell = "",
    quoted = false,
    closed = false;
  const input = source.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === '"' && !cell && !closed) quoted = true;
    else if (char === "," || char === "\n" || char === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (char !== ",") {
        if (char === "\r" && input[i + 1] === "\n") i++;
        matrix.push([...row]);
        row.length = 0;
      }
    } else {
      if (closed || char === '"')
        throw new Error("CSV 따옴표 형식을 확인하세요.");
      cell += char;
    }
  }
  if (quoted) throw new Error("CSV의 닫는 따옴표가 없습니다.");
  if (cell || row.length || closed) {
    row.push(cell);
    matrix.push([...row]);
  }
  const headers = matrix.shift() ?? [];
  if (matrix.length > 10000 || headers.length > 100)
    throw new Error("CSV는 10,000행, 100열 이하여야 합니다.");
  const selected = columns.map(
    (c) => mapping?.[c.id] ?? headers.findIndex((h) => h.trim() === c.label),
  );
  if (
    selected.some((i) => i < 0 || i >= headers.length || !Number.isInteger(i))
  )
    throw new Error("모든 열의 연결을 선택하세요.");
  const rows = matrix
    .filter((values) => values.some((v) => v.trim()))
    .map((values) => ({
      id: uid(),
      values: selected.map((i) => values[i] ?? ""),
    }));
  const errors = validateTableRows(columns, [...existing, ...rows])
    .filter((e) => e.row >= existing.length)
    .map((e) => ({ ...e, row: e.row - existing.length }));
  matrix.forEach((values, i) => {
    if (values.length !== headers.length)
      errors.push({
        row: i,
        column: "",
        message: "CSV 행의 열 개수가 머리글과 다릅니다.",
      });
  });
  return { headers, rows, errors };
}
