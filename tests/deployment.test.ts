import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store";
import { createProject } from "../src/domain/catalog";
import {
  DeploymentService,
  deploymentBundle,
} from "../server/deploymentService";
import type { Transport } from "../server/platform/connections";
import {
  generationSettings,
  reserveGeneration,
  validateGenerationBudget,
} from "../server/generationBudget";

test("deployment manifest excludes operational data, credentials and bundled OS runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automade-deploy-")),
    output = path.join(root, "output");
  await mkdir(path.join(output, "dist"), { recursive: true });
  const p = createProject("Deploy");
  p.settings.description = "Ready";
  for (const [file, data] of Object.entries({
    "dist/index.html": "<html>Ready</html>",
    "site-server.mjs": "//runtime",
    "project.interface.json": JSON.stringify({ project: p }),
    ".release.json": JSON.stringify({ id: "release-one" }),
    ".site-data.sqlite": "PRIVATE",
    ".env": "PRIVATE",
    "runtime/node.exe": "OS",
  })) {
    await mkdir(path.dirname(path.join(output, file)), { recursive: true });
    await writeFile(path.join(output, file), data);
  }
  for (const file of ["Dockerfile", "compose.yml", ".dockerignore"])
    await cp(
      path.join(process.cwd(), "infrastructure/site", file),
      path.join(output, file),
    );
  const bundle = await deploymentBundle({
    directory: root,
    projectId: p.id,
    project: p,
  });
  assert.equal(
    (
      await deploymentBundle(
        { directory: root, projectId: p.id, project: p },
        "release-one",
      )
    ).sha256,
    bundle.sha256,
  );
  const releaseBytes = await readFile(path.join(output, ".release.json"));
  await assert.rejects(
    deploymentBundle(
      { directory: root, projectId: p.id, project: p },
      "immutable-promotion-alias",
    ),
    (error) =>
      error instanceof Error && error.message.includes("별도 공개 활성화"),
  );
  assert.deepEqual(
    await readFile(path.join(output, ".release.json")),
    releaseBytes,
    "Rejecting alias deployment preserves original immutable release bytes",
  );
  assert.ok(!bundle.files.some((f) => /\.env|sqlite|runtime\//.test(f.path)));
  assert.ok(bundle.files.some((f) => f.path === ".release.json"));
  const docker = await readFile(path.join(output, "Dockerfile"), "utf8");
  assert.match(docker, /USER node/);
  assert.ok(!docker.includes("COPY . "));
});

test("deployment records verify remote release and manifest, retry uncertain state and preserve idempotency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automade-deploy-state-")),
    output = path.join(root, "output");
  await mkdir(path.join(output, "dist"), { recursive: true });
  const p = createProject("Deploy");
  p.settings.description = "Ready";
  for (const file of [
    "dist/index.html",
    "site-server.mjs",
    "project.interface.json",
    ".release.json",
    "Dockerfile",
    "compose.yml",
    ".dockerignore",
  ])
    await writeFile(path.join(output, file), "fixture");
  await writeFile(
    path.join(output, ".release.json"),
    JSON.stringify({ id: "release-one" }),
  );
  const store = new Store(":memory:");
  store.save(p);
  let posts = 0,
    wrong = false;
  let expected: Record<string, unknown> = {};
  const previous = {
    hosts: process.env.PLATFORM_ALLOWED_HOSTS,
    secret: process.env.DEPLOY_TEST_KEY,
  };
  process.env.PLATFORM_ALLOWED_HOSTS = "deploy.example.org,site.example.org";
  process.env.DEPLOY_TEST_KEY = "test-only";
  const transport: Transport = async (connection, method, payload) => {
    if (method === "POST") {
      posts++;
      expected = payload as Record<string, unknown>;
      assert.equal(expected.preserveData, true);
      assert.equal(expected.activateReleaseId, "release-one");
      return { deploymentId: "remote-one" };
    }
    assert.equal(connection.secretRef, "");
    return {
      data: {
        status: "ok",
        service: "automade-site",
        projectId: p.id,
        revision: p.revision,
        releaseId: wrong ? "old" : "release-one",
        deploymentSha256: expected.sha256,
      },
    };
  };
  const service = new DeploymentService(
    store,
    async () => ({ directory: root, projectId: p.id, project: p }),
    transport,
  );
  try {
    assert.throws(() =>
      service.configure(p.id, {
        endpoint: "http://localhost",
        allowedHost: "localhost",
        secretRef: "DEPLOY_TEST_KEY",
        publicOrigin: "https://site.example.org",
      }),
    );
    service.configure(p.id, {
      endpoint: "https://deploy.example.org/api/deploy",
      allowedHost: "deploy.example.org",
      secretRef: "DEPLOY_TEST_KEY",
      publicOrigin: "https://site.example.org",
    });
    const entry = await service.publish(
      p.id,
      "release-one",
      "request-one",
      "publish",
    );
    assert.equal(entry.status, "verified");
    assert.ok(entry.verifiedAt);
    assert.equal(
      (await service.publish(p.id, "release-one", "request-one", "publish")).id,
      entry.id,
    );
    assert.equal(posts, 1);
    await assert.rejects(
      service.publish(p.id, "other", "request-one", "publish"),
      /같은/,
    );
    wrong = true;
    await assert.rejects(
      service.publish(p.id, "release-one", "request-two", "rollback"),
      /일치/,
    );
    assert.equal(service.state(p.id).history.at(-1)?.status, "unknown");
    assert.ok(!JSON.stringify(service.state(p.id)).includes("test-only"));
  } finally {
    store.close();
    for (const [name, value] of [
      ["PLATFORM_ALLOWED_HOSTS", previous.hosts],
      ["DEPLOY_TEST_KEY", previous.secret],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("AI request and estimated spending budgets persist across settings reads and fail before external calls", () => {
  const names = [
    "GENERATION_API_URL",
    "GENERATION_MONTHLY_LIMIT",
    "GENERATION_REQUEST_COST_MINOR",
    "GENERATION_SPEND_LIMIT_MINOR",
    "GENERATION_CURRENCY",
  ] as const;
  const previous = names.map((name) => [name, process.env[name]] as const),
    store = new Store(":memory:");
  try {
    process.env.GENERATION_API_URL = "https://ai.example.org";
    process.env.GENERATION_MONTHLY_LIMIT = "3";
    process.env.GENERATION_REQUEST_COST_MINOR = "100";
    process.env.GENERATION_SPEND_LIMIT_MINOR = "200";
    process.env.GENERATION_CURRENCY = "KRW";
    validateGenerationBudget();
    reserveGeneration(store);
    reserveGeneration(store);
    assert.throws(() => reserveGeneration(store), /한도/);
    const settings = generationSettings(store) as {
      usage: {
        used: number;
        estimatedCostMinor: number;
        costVerified: boolean;
      };
    };
    assert.equal(settings.usage.used, 2);
    assert.equal(settings.usage.estimatedCostMinor, 200);
    assert.equal(settings.usage.costVerified, false);
    process.env.GENERATION_MONTHLY_LIMIT = "no";
    assert.throws(() => validateGenerationBudget(), /integer/);
    delete process.env.GENERATION_API_URL;
    reserveGeneration(store);
  } finally {
    store.close();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
