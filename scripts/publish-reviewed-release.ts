import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generate } from "../server/generator";
import {
  deploymentBundle,
  type DeploymentBundle,
} from "../server/deploymentService";
import {
  verifyDeploymentIntegrity,
  parseDeploymentContract,
} from "../server/deploymentIntegrity";
import { verifyArtifactIntegrity } from "../server/artifactIntegrity";
import {
  providerRequest,
  validateEndpoint,
  type Connection,
  type Transport,
} from "../server/platform/connections";
import { parseProject, inspectProject, record } from "../src/domain/validation";
import type { Project } from "../src/domain/types";

export interface ReleaseApproval {
  protocol: 1;
  projectId: string;
  projectRevision: number;
  projectSha256: string;
  buildCommit: string;
  buildHash: string;
  publicOrigin: string;
  dataVolume: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  qualityApproved: true;
  artifactSha256?: string;
}
export interface PreparedRelease {
  protocol: 1;
  approval: ReleaseApproval;
  projectId: string;
  revision: number;
  releaseId: string;
  sha256: string;
  buildHash: string;
  buildCommit: string;
  publicOrigin: string;
  dataVolume: string;
  requestKey: string;
  files: DeploymentBundle["files"];
}
const digest = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
function text(value: unknown, pattern: RegExp, name: string): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error(`Invalid reviewed release ${name}`);
  return value;
}
export function parseReleaseApproval(
  value: unknown,
  expectedCommit: string,
  now = Date.now(),
): ReleaseApproval {
  const raw = record(value),
    approvedAt = Date.parse(String(raw.approvedAt)),
    expiresAt = Date.parse(String(raw.expiresAt));
  if (
    raw.protocol !== 1 ||
    raw.qualityApproved !== true ||
    !Number.isSafeInteger(raw.projectRevision) ||
    Number(raw.projectRevision) < 0 ||
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(expiresAt) ||
    approvedAt > now ||
    expiresAt <= now ||
    expiresAt - approvedAt > 7 * 24 * 60 * 60 * 1000
  )
    throw new Error("Reviewed release approval is missing, expired or invalid");
  const commit = text(raw.buildCommit, /^[a-f0-9]{40}$/, "commit");
  if (commit !== expectedCommit)
    throw new Error(
      "Reviewed approval does not match the tested source commit",
    );
  const publicOrigin = text(
      raw.publicOrigin,
      /^https:\/\/[^\s]{1,2000}$/,
      "public origin",
    ),
    origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || origin.username || origin.password)
    throw new Error("Reviewed public origin must be an exact HTTPS origin");
  return {
    protocol: 1,
    projectId: text(raw.projectId, /^[A-Za-z0-9_-]{1,100}$/, "project"),
    projectRevision: Number(raw.projectRevision),
    projectSha256: text(
      raw.projectSha256,
      /^[a-f0-9]{64}$/,
      "project fingerprint",
    ),
    buildCommit: commit,
    buildHash: text(raw.buildHash, /^[a-f0-9]{64}$/, "build fingerprint"),
    publicOrigin,
    dataVolume: text(raw.dataVolume, /^[A-Za-z0-9_.:-]{1,150}$/, "data volume"),
    approvedBy: text(raw.approvedBy, /^[A-Za-z0-9_.:@-]{1,100}$/, "approver"),
    approvedAt: String(raw.approvedAt),
    expiresAt: String(raw.expiresAt),
    qualityApproved: true,
    ...(raw.artifactSha256 === undefined
      ? {}
      : {
          artifactSha256: text(
            raw.artifactSha256,
            /^[a-f0-9]{64}$/,
            "approved artifact fingerprint",
          ),
        }),
  };
}
export function validatePreparedRelease(
  value: unknown,
  expectedCommit: string,
): PreparedRelease {
  const raw = record(value),
    approval = parseReleaseApproval(raw.approval, expectedCommit);
  if (
    raw.protocol !== 1 ||
    raw.projectId !== approval.projectId ||
    raw.revision !== approval.projectRevision ||
    raw.buildCommit !== approval.buildCommit ||
    raw.buildHash !== approval.buildHash ||
    raw.publicOrigin !== approval.publicOrigin ||
    raw.dataVolume !== approval.dataVolume ||
    !Array.isArray(raw.files) ||
    raw.files.length > 2000
  )
    throw new Error("Prepared release differs from its reviewed approval");
  let bytes = 0;
  const files = raw.files
    .map((input) => {
      const file = record(input),
        relative = text(
          file.path,
          /^(?:dist\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+|site-server\.mjs|project\.interface\.json|\.release\.json|Dockerfile|compose\.yml|\.dockerignore|deployment\.(?:contract|signature)\.json)$/,
          "file path",
        );
      if (
        relative
          .split("/")
          .some((segment) => segment === "." || segment === "..") ||
        typeof file.base64 !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          file.base64,
        )
      )
        throw new Error("Invalid deployment bytes");
      const data = Buffer.from(file.base64, "base64"),
        sha256 = text(file.sha256, /^[a-f0-9]{64}$/, "file hash");
      bytes += data.length;
      if (bytes > 25_000_000 || digest(data) !== sha256)
        throw new Error("Prepared release file integrity mismatch");
      return { path: relative, base64: file.base64, sha256 };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error("Duplicate release paths");
  const sha256 = digest(
    JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 }))),
  );
  if (sha256 !== raw.sha256)
    throw new Error("Reviewed artifact hash differs from prepared files");
  if (approval.artifactSha256 && approval.artifactSha256 !== sha256)
    throw new Error(
      "Prepared artifact differs from its explicit reviewed hash",
    );
  const required = (file: string): Buffer => {
    const item = files.find((item) => item.path === file);
    if (!item) throw new Error(`Required release file missing: ${file}`);
    return Buffer.from(item.base64, "base64");
  };
  const manifest = parseDeploymentContract(
      JSON.parse(required("deployment.contract.json").toString("utf8")),
    ),
    release = record(JSON.parse(required(".release.json").toString("utf8")));
  if (
    manifest.buildCommit !== expectedCommit ||
    manifest.buildHash !== approval.buildHash ||
    manifest.projectId !== approval.projectId ||
    manifest.revision !== approval.projectRevision ||
    release.id !== raw.releaseId ||
    manifest.releaseId !== raw.releaseId
  )
    throw new Error(
      "Prepared artifact metadata differs from reviewed source or activation",
    );
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.some((input) => {
      const entry = record(input);
      return !files.some(
        (file) => file.path === entry.path && file.sha256 === entry.sha256,
      );
    })
  )
    throw new Error("Deployment manifest does not match prepared bytes");
  return {
    protocol: 1,
    approval,
    projectId: approval.projectId,
    revision: approval.projectRevision,
    releaseId: text(raw.releaseId, /^[A-Za-z0-9_-]{1,100}$/, "release"),
    sha256,
    buildHash: approval.buildHash,
    buildCommit: approval.buildCommit,
    publicOrigin: approval.publicOrigin,
    dataVolume: approval.dataVolume,
    requestKey: text(raw.requestKey, /^[A-Za-z0-9_.:-]{1,150}$/, "request key"),
    files,
  };
}
export function validateProjectApproval(
  projectBytes: Buffer,
  buildValue: unknown,
  approval: ReleaseApproval,
  publicOrigin: string,
): Project {
  const document = record(JSON.parse(projectBytes.toString("utf8"))),
    project = parseProject(document.project ?? document),
    build = record(buildValue);
  if (
    project.id !== approval.projectId ||
    project.revision !== approval.projectRevision ||
    digest(projectBytes) !== approval.projectSha256 ||
    build.commit !== approval.buildCommit ||
    build.hash !== approval.buildHash ||
    publicOrigin !== approval.publicOrigin ||
    inspectProject(project).some((issue) => issue.severity === "error")
  )
    throw new Error(
      "Project, quality review, build or target differs from approval",
    );
  return project;
}
export async function verifyReviewedRelease(
  input: unknown,
  options: { expectedCommit: string; transport?: Transport },
): Promise<{
  status: "verified";
  releaseId: string;
  buildCommit: string;
  sha256: string;
}> {
  const prepared = validatePreparedRelease(input, options.expectedCommit),
    healthHost = new URL(prepared.publicOrigin).hostname;
  validateEndpoint(prepared.publicOrigin + "/health", healthHost);
  const healthConnection: Connection = {
    id: prepared.releaseId,
    projectId: prepared.projectId,
    kind: "deployment",
    endpoint: prepared.publicOrigin + "/health",
    allowedHost: healthHost,
    secretRef: "",
    webhookSecretRef: "",
    paused: false,
    mapping: {},
  };
  const raw = record(
      await (options.transport ?? providerRequest)(
        healthConnection,
        "GET",
        undefined,
        prepared.requestKey,
      ),
    ),
    health = record(raw.data ?? raw);
  if (
    health.service !== "automade-site" ||
    health.status !== "ok" ||
    health.projectId !== prepared.projectId ||
    health.revision !== prepared.revision ||
    health.releaseId !== prepared.releaseId ||
    health.deploymentSha256 !== prepared.sha256 ||
    health.buildCommit !== prepared.buildCommit ||
    health.buildHash !== prepared.buildHash
  )
    throw new Error(
      "PUBLIC_RELEASE_UNVERIFIED: actual public SHA/build/activation does not match; reconcile before repeating any external write",
    );
  return {
    status: "verified",
    releaseId: prepared.releaseId,
    buildCommit: prepared.buildCommit,
    sha256: prepared.sha256,
  };
}
export async function publishReviewedRelease(
  input: unknown,
  options: {
    endpoint: string;
    allowedHost: string;
    secretRef: string;
    expectedCommit: string;
    operation?: "publish" | "rollback";
    transport?: Transport;
  },
): Promise<{
  status: "verified";
  deploymentId: string;
  releaseId: string;
  buildCommit: string;
  sha256: string;
}> {
  const prepared = validatePreparedRelease(input, options.expectedCommit);
  validateEndpoint(options.endpoint, options.allowedHost);
  validateEndpoint(
    prepared.publicOrigin + "/health",
    new URL(prepared.publicOrigin).hostname,
  );
  if (
    !/^[A-Z][A-Z0-9_]{1,79}$/.test(options.secretRef) ||
    !process.env[options.secretRef]
  )
    throw new Error("Reviewed deployment gateway secret is not configured");
  const connection: Connection = {
      id: prepared.releaseId,
      projectId: prepared.projectId,
      kind: "deployment",
      endpoint: options.endpoint,
      allowedHost: options.allowedHost,
      secretRef: options.secretRef,
      webhookSecretRef: "",
      paused: false,
      mapping: {},
    },
    transport = options.transport ?? providerRequest;
  const response = record(
    await transport(
      connection,
      "POST",
      {
        protocol: 1,
        operation: options.operation ?? "publish",
        projectId: prepared.projectId,
        releaseId: prepared.releaseId,
        revision: prepared.revision,
        sha256: prepared.sha256,
        buildCommit: prepared.buildCommit,
        buildHash: prepared.buildHash,
        publicOrigin: prepared.publicOrigin,
        preserveData: true,
        dataVolume: prepared.dataVolume,
        activateReleaseId: prepared.releaseId,
        files: prepared.files,
      },
      prepared.requestKey,
    ),
  );
  const deploymentId = text(
    response.deploymentId,
    /^[-A-Za-z0-9_:.]{1,200}$/,
    "deployment id",
  );
  await verifyReviewedRelease(prepared, {
    expectedCommit: options.expectedCommit,
    transport,
  });
  return {
    status: "verified",
    deploymentId,
    releaseId: prepared.releaseId,
    buildCommit: prepared.buildCommit,
    sha256: prepared.sha256,
  };
}
async function main(): Promise<void> {
  const mode = process.argv[2] ?? "prepare",
    root = process.cwd(),
    output = path.resolve(
      process.env.RELEASE_PREPARED_FILE ??
        ".data/reviewed-release/prepared.json",
    );
  const projectFile = process.env.RELEASE_PROJECT_FILE,
    endpoint = process.env.RELEASE_GATEWAY_URL,
    expectedCommit =
      process.env.RELEASE_EXPECTED_COMMIT ??
      process.env.AUTOMADE_SOURCE_COMMIT ??
      process.env.GITHUB_SHA;
  if (
    !projectFile ||
    !endpoint ||
    !process.env.RELEASE_APPROVAL_FILE ||
    !process.env.RELEASE_PUBLIC_ORIGIN ||
    !process.env.RELEASE_ALLOWED_HOSTS
  ) {
    console.log(
      "RELEASE_SKIPPED: reviewed project, approval and deployment target are not configured",
    );
    return;
  }
  if (!expectedCommit || !/^[a-f0-9]{40}$/.test(expectedCommit))
    throw new Error("Exact tested source commit is required");
  process.env.PLATFORM_ALLOWED_HOSTS = process.env.RELEASE_ALLOWED_HOSTS;
  if (mode === "prepare-rollback") {
    const previous = record(JSON.parse(await readFile(output, "utf8"))),
      approval = parseReleaseApproval(
        JSON.parse(
          await readFile(
            path.resolve(process.env.RELEASE_APPROVAL_FILE),
            "utf8",
          ),
        ),
        expectedCommit,
      );
    if (approval.artifactSha256 !== previous.sha256)
      throw new Error(
        "Rollback approval must name the exact previously prepared artifact hash",
      );
    const prepared = validatePreparedRelease(
      {
        ...previous,
        approval,
        requestKey: `rollback:${digest(JSON.stringify([previous.sha256, approval]))}`,
      },
      expectedCommit,
    );
    await writeFile(output, JSON.stringify(prepared));
    console.log(
      `ROLLBACK_PREPARED: existing immutable artifact ${prepared.releaseId} SHA256=${prepared.sha256}`,
    );
  } else if (mode === "prepare") {
    const projectBytes = await readFile(path.resolve(projectFile)),
      approval = parseReleaseApproval(
        JSON.parse(
          await readFile(
            path.resolve(process.env.RELEASE_APPROVAL_FILE),
            "utf8",
          ),
        ),
        expectedCommit,
      ),
      build = record(
        JSON.parse(
          await readFile(path.join(root, "dist-service/build.json"), "utf8"),
        ),
      ),
      project = validateProjectApproval(
        projectBytes,
        build,
        approval,
        process.env.RELEASE_PUBLIC_ORIGIN,
      );
    const artifact = process.env.RELEASE_ARTIFACT_DIRECTORY
      ? {
          path: path.resolve(process.env.RELEASE_ARTIFACT_DIRECTORY),
          source: path.join(
            path.resolve(process.env.RELEASE_ARTIFACT_DIRECTORY),
            "output",
          ),
        }
      : await generate(project, {
          root: path.join(root, "exports/reviewed-release"),
          sourceRoot: root,
          id: randomUUID(),
        });
    const full = await verifyArtifactIntegrity(artifact.source),
      compact = await verifyDeploymentIntegrity(artifact.source, {
        buildHash: approval.buildHash,
        buildCommit: expectedCommit,
      });
    if (!full.supported || !compact.supported)
      throw new Error("Reviewed artifact integrity failed");
    const bundle = await deploymentBundle({
      directory: artifact.path,
      projectId: project.id,
      project,
    });
    const prepared = validatePreparedRelease(
      {
        protocol: 1,
        approval,
        projectId: project.id,
        revision: project.revision,
        releaseId: compact.contract.releaseId,
        sha256: bundle.sha256,
        buildHash: approval.buildHash,
        buildCommit: expectedCommit,
        publicOrigin: approval.publicOrigin,
        dataVolume: approval.dataVolume,
        requestKey: `ci:${digest(JSON.stringify([expectedCommit, bundle.sha256, approval.publicOrigin, approval.dataVolume]))}`,
        files: bundle.files,
      },
      expectedCommit,
    );
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(prepared));
    console.log(
      `RELEASE_PREPARED: ${prepared.releaseId} SHA256=${prepared.sha256}`,
    );
  } else if (mode === "publish" || mode === "rollback" || mode === "verify") {
    const prepared = validatePreparedRelease(
        JSON.parse(await readFile(output, "utf8")),
        expectedCommit,
      ),
      started = new Date().toISOString(),
      verificationFile = path.join(path.dirname(output), "verification.json");
    try {
      if (mode !== "verify") {
        try {
          const previous = record(
            JSON.parse(await readFile(verificationFile, "utf8")),
          );
          if (
            previous.requestKey === prepared.requestKey &&
            previous.status === "unknown"
          )
            throw new Error(
              "RELEASE_RECONCILIATION_REQUIRED: use verify for this uncertain artifact before another external write",
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const result =
        mode === "verify"
          ? await verifyReviewedRelease(prepared, { expectedCommit })
          : await publishReviewedRelease(prepared, {
              endpoint,
              allowedHost: new URL(endpoint).hostname,
              secretRef: "RELEASE_GATEWAY_TOKEN",
              expectedCommit,
              operation: mode,
            });
      await writeFile(
        verificationFile,
        JSON.stringify(
          {
            started,
            checkedAt: new Date().toISOString(),
            requestKey: prepared.requestKey,
            ...result,
          },
          null,
          2,
        ),
      );
      console.log(
        `RELEASE_VERIFIED: ${result.releaseId} commit=${result.buildCommit}`,
      );
    } catch (error) {
      await writeFile(
        verificationFile,
        JSON.stringify(
          {
            started,
            status: "unknown",
            code: "PUBLIC_RELEASE_UNVERIFIED",
            requestKey: prepared.requestKey,
            releaseId: prepared.releaseId,
            sha256: prepared.sha256,
            buildCommit: prepared.buildCommit,
            checkedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      throw error;
    }
  } else
    throw new Error(
      "Usage: tsx scripts/publish-reviewed-release.ts prepare|prepare-rollback|publish|rollback|verify",
    );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Reviewed release failed",
    );
    process.exitCode = 1;
  });
