import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/store";
import { OperationsService } from "../server/operationsService";
import type { startSiteInWorker } from "../server/workerClient";
import { createBlock, createProject } from "../src/domain/catalog";
import type { ExpansionScope } from "../src/domain/expansion";
import type { Project } from "../src/domain/types";
import { record } from "../src/domain/validation";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "automade-promotion-race-")),
    data = path.join(root, "data"),
    exports = path.join(root, "exports");
  await mkdir(data);
  await mkdir(exports);
  const store = new Store(path.join(data, "studio.sqlite")),
    project = createProject("promotion race");
  project.settings.description = "Concurrent promotion recovery verification";
  project.blocks.push(createBlock("form", project, project.pages[0]!.id));
  store.save(project);
  const now = new Date().toISOString();
  store.db
    .prepare("INSERT INTO expansion_project_scopes VALUES(?,?,?)")
    .run(project.id, "local", "local");
  store.db
    .prepare("INSERT INTO expansion_sites VALUES(?,?,?,?,'site','local',0,'{}',?)")
    .run(project.id, "local", "local", project.id, now);
  const scopes: ExpansionScope[] = [];
  for (const name of ["staging", "production"]) {
    const id = randomUUID(),
      dataKey = randomUUID();
    store.db
      .prepare("INSERT INTO expansion_environments VALUES(?,?,?,?,?,?,?,?,1,?,?)")
      .run(
        id,
        project.id,
        "local",
        "local",
        project.id,
        name,
        name,
        dataKey,
        JSON.stringify({ publicOrigin: `https://${name}.example.invalid` }),
        now,
      );
    scopes.push({
      organizationId: "local",
      workspaceId: "local",
      projectId: project.id,
      siteId: project.id,
      environmentId: id,
      dataKey,
    });
  }
  const operations = new OperationsService(store, process.cwd(), exports, data);
  return { root, data, store, project, scopes, operations };
}

type Launch = (
  directory: string,
  project: Project,
  options: Parameters<typeof startSiteInWorker>[3],
  dataKey: string,
) => ReturnType<typeof startSiteInWorker>;

test("a failed older promotion cannot compensate over a newer successful activation", { timeout: 90_000 }, async () => {
  const f = await fixture(),
    source = f.scopes[0]!,
    target = f.scopes[1]!;
  let resumeA = () => {};
  let promotionA: Promise<unknown> | undefined;
  const original: unknown = Reflect.get(f.operations, "launchSite");
  assert.ok(typeof original === "function");
  try {
    const release = await f.operations.enqueue(f.project, "race-source", source),
      deadline = Date.now() + 60_000;
    while (f.store.operations.job(release)?.status !== "ready" && Date.now() < deadline) {
      const job = f.store.operations.job(release);
      if (job?.status === "failed") throw new Error(job.error);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(f.store.operations.job(release)?.status, "ready");
    (await f.operations.scopeData(target)).submit("form", "before-race", { message: "retain" });

    let enterA = () => {};
    const entered = new Promise<void>((resolve) => { enterA = resolve; }),
      waiting = new Promise<void>((resolve) => { resumeA = resolve; });
    let aId: string | undefined;
    let first = true;
    // Inject only the launch timing/failure; both promotions still probe real
    // workers and activate the actual environment database.
    const intercepted: Launch = async (...args) => {
      if (first) {
        first = false;
        aId = args[2].releaseId;
        enterA();
        await waiting;
        throw new Error("injected older promotion launch failure");
      }
      const result: unknown = Reflect.apply(original, f.operations, args);
      return await (result as ReturnType<Launch>);
    };
    Reflect.set(f.operations, "launchSite", intercepted);
    promotionA = f.operations
      .promoteRelease(release, source, target, 1, "promotion-a", () => {})
      .catch((error: unknown) => error);
    await Promise.race([
      entered,
      promotionA.then((value) => { throw new Error("Promotion A did not reach launch", { cause: value }); }),
    ]);

    const b = await f.operations.promoteRelease(release, source, target, 1, "promotion-b", () => {}),
      bId = String(b.releaseId),
      response = await fetch(String(b.url) + "/health", { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    assert.equal(record(record(await response.json()).data).releaseId, bId);
    (await f.operations.scopeData(target)).submit("form", "after-newer-promotion", { message: "retain newer writes" });

    resumeA();
    const failure = await promotionA;
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /injected older promotion launch failure/);
    assert.ok(aId);
    assert.equal(f.store.operations.state(`environment:release:${target.dataKey}`), bId);
    const site = await f.operations.scopeData(target);
    assert.equal(site.activeRelease(), bId);
    assert.equal(site.submissions().length, 2);
    const persisted = new DatabaseSync(path.join(f.data, "sites", target.dataKey!, "site.sqlite"), { readOnly: true });
    try {
      assert.equal(JSON.parse(String(persisted.prepare("SELECT value FROM runtime_state WHERE key='activeRelease'").get()?.value)), bId);
    } finally {
      persisted.close();
    }
    assert.equal(f.store.db.prepare("SELECT status FROM system_release_activations WHERE id=?").get(aId)?.status, "failed");
    assert.equal(f.store.db.prepare("SELECT status FROM system_release_activations WHERE id=?").get(bId)?.status, "ready");
    assert.equal(f.store.operations.job(aId)?.status, "failed");
    assert.equal(f.store.operations.job(bId)?.status, "ready");
    const current = f.operations.sites.get(bId);
    assert.ok(current);
    assert.equal(current.origin, b.url, "The newer successful site keeps its returned URL");
    const health = await fetch(current.origin + "/health", { signal: AbortSignal.timeout(5_000) });
    assert.equal(health.status, 200);
    assert.equal(record(record(await health.json()).data).releaseId, bId);
  } finally {
    resumeA();
    await promotionA;
    Reflect.set(f.operations, "launchSite", original);
    await f.operations.close();
    f.store.close();
    assert.ok(path.resolve(f.root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(f.root, { recursive: true, force: true });
  }
});
