import test from "node:test";
import assert from "node:assert/strict";
import { parseMappedData } from "../src/infrastructure/mappedData";
test("external rows preserve scalar types and explicit freshness without invented timestamps", () => {
  const actual = parseMappedData({
    rows: [{ label: "A", amount: 3, active: true, empty: null }],
    cached: true,
    fetchedAt: "2026-10-07T00:00:00Z",
  });
  assert.deepEqual(actual.rows, [
    { label: "A", amount: 3, active: true, empty: null },
  ]);
  assert.equal(actual.cached, true);
  assert.equal(actual.fetchedAt, "2026-10-07T00:00:00Z");
  assert.equal(parseMappedData({ rows: [] }).fetchedAt, "");
});
test("external row validation rejects nested values, prototype keys and unbounded lists", () => {
  for (const value of [
    { rows: [{ amount: Infinity }] },
    { rows: [{ nested: { token: "private" } }] },
    { rows: [JSON.parse('{"__proto__":"bad"}') as unknown] },
    { rows: Array.from({ length: 1001 }, () => ({ id: "row" })) },
  ])
    assert.throws(() => parseMappedData(value));
});
