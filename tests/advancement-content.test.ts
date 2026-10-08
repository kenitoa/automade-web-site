import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createProject } from "../src/domain/catalog";
import type { ContentRecord } from "../src/domain/types";
import type { ContentContext } from "../src/domain/contentContracts";
import {
  IndexedContentService,
  hydrateContentProject,
  reconcileContentWrite,
  applyRuntimeContentSnapshot,
} from "../server/advancement/content";
import { publicProject } from "../src/domain/publication";
import { resolveWallTime } from "../src/domain/timezones";
import { transitionContent, queryCollection } from "../src/domain/cms";
import { sitemapPage } from "../src/domain/sitemaps";
import type { ContentContext as ScopedContentContext } from "../src/domain/contentContracts";
const item = (
  id: string,
  status: "draft" | "published" = "draft",
): ContentRecord => ({
  id,
  slug: id,
  title: id,
  body: `body ${id}`,
  category: "",
  imageId: "",
  fields: {},
  status,
  publishedAt: status === "published" ? "2026-01-01T00:00:00Z" : "",
  contentRevision: 0,
});
function fixture(
  records = [item("alpha", "published"), item("beta")],
  database?: DatabaseSync,
) {
  const project = createProject("service"),
    db = database ?? new DatabaseSync(":memory:");
  project.collections = [
    {
      id: "news",
      name: "News",
      path: "/news",
      records,
      schema: [
        { id: "secret", label: "Secret", type: "text", public: false },
        { id: "rank", label: "Rank", type: "number", public: true },
      ],
    },
  ];
  const service = new IndexedContentService(db, () => project),
    ctx = (actorId: string): ContentContext => ({
      scope: { organizationId: "o", workspaceId: "w", projectId: project.id },
      actorId,
      authorize: () => {},
    });
  service.ensureLegacy(project);
  return { project, db, service, ctx };
}
test("record CAS is independent and edits preserve the immutable public body", () => {
  const { project, db, service, ctx } = fixture();
  try {
    const before = service.get(project.id, "news", "alpha", {
      manage: true,
      member: true,
    });
    const changed = service.upsert(ctx("author"), "news", "alpha", {
      record: { ...before.record, title: "Private draft" },
      expectedRevision: 0,
      commandId: "edit_1",
    });
    assert.equal(changed.recordRevision, 1);
    assert.equal(changed.record.publication?.record.title, "alpha");
    assert.equal(
      service.get(project.id, "news", "beta", { manage: true, member: true })
        .recordRevision,
      0,
    );
    assert.equal(
      publicProject(service.snapshot(project)).collections![0]!.records[0]!
        .title,
      "alpha",
    );
    assert.throws(
      () =>
        service.upsert(ctx("author"), "news", "alpha", {
          record: before.record,
          expectedRevision: 0,
          commandId: "stale",
        }),
      /변경/,
    );
    assert.deepEqual(
      service.upsert(ctx("author"), "news", "alpha", {
        record: { ...before.record, title: "Private draft" },
        expectedRevision: 0,
        commandId: "edit_1",
      }),
      changed,
    );
  } finally {
    db.close();
  }
});
test("review, publication, delivery emission and receipts share one rollback boundary", () => {
  const { project, db, service, ctx } = fixture();
  try {
    service.transition(ctx("author"), "news", "beta", {
      state: "review",
      expectedRevision: 0,
      commandId: "review",
    });
    assert.throws(
      () =>
        service.transition(ctx("author"), "news", "beta", {
          state: "approved",
          expectedRevision: 0,
          commandId: "self",
        }),
      /다른/,
    );
    service.transition(ctx("reviewer"), "news", "beta", {
      state: "approved",
      expectedRevision: 0,
      commandId: "approve",
    });
    assert.throws(
      () =>
        service.transition(
          {
            ...ctx("publisher"),
            emit: () => {
              throw new Error("outbox unavailable");
            },
          },
          "news",
          "beta",
          { state: "published", expectedRevision: 0, commandId: "publish" },
        ),
      /outbox/,
    );
    assert.equal(
      service.get(project.id, "news", "beta", { manage: true, member: true })
        .publishedRevision,
      null,
    );
    const events: unknown[] = [];
    service.transition(
      { ...ctx("publisher"), emit: (event) => events.push(event) },
      "news",
      "beta",
      { state: "published", expectedRevision: 0, commandId: "publish" },
    );
    assert.equal(events.length, 1);
    assert.equal(
      db.prepare("SELECT count(*) n FROM advancement_content_events").get()!.n,
      1,
    );
    assert.equal(
      service.get(project.id, "news", "beta", { member: false }).record.title,
      "beta",
    );
  } finally {
    db.close();
  }
});
test("SQL keyset pages filter private fields before limit and detect stale cursors", () => {
  const records = Array.from({ length: 47 }, (_, i) => ({
    ...item(`r${String(i).padStart(2, "0")}`, "published"),
    title: "same",
    values: { rank: i, secret: i === 5 ? "hidden needle" : "" },
  }));
  const { project, db, service, ctx } = fixture(records);
  try {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = service.query(
        project.id,
        "news",
        new URLSearchParams({
          limit: "7",
          sort: "-rank",
          ...(cursor ? { cursor } : {}),
        }),
        { member: false },
      );
      seen.push(...page.records.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(new Set(seen).size, 47);
    assert.equal(seen[0], "r46");
    assert.equal(
      service.query(
        project.id,
        "news",
        new URLSearchParams({ q: "hidden needle" }),
        { member: false },
      ).total,
      0,
    );
    const page = service.query(
      project.id,
      "news",
      new URLSearchParams({ limit: "7" }),
      { member: false },
    );
    service.transition(ctx("publisher"), "news", "r01", {
      state: "unpublish",
      expectedRevision: 0,
      commandId: "remove_pub",
    });
    assert.throws(
      () =>
        service.query(
          project.id,
          "news",
          new URLSearchParams({ limit: "7", cursor: page.nextCursor! }),
          { member: false },
        ),
      /변경/,
    );
  } finally {
    db.close();
  }
});
test("legacy design saves preserve concurrent canonical edits and reject conflicting record changes", () => {
  const { project, db, service, ctx } = fixture();
  try {
    service.upsert(ctx("other"), "news", "beta", {
      record: { ...item("beta"), title: "canonical newer" },
      expectedRevision: 0,
      commandId: "other_edit",
    });
    const incoming = structuredClone(project);
    incoming.revision++;
    incoming.name = "Changed design";
    const reconciled = reconcileContentWrite(db, project, incoming);
    assert.equal(
      reconciled.collections![0]!.records.find((r) => r.id === "beta")!.title,
      "canonical newer",
    );
    assert.equal(
      hydrateContentProject(db, project).collections![0]!.records.find(
        (r) => r.id === "beta",
      )!.contentRevision,
      1,
    );
    incoming.collections![0]!.records.find((r) => r.id === "beta")!.title =
      "stale local";
    assert.throws(
      () => reconcileContentWrite(db, project, incoming),
      /別|별도/,
    );
  } finally {
    db.close();
  }
});
test("legacy workflow saves preserve canonical states and publish with the real scoped actor in the same transaction", () => {
  const { project, db, service, ctx } = fixture();
  db.exec("CREATE TABLE test_content_outbox(body TEXT NOT NULL)");
  const incomingFor = (state: Parameters<typeof transitionContent>[1]) => {
    const incoming = service.snapshot(project);
    incoming.revision++;
    incoming.collections![0]!.records = incoming.collections![0]!.records.map(
      (record) =>
        record.id === "beta" ? transitionContent(record, state) : record,
    );
    return incoming;
  };
  const context = (actor: string): ScopedContentContext => ({
    ...ctx(actor),
    scope: {
      organizationId: "actual-organization",
      workspaceId: "actual-workspace",
      projectId: project.id,
      environmentId: "actual-environment",
      dataKey: "actual-data-key",
    },
    assertApprover: (approver) => assert.equal(approver, "reviewer"),
    emit: (event) => {
      db.prepare("INSERT INTO test_content_outbox VALUES(?)").run(
        JSON.stringify(event),
      );
    },
  });
  try {
    assert.throws(
      () => reconcileContentWrite(db, project, incomingFor("review")),
      /실제 실행자/,
    );
    Object.assign(
      project,
      reconcileContentWrite(
        db,
        project,
        incomingFor("review"),
        context("author"),
      ),
    );
    assert.equal(
      service.get(project.id, "news", "beta", { manage: true, member: true })
        .record.workflow?.state,
      "review",
    );
    assert.throws(
      () =>
        reconcileContentWrite(
          db,
          project,
          incomingFor("approved"),
          context("author"),
        ),
      /다른 검토자/,
    );
    Object.assign(
      project,
      reconcileContentWrite(
        db,
        project,
        incomingFor("approved"),
        context("reviewer"),
      ),
    );
    assert.equal(
      service.get(project.id, "news", "beta", { manage: true, member: true })
        .recordRevision,
      0,
      "Workflow changes do not create a content edit revision",
    );
    assert.throws(
      () =>
        reconcileContentWrite(db, project, incomingFor("published"), {
          ...context("publisher"),
          emit: () => {
            throw new Error("outbox unavailable");
          },
        }),
      /outbox unavailable/,
    );
    assert.equal(
      service.get(project.id, "news", "beta", { manage: true, member: true })
        .record.workflow?.state,
      "approved",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM advancement_content_events").get()!
        .n,
      0,
    );
    Object.assign(
      project,
      reconcileContentWrite(
        db,
        project,
        incomingFor("published"),
        context("publisher"),
      ),
    );
    assert.equal(
      service.get(project.id, "news", "beta", { member: false }).record.status,
      "published",
    );
    const event = JSON.parse(
      String(db.prepare("SELECT body FROM test_content_outbox").get()!.body),
    ) as { actorId: string; scope: ScopedContentContext["scope"] };
    assert.equal(event.actorId, "publisher");
    assert.deepEqual(event.scope, context("publisher").scope);
  } finally {
    db.close();
  }
});
test("legacy import adopts only stored separate-reviewer approvals with an exact content fingerprint", () => {
  const project = createProject("Existing approved CMS"),
    db = new DatabaseSync(":memory:"),
    publishAt = new Date(Date.now() - 1000).toISOString();
  project.collections = [
    {
      id: "news",
      name: "News",
      path: "/news",
      records: ["valid", "tampered"].map((id) => ({
        ...item(id),
        workflow: { state: "scheduled", approvedRevision: 0, publishAt },
      })),
    },
  ];
  db.exec(
    "CREATE TABLE expansion_content_authors(project_id TEXT,collection_id TEXT,record_id TEXT,content_revision INTEGER,submitted_by TEXT,approved_by TEXT); CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value TEXT)",
  );
  for (const record of project.collections[0]!.records) {
    const {
      workflow: _workflow,
      status: _status,
      contentRevision: _revision,
      publishedAt: _publishedAt,
      ...content
    } = record;
    db.prepare("INSERT INTO expansion_content_authors VALUES(?,?,?,?,?,?)").run(
      project.id,
      "news",
      record.id,
      0,
      "original-author",
      "original-reviewer",
    );
    db.prepare("INSERT INTO runtime_state VALUES(?,?)").run(
      `cms:approval:${project.id}:news:${record.id}:0`,
      JSON.stringify({
        actorId: "original-reviewer",
        fingerprint:
          record.id === "valid"
            ? createHash("sha256").update(JSON.stringify(content)).digest("hex")
            : "changed-proof",
      }),
    );
  }
  const service = new IndexedContentService(db, () => project),
    context: ContentContext = {
      scope: {
        organizationId: "actual-org",
        workspaceId: "actual-workspace",
        projectId: project.id,
      },
      actorId: "actual-publisher",
      authorize: () => {},
      assertApprover: (actor) => assert.equal(actor, "original-reviewer"),
    };
  try {
    service.ensureLegacy(project);
    const pending = service.snapshot(project);
    pending.settings.siteUrl = "https://pending.example.org";
    assert.equal(publicProject(pending).collections![0]!.records.length, 0);
    assert.equal(
      queryCollection(pending, "news", {}, { member: false }).records.length,
      0,
    );
    assert.doesNotMatch(sitemapPage(pending, 1), /news\/(?:valid|tampered)/);
    assert.throws(
      () =>
        service.transition(context, "news", "tampered", {
          state: "published",
          expectedRevision: 0,
          commandId: "reject_tampered_approval",
        }),
      /검토 승인/,
    );
    assert.equal(
      service.transition(context, "news", "valid", {
        state: "published",
        expectedRevision: 0,
        commandId: "publish_stored_approval",
      }).record.status,
      "published",
    );
  } finally {
    db.close();
  }
});
test("durable model batches quarantine invalid values and preserve prior publications", () => {
  const { project, db, service, ctx } = fixture();
  try {
    const plan = service.schemaPreview(ctx("author"), "news", {
      schema: [
        {
          id: "rank",
          label: "Required rank",
          type: "number",
          required: true,
          public: true,
        },
      ],
    });
    assert.equal(plan.preview?.records, 2);
    assert.equal(plan.preview?.invalidRecords, 2);
    assert.ok(Number.isSafeInteger(plan.sourceCollectionRevision));
    let result = service.schemaRun(ctx("author"), plan.id, { limit: 1 });
    assert.equal(result.state, "running");
    result = service.schemaRun(ctx("author"), plan.id, { limit: 1 });
    result = service.schemaRun(ctx("author"), plan.id, { limit: 1 });
    assert.equal(result.state, "blocked");
    assert.equal(result.errors.length, 2);
    assert.equal(
      service.get(project.id, "news", "alpha", { member: false }).record.title,
      "alpha",
    );
    assert.equal(service.snapshot(project).collections![0]!.schemaRevision, 0);
  } finally {
    db.close();
  }
});
test("model plans reject stale content and legacy deletion cannot silently unpublish records", () => {
  const { project, db, service, ctx } = fixture();
  try {
    const plan = service.schemaPreview(ctx("author"), "news", {
      schema: project.collections![0]!.schema,
    });
    const draft = service.get(project.id, "news", "beta", {
      manage: true,
      member: true,
    });
    service.upsert(ctx("author"), "news", "beta", {
      record: { ...draft.record, title: "Changed after preview" },
      expectedRevision: 0,
      commandId: "changed_after_preview",
    });
    assert.throws(() => service.schemaRun(ctx("author"), plan.id), /다시 검토/);
    const deleted = structuredClone(project);
    deleted.revision++;
    deleted.collections![0]!.records = deleted.collections![0]!.records.filter(
      (item) => item.id !== "alpha",
    );
    assert.throws(
      () => reconcileContentWrite(db, project, deleted),
      /발행 취소/,
    );
    assert.equal(
      service.get(project.id, "news", "alpha", { member: false }).record.title,
      "alpha",
    );
  } finally {
    db.close();
  }
});
test("raw project saves cannot forge schemaRevision to bypass a durable model migration", () => {
  const { project, db, service, ctx } = fixture();
  try {
    const changed = structuredClone(project);
    changed.revision++;
    changed.collections![0]!.schemaRevision = 1;
    changed.collections![0]!.schema![0]!.public = true;
    assert.throws(
      () => reconcileContentWrite(db, project, changed, ctx("author")),
      /스키마 검토/,
    );
    const versionOnly = structuredClone(project);
    versionOnly.revision++;
    versionOnly.collections![0]!.schemaRevision = 1;
    assert.throws(
      () => reconcileContentWrite(db, project, versionOnly, ctx("author")),
      /스키마 검토/,
    );
    assert.equal(service.snapshot(project).collections![0]!.schemaRevision, 0);
    const plan = service.schemaPreview(ctx("author"), "news", {
      schema: changed.collections![0]!.schema,
    });
    assert.equal(
      service.schemaRun(ctx("author"), plan.id, { limit: 100 }).state,
      "complete",
    );
    const migrated = service.snapshot(project);
    migrated.revision++;
    assert.equal(
      reconcileContentWrite(db, project, migrated, ctx("author"))
        .collections![0]!.schemaRevision,
      1,
      "Already migrated canonical schemas remain compatible with project saves",
    );
  } finally {
    db.close();
  }
});
test("draft schema visibility changes cannot leak an asset referenced only by a private frozen publication field", () => {
  const project = createProject("Private image"),
    published = {
      ...item("one", "published"),
      values: { privateImage: "private-image" },
    };
  project.assets = [
    {
      id: "private-image",
      name: "Private image",
      alt: "Private image",
      mime: "image/png",
      data: "",
      blobRef: {
        id: "private-blob",
        sha256: "a".repeat(64),
        projectId: project.id,
      },
    },
  ];
  project.collections = [
    {
      id: "news",
      name: "News",
      path: "/news",
      schema: [
        { id: "privateImage", label: "Image", type: "image", public: true },
      ],
      records: [
        {
          ...published,
          publication: {
            revision: 0,
            sequence: 1,
            publishedAt: published.publishedAt,
            schemaRevision: 0,
            schema: [
              {
                id: "privateImage",
                label: "Image",
                type: "image",
                public: false,
              },
            ],
            record: published,
          },
        },
      ],
    },
  ];
  const result = publicProject(project);
  assert.equal(
    result.collections![0]!.records[0]!.values?.privateImage,
    undefined,
  );
  assert.deepEqual(result.assets, []);
  assert.equal(
    queryCollection(project, "news", {}, { member: false }).records[0]!
      .values?.privateImage,
    undefined,
  );
});
test("model candidates resume after reopening SQLite without exposing previously private published values", async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), "automade-content-resume-"),
    ),
    file = path.join(directory, "content.sqlite"),
    first = new DatabaseSync(file),
    { project, service, ctx } = fixture(
      [
        { ...item("alpha", "published"), values: { secret: "private needle" } },
        item("beta"),
      ],
      first,
    );
  let reopened: DatabaseSync | undefined;
  try {
    const plan = service.schemaPreview(ctx("author"), "news", {
      schema: project.collections![0]!.schema!.map((field) => ({
        ...field,
        public: true,
      })),
    });
    assert.equal(plan.preview?.invalidRecords, 0);
    const partial = service.schemaRun(ctx("author"), plan.id, { limit: 1 });
    assert.equal(partial.processed, 1);
    assert.equal(partial.state, "running");
    first.close();
    reopened = new DatabaseSync(file);
    const resumed = new IndexedContentService(reopened, () => project);
    resumed.ensureLegacy(project);
    let result = resumed.schemaRun(ctx("author"), plan.id, { limit: 1 });
    result = resumed.schemaRun(ctx("author"), plan.id, { limit: 1 });
    assert.equal(result.state, "complete");
    assert.equal(result.processed, 2);
    assert.equal(
      resumed.get(project.id, "news", "alpha", { manage: true, member: true })
        .record.values?.secret,
      "private needle",
    );
    assert.equal(
      resumed.get(project.id, "news", "alpha", { member: false }).record.values
        ?.secret,
      undefined,
    );
    assert.equal(
      resumed.query(
        project.id,
        "news",
        new URLSearchParams({ q: "private needle" }),
        { member: false },
      ).records.length,
      0,
    );
    const published = publicProject(resumed.snapshot(project));
    assert.equal(
      published.collections![0]!.records[0]!.values?.secret,
      undefined,
    );
    assert.equal(
      queryCollection(
        resumed.snapshot(project),
        "news",
        { q: "private needle" },
        { member: false },
      ).records.length,
      0,
    );
  } finally {
    if (first.isOpen) first.close();
    reopened?.close();
    assert.ok(
      path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
test("accepted runtime snapshots use the indexed published view and discard drafts", () => {
  const { project, db, service } = fixture();
  try {
    applyRuntimeContentSnapshot(db, project, {
      revision: 7,
      collections: [
        {
          ...project.collections![0]!,
          records: [item("gamma", "published"), item("secret-draft")],
        },
      ],
    });
    assert.deepEqual(
      service
        .query(project.id, "news", new URLSearchParams(), { member: false })
        .records.map((r) => r.id),
      ["gamma"],
    );
  } finally {
    db.close();
  }
});
test("IANA wall times reject DST gaps and folds unless explicitly resolved", () => {
  const input = {
    date: "2026-11-01",
    time: "01:30",
    timeZone: "America/New_York",
  };
  assert.throws(() => resolveWallTime(input), /두 번/);
  assert.equal(
    resolveWallTime({ ...input, disambiguation: "earlier" }).startsAt,
    "2026-11-01T05:30:00.000Z",
  );
  assert.equal(
    resolveWallTime({ ...input, disambiguation: "later" }).startsAt,
    "2026-11-01T06:30:00.000Z",
  );
  assert.throws(
    () => resolveWallTime({ ...input, date: "2026-03-08", time: "02:30" }),
    /존재하지/,
  );
  const gap = resolveWallTime({
    ...input,
    date: "2026-03-08",
    time: "02:30",
    gapPolicy: "shift-forward",
  });
  assert.equal(gap.startsAt, "2026-03-08T07:30:00.000Z");
  assert.equal(gap.shifted, true);
  assert.equal(
    resolveWallTime({
      date: "2026-10-04",
      time: "02:15",
      timeZone: "Australia/Lord_Howe",
      gapPolicy: "shift-forward",
    }).startsAt,
    "2026-10-03T15:45:00.000Z",
  );
});
