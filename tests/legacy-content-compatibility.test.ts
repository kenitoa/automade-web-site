import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/store";
import { ExpansionService } from "../server/expansion/service";
import {
  hydrateContentProject,
  reconcileContentWrite,
} from "../server/advancement/content";
import { enqueueSystemEvent } from "../server/systemDelivery";
import { createProject } from "../src/domain/catalog";
import type { CreatorIdentity, ExpansionScope } from "../src/domain/expansion";
import { parseProject } from "../src/domain/validation";

test("managed legacy review routes and a separate worker Store publish canonical content without losing the scoped outbox", async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), "automade-legacy-content-"),
    ),
    file = path.join(directory, "studio.sqlite"),
    store = new Store(file),
    jobs: string[] = [];
  let workerStore: Store | undefined;
  const options = {
    mode: "managed" as const,
    dataRoot: directory,
    siteData: async (): Promise<Store> => {
      throw new Error(
        "Canonical publication must use its transactional outbox",
      );
    },
    enqueueJob: async (
      _kind: string,
      _scope: ExpansionScope,
      _payload: unknown,
      key: string,
    ) => {
      jobs.push(key);
      return { id: key, status: "waiting" };
    },
  };
  const expansion = new ExpansionService(store, options);
  try {
    const owner = await expansion.auth.create({
        email: "legacy-owner@example.org",
        password: "legacy-owner-password-2026",
        displayName: "Owner",
      }),
      reviewer = await expansion.auth.create({
        email: "legacy-reviewer@example.org",
        password: "legacy-reviewer-password-2026",
        displayName: "Reviewer",
      }),
      identity: CreatorIdentity = { id: owner.id, csrf: "", sessionId: "" },
      reviewIdentity: CreatorIdentity = {
        id: reviewer.id,
        csrf: "",
        sessionId: "",
      },
      organization = expansion.organizations.createOrganization(
        identity,
        false,
        { name: "Legacy organization" },
      ),
      workspace = expansion.organizations.createWorkspace(identity, false, {
        organizationId: organization.id,
        name: "Legacy workspace",
      }),
      project = parseProject({
        ...createProject("Legacy CMS"),
        collections: [
          {
            id: "news",
            name: "News",
            path: "/news",
            records: [
              {
                id: "one",
                slug: "one",
                title: "Approved content",
                body: "Stored content",
                category: "",
                imageId: "",
                fields: {},
                status: "draft",
                publishedAt: "",
                contentRevision: 0,
                workflow: { state: "draft" },
              },
            ],
          },
        ],
      });
    store.save(project, -1);
    const scope = expansion.registerProject(project, workspace.id, identity),
      invitation = expansion.organizations.invite(identity, false, {
        organizationId: organization.id,
        workspaceId: workspace.id,
        email: reviewer.email,
        role: "member",
        capabilities: ["project.read", "review.approve"],
      });
    expansion.organizations.accept(reviewIdentity, invitation.token);
    let actor = owner.id;
    store.projectHydrator = (raw) => hydrateContentProject(store.db, raw);
    store.beforeProjectWrite = (previous, incoming) =>
      reconcileContentWrite(store.db, previous, incoming, {
        scope,
        actorId: actor,
        authorize: (capability) => {
          expansion.authorizeJob(scope, actor, capability);
        },
        assertApprover: (approver) => {
          expansion.authorizeJob(scope, approver, "review.approve");
        },
        emit: (event) => {
          enqueueSystemEvent(store.db, event);
        },
      });
    let result = expansion.reviews.content(scope, actor, {
      collectionId: "news",
      recordId: "one",
      state: "review",
      baseRevision: 0,
    });
    assert.equal(
      store.project(project.id)!.collections![0]!.records[0]!.workflow?.state,
      "review",
    );
    actor = reviewer.id;
    result = expansion.reviews.content(scope, actor, {
      collectionId: "news",
      recordId: "one",
      state: "approved",
      baseRevision: result.project.revision,
    });
    actor = owner.id;
    const publishAt = new Date(Date.now() + 150).toISOString();
    result = expansion.reviews.content(scope, actor, {
      collectionId: "news",
      recordId: "one",
      state: "scheduled",
      baseRevision: result.project.revision,
      publishAt,
    });
    assert.equal(
      store.project(project.id)!.collections![0]!.records[0]!.workflow?.state,
      "scheduled",
    );
    await expansion.syncCms(scope, result.project);
    await new Promise((resolve) => setTimeout(resolve, 170));
    workerStore = new Store(file);
    const workerExpansion = new ExpansionService(workerStore, options),
      payload = {
        collectionId: "news",
        recordId: "one",
        contentRevision: 0,
        publishAt,
      };
    await workerExpansion.executeJob(
      "content.publish",
      scope,
      payload,
      owner.id,
    );
    await workerExpansion.executeJob(
      "content.publish",
      scope,
      payload,
      owner.id,
    );
    assert.equal(
      store.project(project.id)!.collections![0]!.records[0]!.workflow?.state,
      "published",
    );
    const events = store.db.prepare("SELECT * FROM system_event_outbox").all();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.actor_id, owner.id);
    assert.equal(events[0]!.organization_id, scope.organizationId);
    assert.equal(events[0]!.data_key, scope.dataKey);
    assert.equal(
      jobs[0],
      jobs[1],
      "Repeated scheduling retains the same generation idempotency key",
    );
    assert.equal(
      store.project(project.id)!.collections![0]!.records[0]!.contentRevision,
      0,
    );
  } finally {
    workerStore?.close();
    store.close();
    assert.ok(
      path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
