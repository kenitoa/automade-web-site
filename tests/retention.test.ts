import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store";
import { createProject } from "../src/domain/catalog";
import { RetentionService } from "../server/retentionService";
import { saveTableWithHistory, tableHistory } from "../server/tableHistory";
const ancient = new Date(Date.now() - 400 * 86400_000).toISOString();
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "automade-retention-")), exports = path.join(root, "exports"), data = path.join(root, "data");
  await mkdir(exports); await mkdir(path.join(data, "backups/site"), { recursive: true }); await mkdir(path.join(data, "sites/site"), { recursive: true });
  const store = new Store(path.join(data, "studio.sqlite")), project = createProject("Retention"); project.id = "site"; store.save(project);
  const running = new Set<string>(), service = new RetentionService(store, exports, data, () => running);
  async function release(id: string, date = ancient, status = "ready") {
    const folder = path.join(exports, status === "ready" ? id : `.${id}.staging`); await mkdir(folder); await writeFile(path.join(folder, "source.txt"), `original:${id}`);
    store.exportStart(id, "site"); store.exportDone(id, status === "ready" ? folder : "", status === "ready" ? undefined : "GENERATION_FAILED"); store.db.prepare("UPDATE exports SET created_at=? WHERE id=?").run(date, id);
    return folder;
  }
  async function backup(id: string, date = ancient, exists = true) { const file = path.join(data, "backups/site", id + ".sqlite"); if (exists) await writeFile(file, `backup:${id}`); store.operations.addBackup({ id, projectId: "site", releaseId: null, createdAt: date, bytes: 16, reason: "test", submissions: 1, tables: 1 }, file); return file; }
  return { root, exports, data, store, service, running, release, backup };
}
test("retention preview protects current database, active/running/reserved artifacts and two actual latest backups", async () => {
  const f = await fixture();
  try {
    await f.release("latest-a", new Date().toISOString()); await f.release("latest-b", new Date(Date.now() - 1000).toISOString());
    await f.release("active"); await f.release("running"); await f.release("reserved"); await f.release("eligible"); await f.release("failed", ancient, "failed");
    f.store.operations.activateProject("site", "active"); f.running.add("running"); const unlock = f.service.reserveRelease("reserved");
    await f.backup("ghost-a", new Date().toISOString(), false); await f.backup("ghost-b", new Date(Date.now() - 1000).toISOString(), false);
    await f.backup("backup-a", new Date(Date.now() - 200 * 86400_000).toISOString()); await f.backup("backup-b", new Date(Date.now() - 300 * 86400_000).toISOString()); const old = await f.backup("backup-old");
    const canonical = new Store(path.join(f.data, "sites/site/site.sqlite")); canonical.close();
    const preview = await f.service.preview("site"); assert.deepEqual(new Set(preview.candidates.map((entry) => entry.id)), new Set(["artifact:eligible", "staging:failed", "backup:backup-old"]));
    assert.equal(preview.policy.automaticCleanup, false);
    const result = await f.service.quarantine("site", ["artifact:eligible", "artifact:active", "artifact:running", "artifact:reserved", "backup:backup-old"]); assert.equal(result.moved, 2); assert.equal(result.skipped.length, 3);
    await assert.rejects(stat(old), /ENOENT/); assert.ok((await stat(path.join(f.data, "sites/site/site.sqlite"))).isFile());
    await assert.rejects(stat(path.join(f.exports, "eligible")), /ENOENT/); assert.throws(() => f.service.assertAvailable("eligible"), /격리/);
    const entry = f.service.list("site").find((entry) => entry.candidate.id === "artifact:eligible")!; await f.service.restore("site", entry.id);
    assert.equal(await readFile(path.join(f.exports, "eligible/source.txt"), "utf8"), "original:eligible"); assert.doesNotThrow(() => f.service.assertAvailable("eligible"));
    assert.ok((await stat(path.join(f.data, "backups/site/backup-a.sqlite"))).isFile()); assert.ok((await stat(path.join(f.data, "backups/site/backup-b.sqlite"))).isFile()); unlock();
  } finally { await f.service.close(); f.store.close(); }
});
test("automatic cleanup defaults off and actually quarantines eligible candidates only when policy enables it", async () => {
  const f = await fixture();
  try {
    await f.release("new-a", new Date().toISOString()); await f.release("new-b", new Date(Date.now() - 1000).toISOString()); await f.release("old");
    await f.service.runAutomatic(); assert.ok((await stat(path.join(f.exports, "old"))).isDirectory());
    f.store.operations.saveRetention("site", { automaticCleanup: true }); f.service.start(20);
    const started = Date.now(); while (!f.service.list("site").some((entry) => entry.status === "quarantined") && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(f.service.list("site").some((entry) => entry.candidate.id === "artifact:old" && entry.status === "quarantined")); await assert.rejects(stat(path.join(f.exports, "old")), /ENOENT/);
    assert.equal(f.store.exportRecord("old")?.status, "ready"); assert.ok((await f.service.preview("site")).bytes > 0);
  } finally { await f.service.close(); f.store.close(); }
});
test("retention rejects sibling paths and junctions, preserves external files and refuses restore overwrite", async () => {
  const f = await fixture();
  try {
    await f.release("new-a", new Date().toISOString()); await f.release("new-b", new Date(Date.now() - 1000).toISOString()); await f.release("old");
    const outside = path.join(f.root, "exports-other"); await mkdir(outside); await writeFile(path.join(outside, "private.txt"), "private");
    f.store.exportStart("outside", "site"); f.store.exportDone("outside", outside); f.store.db.prepare("UPDATE exports SET created_at=? WHERE id='outside'").run(ancient);
    await symlink(outside, path.join(f.exports, "junction"), process.platform === "win32" ? "junction" : "dir"); f.store.exportStart("junction", "site"); f.store.exportDone("junction", path.join(f.exports, "junction")); f.store.db.prepare("UPDATE exports SET created_at=? WHERE id='junction'").run(ancient);
    const preview = await f.service.preview("site"); assert.ok(preview.errors.length >= 2); assert.ok(!preview.candidates.some((entry) => ["outside", "junction"].includes(entry.resourceId)));
    await f.service.quarantine("site", ["artifact:old"]); const entry = f.service.list("site")[0]!; await mkdir(path.join(f.exports, "old")); await writeFile(path.join(f.exports, "old/source.txt"), "replacement");
    await assert.rejects(f.service.restore("site", entry.id), /덮어쓸/); assert.equal(await readFile(path.join(f.exports, "old/source.txt"), "utf8"), "replacement"); assert.equal(await readFile(path.join(outside, "private.txt"), "utf8"), "private");
  } finally { await f.service.close(); f.store.close(); }
});
test("table changes atomically retain previous rows and actor; conflicts create no history and cursors are bounded", () => {
  const store = new Store(":memory:"); const columns = [{ id: "name", label: "Name", type: "text" as const, required: true, unique: true }, { id: "fixed", label: "Fixed", type: "text" as const, readOnly: true }], initial = [{ id: "row", values: ["initial", "fixed"] }];
  try {
    assert.equal(saveTableWithHistory(store.db, "table", columns, initial, [{ id: "row", values: ["one", "fixed"] }], 0, "actor", () => undefined), 1);
    assert.throws(() => saveTableWithHistory(store.db, "table", columns, initial, [{ id: "row", values: ["bad", "changed"] }], 1, "actor", () => undefined), /읽기 전용/);
    assert.throws(() => saveTableWithHistory(store.db, "table", columns, initial, [{ id: "row", values: ["stale", "fixed"] }], 0, "actor", () => undefined), /다른 창/);
    assert.equal(tableHistory(store.db, "table", 2).items.length, 1); assert.equal(store.table("table", [], 2).version, 1);
    saveTableWithHistory(store.db, "table", columns, initial, [{ id: "row", values: ["two", "fixed"] }], 1, "other", () => undefined); saveTableWithHistory(store.db, "table", columns, initial, [{ id: "row", values: ["three", "fixed"] }], 2, "actor", () => undefined);
    const page = tableHistory(store.db, "table", 2, 2); assert.deepEqual(page.items.map((entry) => entry.version), [3, 2]); assert.equal(page.nextCursor, 2); assert.equal(page.items[1]?.previousRows[0]?.values[0], "one"); assert.equal(page.items[1]?.actorId, "other"); assert.deepEqual(tableHistory(store.db, "table", 2, 2, page.nextCursor!).items.map((entry) => entry.version), [1]);
    assert.throws(() => tableHistory(store.db, "table", 2, 1000), /범위/); assert.throws(() => saveTableWithHistory(store.db, "table", columns, initial, [], 3, "actor", () => { throw new Error("replaced"); }), /replaced/); assert.equal(store.table("table", [], 2).version, 3);
  } finally { store.close(); }
});
