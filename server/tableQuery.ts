import type { Row, TableColumn } from "../src/domain/types";
import { HttpError } from "./http";
export interface TableQuery { limit: number; offset: number; query: string; sortColumn: string | null; direction: "asc" | "desc" }
export function parseTableQuery(url: URL, columns: TableColumn[]): TableQuery | null {
  if (!url.searchParams.has("limit")) return null;
  const limit = Number(url.searchParams.get("limit")), offset = Number(url.searchParams.get("offset") ?? 0), query = url.searchParams.get("query") ?? "", sortColumn = url.searchParams.get("sortColumn"), direction = url.searchParams.get("direction") ?? "asc";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "TABLE_PAGINATION", "표 limit은 1~100, offset은 0 이상의 정수여야 합니다.");
  if (query.length > 200) throw new HttpError(400, "TABLE_SEARCH", "표 검색은 200자 이하여야 합니다.");
  if (sortColumn !== null && !columns.some((column) => column.id === sortColumn)) throw new HttpError(400, "TABLE_SORT", "정렬할 표 열을 확인하세요.");
  if (direction !== "asc" && direction !== "desc") throw new HttpError(400, "TABLE_DIRECTION", "표 정렬 방향은 asc 또는 desc입니다.");
  return { limit, offset, query: query.trim(), sortColumn, direction };
}
export function queryTable(rows: Row[], columns: TableColumn[], query: TableQuery): { rows: Row[]; total: number; limit: number; offset: number } {
  const search = query.query.toLocaleLowerCase();
  const filtered = rows.map((row, index) => ({ row, index })).filter(({ row }) => !search || row.values.some((value) => value.toLocaleLowerCase().includes(search)));
  const columnIndex = columns.findIndex((column) => column.id === query.sortColumn), column = columns[columnIndex];
  if (column) filtered.sort((a, b) => {
    const first = a.row.values[columnIndex]?.trim() ?? "", second = b.row.values[columnIndex]?.trim() ?? "";
    if (!first || !second) return first === second ? a.index - b.index : first ? -1 : 1;
    const order = column.type === "number" ? Number(first) - Number(second) : column.type === "date" ? Date.parse(first) - Date.parse(second) : first.localeCompare(second);
    const valid = Number.isFinite(order) ? order : first.localeCompare(second);
    return valid === 0 ? a.index - b.index : (query.direction === "desc" ? -valid : valid);
  });
  return { rows: filtered.slice(query.offset, query.offset + query.limit).map(({ row }) => ({ ...row, values: [...row.values] })), total: filtered.length, limit: query.limit, offset: query.offset };
}
