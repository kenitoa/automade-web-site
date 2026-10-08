import { test } from "node:test";
import assert from "node:assert/strict";
import { createProject, createBlock } from "../src/domain/catalog";
import { projectChanges } from "../src/infrastructure/projectJournal";
import {
  readStudioContext,
  studioContextSearch,
  contextStorageKey,
} from "../src/infrastructure/studioContext";
import { mergeProjects } from "../src/infrastructure/projectMerge";
import { stepUpScope } from "../src/infrastructure/stepUpContext";
import type {
  ExpansionBootstrap,
  ExpansionEnvironment,
} from "../src/domain/expansion";
test("journal sends a stable block field rather than the whole document", () => {
  const base = createProject("명령"),
    block = createBlock("text", base, base.pages[0]!.id);
  base.blocks.push(block);
  const next = structuredClone(base);
  next.blocks[0]!.props.title = "새 제목";
  next.revision += 10;
  next.updatedAt = new Date().toISOString();
  assert.deepEqual(projectChanges(base, next), [
    {
      path: `/blocks/@${block.id}/props/title`,
      before: block.props.title,
      after: "새 제목",
    },
  ]);
});
test("optional field removal survives JSON transport and structural insertion remains atomic", () => {
  const base = createProject("제거"),
    block = createBlock("image", base, base.pages[0]!.id);
  block.props.imageSettings = {
    decorative: false,
    fit: "cover",
    ratio: 1,
    focalX: 50,
    focalY: 50,
  };
  base.blocks.push(block);
  const next = structuredClone(base);
  delete next.blocks[0]!.props.imageSettings;
  const changes = projectChanges(base, next),
    transport = JSON.parse(JSON.stringify(changes));
  assert.deepEqual(changes, transport);
  assert.equal(changes[0]!.path, `/blocks/@${block.id}/props`);
  assert.equal(
    Object.hasOwn(changes[0]!.after as object, "imageSettings"),
    false,
  );
  next.blocks.push(createBlock("text", next, next.pages[0]!.id));
  assert.equal(projectChanges(base, next)[0]!.path, "/blocks");
});
test("context roundtrip keeps the full editing scope without token or arbitrary panel parameters", () => {
  const context = {
    projectId: "project-1",
    environmentId: "staging-1",
    pageId: "page-1",
    blockId: "block-1",
    panel: "layers",
    inspectorOpen: true,
    search: "제목·이미지",
    filter: "favorites",
  };
  assert.deepEqual(readStudioContext(studioContextSearch(context)), context);
  assert.equal(readStudioContext("?studioProject=../../other"), null);
  assert.equal(
    readStudioContext("?studioProject=valid&studioPanel=admin")!.panel,
    "blocks",
  );
  assert.notEqual(
    contextStorageKey("creator-a"),
    contextStorageKey("creator-b"),
  );
});
test("step-up binds old organization actions without accidentally granting the current site scope", () => {
  const context = {
    projectId: "current-project",
    environmentId: "stage-current",
    workspaceId: "workspace",
  };
  assert.deepEqual(
    stepUpScope(
      {
        path: "/api/expansion/invites?projectId=current-project&environmentId=stage-current",
        method: "POST",
        payload: { organizationId: "other-org" },
      },
      "http://127.0.0.1:5173",
      context,
      null,
    ),
    {},
  );
  assert.deepEqual(
    stepUpScope(
      {
        path: "/api/advancement/flags/ai?projectId=explicit-project&environmentId=production-other",
        method: "PUT",
        payload: {},
      },
      "http://127.0.0.1:5173",
      context,
      null,
    ),
    { projectId: "explicit-project", environmentId: "production-other" },
  );
});
test("step-up resolves the actual target environment and the source production environment", () => {
  const environment = (
    id: string,
    projectId: string,
    kind: ExpansionEnvironment["kind"],
  ): ExpansionEnvironment => ({
    id,
    projectId,
    kind,
    siteId: "site",
    organizationId: "org",
    workspaceId: "workspace",
    name: id,
    dataKey: id,
    configVersion: 1,
    config: {},
    updatedAt: new Date().toISOString(),
  });
  const bootstrap: ExpansionBootstrap = {
    session: { account: null, localOwner: false, csrf: "" },
    organizations: [],
    workspaces: [],
    sites: [
      {
        id: "site",
        projectId: "source",
        organizationId: "org",
        workspaceId: "workspace",
        name: "source",
        mode: "managed",
        archived: false,
        config: {},
        updatedAt: new Date().toISOString(),
      },
    ],
    environments: [
      environment("source-production", "source", "production"),
      environment("source-staging", "source", "staging"),
    ],
    capabilities: [],
    currentScope: null,
  };
  const origin = "http://127.0.0.1:5173",
    context = {
      projectId: "unrelated",
      environmentId: "unrelated-env",
      workspaceId: "workspace",
    };
  assert.deepEqual(
    stepUpScope(
      {
        path: "/api/expansion/environments/source-staging",
        method: "PUT",
        payload: {},
      },
      origin,
      context,
      bootstrap,
    ),
    { projectId: "source", environmentId: "source-staging" },
  );
  assert.deepEqual(
    stepUpScope(
      {
        path: "/api/expansion/environments",
        method: "POST",
        payload: { siteId: "site" },
      },
      origin,
      context,
      bootstrap,
    ),
    { projectId: "source", environmentId: "source-production" },
  );
  assert.throws(
    () =>
      stepUpScope(
        {
          path: "/api/expansion/environments/removed",
          method: "PUT",
          payload: {},
        },
        origin,
        context,
        bootstrap,
      ),
    /현재 권한/,
  );
  assert.throws(
    () =>
      stepUpScope(
        {
          path: "/api/expansion/sites",
          method: "POST",
          payload: { projectId: "missing" },
        },
        origin,
        context,
        bootstrap,
      ),
    /운영 환경/,
  );
});
test("semantic merge stops deletion that breaks another author's new reference", () => {
  const base = createProject("참조"),
    text = createBlock("text", base, base.pages[0]!.id);
  base.blocks.push(text);
  const local = structuredClone(base);
  local.blocks = [];
  local.revision += 2;
  const remote = structuredClone(base),
    button = createBlock("hero", remote, remote.pages[0]!.id);
  button.props.action = { kind: "scroll", target: text.id };
  remote.blocks.push(button);
  remote.revision += 3;
  const result = mergeProjects(base, local, remote, {
    "/blocks/$order": "remote",
  });
  assert.match(result.error || "", /새 연결 오류/);
  assert.equal(result.project!.revision, remote.revision + 1);
});
