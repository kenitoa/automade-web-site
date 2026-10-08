import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, cp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createProject } from "../src/domain/catalog";
import { deploymentBundle } from "../server/deploymentService";
import {
  writeDeploymentContract,
  verifyDeploymentIntegrity,
} from "../server/deploymentIntegrity";
import {
  parseReleaseApproval,
  validatePreparedRelease,
  validateProjectApproval,
  publishReviewedRelease,
  verifyReviewedRelease,
} from "../scripts/publish-reviewed-release";
import { record } from "../src/domain/validation";
import type { Transport } from "../server/platform/connections";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("unconfigured release CLI skips without reading a project or sending a deployment", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("RELEASE_")),
  );
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "scripts/publish-reviewed-release.ts", "prepare"],
    { cwd: process.cwd(), env, windowsHide: true },
  );
  assert.match(result.stdout, /^RELEASE_SKIPPED:/);
});

test("reviewed release gates reject changed approvals and verify actual public SHA after gateway upload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "automade-reviewed-release-")),
    output = path.join(root, "output"),
    project = createProject("Reviewed"),
    commit = "a".repeat(40),
    buildHash = "b".repeat(64);
  const previousHosts = process.env.PLATFORM_ALLOWED_HOSTS,
    previousToken = process.env.RELEASE_GATEWAY_TOKEN;
  process.env.PLATFORM_ALLOWED_HOSTS = "deploy.example.org,site.example.org";
  process.env.RELEASE_GATEWAY_TOKEN = "test-only-operator-token";
  try {
    await mkdir(path.join(output, "dist/assets"), { recursive: true });
    for (const [file, bytes] of Object.entries({
      "dist/index.html": "<html>Reviewed</html>",
      "dist/assets/site.js": "//client",
      "site-server.mjs": "//compiled",
      "project.interface.json": JSON.stringify({ project }),
      ".release.json": JSON.stringify({
        id: "reviewed-one",
        projectId: project.id,
        revision: project.revision,
      }),
    }))
      await writeFile(path.join(output, file), bytes);
    for (const file of ["Dockerfile", "compose.yml", ".dockerignore"])
      await cp(
        path.join(process.cwd(), "infrastructure/site", file),
        path.join(output, file),
      );
    await writeDeploymentContract(output, {
      projectId: project.id,
      revision: project.revision,
      releaseId: "reviewed-one",
      buildHash,
      buildCommit: commit,
    });
    assert.equal(
      (
        await verifyDeploymentIntegrity(output, {
          buildHash,
          buildCommit: commit,
        })
      ).supported,
      true,
    );
    assert.equal(
      (await verifyDeploymentIntegrity(output, { buildHash: "c".repeat(64) }))
        .supported,
      false,
    );
    const bundle = await deploymentBundle({
      directory: root,
      projectId: project.id,
      project,
    });
    const approval = {
      protocol: 1,
      projectId: project.id,
      projectRevision: project.revision,
      projectSha256: createHash("sha256")
        .update(await readFile(path.join(output, "project.interface.json")))
        .digest("hex"),
      buildCommit: commit,
      buildHash,
      publicOrigin: "https://site.example.org",
      dataVolume: project.id,
      approvedBy: "fixture-owner",
      approvedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      qualityApproved: true,
    };
    const prepared = validatePreparedRelease(
      {
        protocol: 1,
        approval,
        projectId: project.id,
        revision: project.revision,
        releaseId: "reviewed-one",
        sha256: bundle.sha256,
        buildHash,
        buildCommit: commit,
        publicOrigin: approval.publicOrigin,
        dataVolume: project.id,
        requestKey: "reviewed-request-one",
        files: bundle.files,
      },
      commit,
    );
    const projectBytes = await readFile(
        path.join(output, "project.interface.json"),
      ),
      parsedApproval = parseReleaseApproval(approval, commit);
    assert.equal(
      validateProjectApproval(
        projectBytes,
        { hash: buildHash, commit },
        parsedApproval,
        approval.publicOrigin,
      ).id,
      project.id,
    );
    assert.throws(
      () =>
        validateProjectApproval(
          projectBytes,
          { hash: buildHash, commit: "c".repeat(40) },
          parsedApproval,
          approval.publicOrigin,
        ),
      /differs/,
    );
    assert.throws(
      () =>
        validateProjectApproval(
          Buffer.from(
            JSON.stringify({
              project: { ...project, name: "Changed after review" },
            }),
          ),
          { hash: buildHash, commit },
          parsedApproval,
          approval.publicOrigin,
        ),
      /differs/,
    );
    assert.throws(
      () =>
        validatePreparedRelease(
          {
            ...prepared,
            approval: { ...approval, artifactSha256: "d".repeat(64) },
          },
          commit,
        ),
      /explicit reviewed hash/,
    );
    assert.equal(
      validatePreparedRelease(
        {
          ...prepared,
          approval: { ...approval, artifactSha256: prepared.sha256 },
          requestKey: "rollback_exact_hash",
        },
        commit,
      ).sha256,
      prepared.sha256,
    );
    assert.throws(
      () =>
        parseReleaseApproval(
          { ...approval, expiresAt: new Date(Date.now() - 1).toISOString() },
          commit,
        ),
      /expired/,
    );
    assert.throws(
      () =>
        validatePreparedRelease(
          { ...prepared, buildHash: "d".repeat(64) },
          commit,
        ),
      /differs/,
    );
    assert.throws(
      () =>
        validatePreparedRelease(
          { ...prepared, files: [...prepared.files, prepared.files[0]] },
          commit,
        ),
      /Duplicate/,
    );
    let posts = 0,
      wrong = false;
    const transport: Transport = async (connection, method, payload, key) => {
      if (method === "POST") {
        posts++;
        const request = record(payload);
        assert.equal(request.preserveData, true);
        assert.equal(request.dataVolume, project.id);
        assert.equal(request.buildCommit, commit);
        assert.equal(key, prepared.requestKey);
        return { deploymentId: "fixture-deploy-one" };
      }
      assert.equal(connection.secretRef, "");
      return {
        data: {
          service: "automade-site",
          status: "ok",
          projectId: project.id,
          revision: project.revision,
          releaseId: "reviewed-one",
          deploymentSha256: prepared.sha256,
          buildCommit: wrong ? "c".repeat(40) : commit,
          buildHash,
        },
      };
    };
    const options = {
      endpoint: "https://deploy.example.org/releases",
      allowedHost: "deploy.example.org",
      secretRef: "RELEASE_GATEWAY_TOKEN",
      expectedCommit: commit,
      transport,
    };
    assert.equal(
      (await publishReviewedRelease(prepared, options)).status,
      "verified",
    );
    assert.equal(
      (
        await verifyReviewedRelease(prepared, {
          expectedCommit: commit,
          transport,
        })
      ).status,
      "verified",
    );
    assert.equal(
      posts,
      1,
      "Public reconciliation only reads health and never uploads",
    );
    wrong = true;
    await assert.rejects(
      publishReviewedRelease(prepared, options),
      /PUBLIC_RELEASE_UNVERIFIED/,
    );
    assert.equal(
      posts,
      2,
      "Uncertain health does not trigger another upload retry",
    );
    await assert.rejects(
      publishReviewedRelease(
        { ...prepared, approval: { ...approval, qualityApproved: false } },
        options,
      ),
      /approval/,
    );
    assert.equal(posts, 2);
    await writeFile(path.join(output, "site-server.mjs"), "//changed");
    assert.equal((await verifyDeploymentIntegrity(output)).supported, false);
    await assert.rejects(
      deploymentBundle({ directory: root, projectId: project.id, project }),
      /일치/,
    );
  } finally {
    if (previousHosts === undefined) delete process.env.PLATFORM_ALLOWED_HOSTS;
    else process.env.PLATFORM_ALLOWED_HOSTS = previousHosts;
    if (previousToken === undefined) delete process.env.RELEASE_GATEWAY_TOKEN;
    else process.env.RELEASE_GATEWAY_TOKEN = previousToken;
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
