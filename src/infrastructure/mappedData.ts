import { record } from "../domain/validation";
export type DataRow = Record<string, string | number | boolean | null>;
export function parseMappedData(value: unknown): {
  rows: DataRow[];
  fetchedAt: string;
  cached: boolean;
  nextCursor: string | null;
} {
  const input = record(value);
  if (!Array.isArray(input.rows) || input.rows.length > 1000)
    throw new Error("조회 자료는 1,000행 이하여야 합니다.");
  const rows = input.rows.map((value) => {
    const row = record(value);
    if (
      Object.keys(row).length > 50 ||
      Object.entries(row).some(
        ([key, item]) =>
          !/^[A-Za-z0-9_-]{1,80}$/.test(key) ||
          ["__proto__", "prototype", "constructor"].includes(key) ||
          !(
            item === null ||
            (typeof item === "string" && item.length <= 50000) ||
            typeof item === "boolean" ||
            (typeof item === "number" && Number.isFinite(item))
          ),
      )
    )
      throw new Error(
        "조회 자료는 안전한 필드 이름과 문자열·숫자·참거짓 값만 사용할 수 있습니다.",
      );
    return row as DataRow;
  });
  const stamp =
    typeof input.fetchedAt === "string"
      ? input.fetchedAt
      : typeof input.fetchedAt === "number"
        ? new Date(input.fetchedAt).toISOString()
        : "";
  return {
    rows,
    fetchedAt: stamp && Number.isFinite(Date.parse(stamp)) ? stamp : "",
    cached: input.cached === true,
    nextCursor: typeof input.nextCursor === "string" ? input.nextCursor : null,
  };
}
