import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store";
import { createProject } from "../src/domain/catalog";
import { commit } from "../src/domain/commands";
test("migration applies once and compatible updates create backups", () => {
  const store = new Store(":memory:");
  try {
    const p = createProject("원본");
    store.save(p);
    store.save(p);
    const q = commit(p, (p) => (p.name = "수정"));
    store.save(q);
    assert.equal(store.project(p.id)?.name, "수정");
    assert.equal(store.backups(p.id)[0]?.name, "원본");
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM migrations").get()?.n,
      15,
    );
    assert.throws(() => store.save(p), /최신/);
  } finally {
    store.close();
  }
});
test("same revision with different content is a conflict", () => {
  const s = new Store(":memory:");
  try {
    const p = createProject();
    s.save(p);
    assert.throws(() => s.save({ ...p, name: "다른 내용" }), /충돌/);
    assert.equal(s.project(p.id)?.name, p.name);
  } finally {
    s.close();
  }
});
test("form submissions are idempotent and reject mismatched retry", () => {
  const s = new Store(":memory:");
  try {
    const a = s.submit("form", "key", { message: "안녕하세요" }),
      b = s.submit("form", "key", { message: "안녕하세요" });
    assert.equal(a.id, b.id);
    assert.equal(s.submissions().length, 1);
    assert.throws(() => s.submit("form", "key", { message: "다른 내용" }));
    const audit = JSON.stringify(s.audits());
    assert.ok(!audit.includes("안녕하세요"));
  } finally {
    s.close();
  }
});
test("table writes preserve optimistic versions and reject stale callers", () => {
  const s = new Store(":memory:");
  try {
    assert.equal(s.table("table", [], 2).version, 0);
    assert.equal(
      s.saveTable("table", [{ id: "row", values: ["사례", "완료"] }], 0),
      1,
    );
    assert.throws(() => s.saveTable("table", [], 0), /다른 창/);
    assert.equal(s.table("table", [], 2).rows.length, 1);
  } finally {
    s.close();
  }
});
