import test from "node:test";
import assert from "node:assert/strict";
import { parseTableQuery, queryTable } from "../server/tableQuery";
import type { Row, TableColumn } from "../src/domain/types";
const columns: TableColumn[] = [{ id: "name", label: "Name", type: "text" }, { id: "amount", label: "Amount", type: "number" }, { id: "date", label: "Date", type: "date" }];
const rows: Row[] = [{ id: "first", values: ["Alpha", "10", "2026-10-02"] }, { id: "second", values: ["Beta", "2", "2026-10-01"] }, { id: "third", values: ["ALPHA", "2", "2026-10-03"] }, { id: "empty", values: ["Empty", "", ""] }];
const url = (query: string): URL => new URL(`http://127.0.0.1/api/tables/table${query}`);
test("table pagination validates bounded values and preserves legacy response selection", () => {
  assert.equal(parseTableQuery(url(""), columns), null); assert.equal(parseTableQuery(url("?query=Alpha"), columns), null);
  for (const query of ["?limit=0", "?limit=101", "?limit=1.5", "?limit=2&offset=-1", "?limit=2&sortColumn=missing", "?limit=2&direction=random", `?limit=2&query=${"x".repeat(201)}`]) assert.throws(() => parseTableQuery(url(query), columns));
  assert.deepEqual(parseTableQuery(url("?limit=10&offset=2&sortColumn=amount&direction=desc&query=Alpha"), columns), { limit: 10, offset: 2, query: "Alpha", sortColumn: "amount", direction: "desc" });
});
test("table search, numeric/date sorting, stable equal rows and pagination do not mutate source", () => {
  const numeric = queryTable(rows, columns, parseTableQuery(url("?limit=2&sortColumn=amount"), columns)!); assert.deepEqual(numeric.rows.map((row) => row.id), ["second", "third"]); assert.equal(numeric.total, 4);
  const next = queryTable(rows, columns, parseTableQuery(url("?limit=2&offset=2&sortColumn=amount"), columns)!); assert.deepEqual(next.rows.map((row) => row.id), ["first", "empty"]);
  const descending = queryTable(rows, columns, parseTableQuery(url("?limit=10&sortColumn=date&direction=desc"), columns)!); assert.deepEqual(descending.rows.map((row) => row.id), ["third", "first", "second", "empty"]);
  const searched = queryTable(rows, columns, parseTableQuery(url("?limit=1&query=alpha&sortColumn=amount"), columns)!); assert.equal(searched.total, 2); assert.equal(searched.rows[0]?.id, "third");
  numeric.rows[0]!.values[0] = "changed"; assert.equal(rows[1]?.values[0], "Beta"); assert.deepEqual(rows.map((row) => row.id), ["first", "second", "third", "empty"]);
});
