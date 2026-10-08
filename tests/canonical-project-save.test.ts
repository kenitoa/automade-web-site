import test from "node:test";
import assert from "node:assert/strict";
import { Store, ConflictError } from "../server/store";
import {
  IndexedContentService,
  hydrateContentProject,
  reconcileContentWrite,
} from "../server/advancement/content";
import { createProject } from "../src/domain/catalog";
import { commit } from "../src/domain/commands";
import { parseProject } from "../src/domain/validation";
import type { ContentContext } from "../src/domain/contentContracts";

function fixture(withContent = true) {
  const store = new Store(":memory:"),
    project = createProject("canonical save");
  project.extensions = { recentBlocks: ["text"] };
  if (withContent)
    project.collections = [{
      id: "news",
      name: "News",
      path: "/news",
      records: [{
        id: "one",
        slug: "one",
        title: "Original",
        body: "Original draft",
        category: "",
        imageId: "",
        fields: {},
        status: "draft",
        publishedAt: "",
        contentRevision: 0,
        workflow: { state: "draft" },
      }],
    }];
  const ctx: ContentContext = {
    scope: { organizationId: "org", workspaceId: "work", projectId: project.id },
    actorId: "author",
    authorize: () => {},
  };
  store.projectHydrator = (value) => hydrateContentProject(store.db, value);
  store.beforeProjectWrite = (previous, incoming) =>
    reconcileContentWrite(store.db, previous, incoming, ctx);
  store.save(project);
  const content = new IndexedContentService(store.db, (id) => store.rawProject(id));
  return { store, project, content, ctx };
}

test("equivalent same-revision editor saves tolerate canonical empty collections and object key order", () => {
  const { store, project } = fixture(false);
  try {
    const incoming = parseProject(project);
    assert.equal(incoming.collections, undefined);
    assert.deepEqual(store.project(project.id)?.collections, []);
    assert.doesNotThrow(() => store.save(incoming, project.revision));
    assert.equal(store.project(project.id)?.revision, project.revision);
    assert.deepEqual(store.project(project.id)?.extensions?.recentBlocks, ["text"]);
    assert.equal(store.backups(project.id).length, 0);
  } finally {
    store.close();
  }
});

test("a hydrated same-revision save preserves independent CMS changes and raw document backups", () => {
  const { store, project, content, ctx } = fixture();
  try {
    const before = content.get(project.id, "news", "one", { manage: true, member: true });
    content.upsert(ctx, "news", "one", {
      record: { ...before.record, body: "Independent CMS edit" },
      expectedRevision: before.recordRevision,
      commandId: "independent-edit",
    });
    assert.equal(store.rawProject(project.id)?.collections?.[0]?.records[0]?.body, "Original draft");
    const hydrated = store.project(project.id)!;
    assert.equal(hydrated.revision, project.revision);
    assert.equal(hydrated.collections?.[0]?.records[0]?.body, "Independent CMS edit");
    assert.doesNotThrow(() => store.save(hydrated, project.revision));
    const rawBeforeDesignSave = store.rawProject(project.id)!;
    const changed = commit(hydrated, (value) => { value.name = "New design revision"; });
    store.save(changed, project.revision);
    assert.deepEqual(store.backups(project.id)[0], rawBeforeDesignSave);
    assert.equal(store.project(project.id)?.collections?.[0]?.records[0]?.body, "Independent CMS edit");
    assert.throws(() => store.save(hydrated, project.revision), ConflictError);
  } finally {
    store.close();
  }
});

test("same-revision content changes are rejected using the pre-write canonical view and rollback CMS mutations", () => {
  const { store, project, content } = fixture();
  try {
    const canonical = store.project(project.id)!,
      before = content.get(project.id, "news", "one", { manage: true, member: true }),
      receipts = store.db.prepare("SELECT COUNT(*) AS n FROM advancement_content_receipts").get()?.n,
      candidate = structuredClone(canonical);
    candidate.collections![0]!.records[0]!.body = "Changed without a new document revision";
    assert.throws(() => store.save(candidate, project.revision), ConflictError);
    const after = content.get(project.id, "news", "one", { manage: true, member: true });
    assert.equal(after.record.body, before.record.body);
    assert.equal(after.recordRevision, before.recordRevision);
    assert.deepEqual(store.project(project.id), canonical);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM advancement_content_receipts").get()?.n, receipts);
    assert.equal(store.backups(project.id).length, 0);
    assert.throws(() => store.save({ ...canonical, name: "Changed without revision" }, project.revision), ConflictError);
  } finally {
    store.close();
  }
});
