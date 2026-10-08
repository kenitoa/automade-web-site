import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat, lstat } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../src/domain/types";
import type {
  DeploymentEntry,
  DeploymentSettings,
  DeploymentState,
} from "../src/domain/deployment";
import { record } from "../src/domain/validation";
import { inspectProject } from "../src/domain/validation";
import { body, contained, HttpError, reply } from "./http";
import type { Store } from "./store";
import {
  providerRequest,
  validateEndpoint,
  type Connection,
  type Transport,
} from "./platform/connections";
import type { ExpansionScope } from "../src/domain/expansion";
import { ResourceLeases } from "./workQueue";
import { verifyDeploymentIntegrity } from "./deploymentIntegrity";

export interface ReleaseArtifact {
  directory: string;
  projectId: string;
  project: Project;
}
export interface DeploymentBundle {
  sha256: string;
  bytes: number;
  files: { path: string; base64: string; sha256: string }[];
}
export async function deploymentBundle(
  artifact: ReleaseArtifact,
  expectedReleaseId?: string,
): Promise<DeploymentBundle> {
  const root = await realpath(path.join(artifact.directory, "output"));
  if (!contained(await realpath(artifact.directory), root))
    throw new HttpError(403, "DEPLOYMENT_PATH", "배포 출력 경로를 확인하세요.");
  if (expectedReleaseId) {
    const metadataFile = path.join(root, ".release.json"),
      info = await lstat(metadataFile);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.size > 64000 ||
      !contained(root, await realpath(metadataFile))
    )
      throw new HttpError(
        403,
        "DEPLOYMENT_PATH",
        "원본 release 메타데이터 경로를 확인하세요.",
      );
    const source = record(JSON.parse(await readFile(metadataFile, "utf8")));
    if (source.id !== expectedReleaseId)
      throw new HttpError(
        409,
        "DEPLOYMENT_ACTIVATION_MANIFEST",
        "승격 별칭은 원본 결과물의 release ID와 다릅니다. 원본을 수정하지 않는 별도 공개 활성화 계약을 검토해야 합니다.",
      );
  }
  const files: DeploymentBundle["files"] = [];
  let bytes = 0;
  const add = async (relative: string): Promise<void> => {
    if ((await lstat(path.join(root, relative))).isSymbolicLink())
      throw new HttpError(
        403,
        "DEPLOYMENT_SYMLINK",
        "배포 패키지에 심볼릭 링크를 포함할 수 없습니다.",
      );
    const file = await realpath(path.join(root, relative));
    if (!contained(root, file))
      throw new HttpError(
        403,
        "DEPLOYMENT_PATH",
        "배포 파일 경로를 확인하세요.",
      );
    const size = (await stat(file)).size;
    bytes += size;
    if (bytes > 25_000_000 || files.length >= 2000)
      throw new HttpError(
        413,
        "DEPLOYMENT_SIZE",
        "배포 패키지는 최대 25MB·2000개 파일입니다.",
      );
    const data = await readFile(file);
    files.push({
      path: relative.replaceAll("\\", "/"),
      base64: data.toString("base64"),
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  };
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink())
        throw new HttpError(
          403,
          "DEPLOYMENT_SYMLINK",
          "배포 패키지에 심볼릭 링크를 포함할 수 없습니다.",
        );
      const target = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) await add(target);
    }
  };
  await walk("dist");
  for (const file of [
    "site-server.mjs",
    "project.interface.json",
    ".release.json",
    "Dockerfile",
    "compose.yml",
    ".dockerignore",
  ])
    await add(file);
  try {
    await stat(path.join(root, "deployment.contract.json"));
    const verification = await verifyDeploymentIntegrity(root);
    if (
      !verification.supported ||
      verification.contract.projectId !== artifact.projectId ||
      verification.contract.revision !== artifact.project.revision
    )
      throw new HttpError(
        409,
        "DEPLOYMENT_INTEGRITY",
        "검토한 공개 결과물의 파일·프로젝트·버전이 일치하지 않습니다.",
      );
    await add("deployment.contract.json");
    try {
      await stat(path.join(root, "deployment.signature.json"));
      await add("deployment.signature.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    bytes,
    sha256: createHash("sha256")
      .update(
        JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 }))),
      )
      .digest("hex"),
  };
}

export class DeploymentService {
  private inFlight = new Set<string>();
  resolveSecret: (
    reference: string,
    scope?: ExpansionScope,
  ) => string | undefined = (reference) => process.env[reference];
  constructor(
    readonly store: Store,
    readonly artifact: (id: string) => Promise<ReleaseArtifact>,
    readonly transport: Transport = providerRequest,
  ) {}
  state(projectId: string, scope?: ExpansionScope): DeploymentState {
    const value = this.store.operations.state(
      "deployment:" + (scope?.dataKey ?? projectId),
    );
    const saved =
      value && typeof value === "object"
        ? (value as {
            settings?: DeploymentSettings;
            history?: DeploymentEntry[];
          })
        : {};
    const settings = saved.settings ?? null;
    return {
      settings,
      history: saved.history ?? [],
      configured: Boolean(
        settings && this.resolveSecret(settings.secretRef, scope),
      ),
    };
  }
  private save(
    projectId: string,
    state: DeploymentState,
    scope?: ExpansionScope,
  ): void {
    this.store.operations.setState(
      "deployment:" + (scope?.dataKey ?? projectId),
      { settings: state.settings, history: state.history.slice(-100) },
    );
  }
  configure(
    projectId: string,
    input: unknown,
    scope?: ExpansionScope,
  ): DeploymentState {
    if (this.inFlight.has(scope?.dataKey ?? projectId))
      throw new HttpError(
        409,
        "DEPLOYMENT_BUSY",
        "배포가 끝난 뒤 연결 설정을 변경하세요.",
      );
    const v = record(input);
    const referencePattern =
      process.env.APP_MODE === "managed"
        ? /^TENANT_[A-Z0-9_]{1,72}$/
        : /^(?:DEPLOY|TENANT)_[A-Z0-9_]{1,72}$/;
    if (
      typeof v.endpoint !== "string" ||
      v.endpoint.length > 2000 ||
      typeof v.allowedHost !== "string" ||
      typeof v.secretRef !== "string" ||
      !referencePattern.test(v.secretRef) ||
      typeof v.publicOrigin !== "string"
    )
      throw new HttpError(
        400,
        "DEPLOYMENT_CONFIG",
        "HTTPS 연결과 해당 환경의 배포 비밀 참조가 필요합니다.",
      );
    if (
      process.env.APP_MODE === "managed" &&
      !this.resolveSecret(v.secretRef, scope)
    )
      throw new HttpError(
        403,
        "SECRET_SCOPE",
        "해당 조직·환경에서 사용할 수 있는 활성 비밀 참조가 필요합니다.",
      );
    validateEndpoint(v.endpoint, v.allowedHost);
    let origin: URL;
    try {
      origin = new URL(v.publicOrigin);
    } catch {
      throw new HttpError(
        400,
        "DEPLOYMENT_ORIGIN",
        "공개 HTTPS 주소를 확인하세요.",
      );
    }
    if (origin.origin !== v.publicOrigin)
      throw new HttpError(
        400,
        "DEPLOYMENT_ORIGIN",
        "공개 주소는 경로 없는 정확한 HTTPS 출처여야 합니다.",
      );
    validateEndpoint(origin.origin + "/health", origin.hostname);
    const state = this.state(projectId, scope);
    state.settings = {
      endpoint: v.endpoint,
      allowedHost: v.allowedHost,
      secretRef: v.secretRef,
      publicOrigin: v.publicOrigin,
    };
    this.save(projectId, state, scope);
    this.store.audit("deployment.configure", projectId, "success");
    return this.state(projectId, scope);
  }
  private connection(
    projectId: string,
    health = false,
    scope?: ExpansionScope,
  ): Connection {
    const settings = this.state(projectId, scope).settings;
    if (!settings)
      throw new HttpError(
        503,
        "DEPLOYMENT_UNCONFIGURED",
        "배포 연결을 먼저 설정하세요.",
      );
    if (!this.resolveSecret(settings.secretRef, scope))
      throw new HttpError(
        503,
        "DEPLOYMENT_SECRET",
        "해당 환경의 배포 비밀값을 설정하세요.",
      );
    return {
      id: projectId,
      projectId,
      kind: "deployment",
      endpoint: health ? settings.publicOrigin + "/health" : settings.endpoint,
      allowedHost: health
        ? new URL(settings.publicOrigin).hostname
        : settings.allowedHost,
      secretRef: health ? "" : settings.secretRef,
      webhookSecretRef: "",
      paused: false,
      mapping: {},
      resolveSecret: (reference) => this.resolveSecret(reference, scope),
    };
  }
  async readiness(
    projectId: string,
    releaseId: string,
    scope?: ExpansionScope,
  ): Promise<unknown> {
    const artifact = await this.artifact(releaseId);
    if (artifact.projectId !== projectId)
      throw new HttpError(
        403,
        "OWNERSHIP",
        "이 프로젝트의 결과물을 선택하세요.",
      );
    const errors = inspectProject(artifact.project).filter(
      (i) => i.severity === "error",
    );
    const bundle = await deploymentBundle(artifact, releaseId),
      settings = this.state(projectId, scope);
    return {
      ready: errors.length === 0 && settings.configured,
      errors,
      configured: settings.configured,
      releaseId,
      revision: artifact.project.revision,
      sha256: bundle.sha256,
      bytes: bundle.bytes,
      files: bundle.files.length,
      publicOrigin: settings.settings?.publicOrigin ?? null,
      persistentDataRequired: true,
      providerProtocol: 1,
    };
  }
  async publish(
    projectId: string,
    releaseId: string,
    requestKey: string,
    operation: "publish" | "rollback",
    scope?: ExpansionScope,
  ): Promise<DeploymentEntry> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestKey))
      throw new HttpError(400, "IDEMPOTENCY", "배포 요청 키가 필요합니다.");
    let state = this.state(projectId, scope);
    const repeated = state.history.find((e) => e.requestKey === requestKey);
    if (repeated) {
      if (repeated.releaseId !== releaseId || repeated.operation !== operation)
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "같은 배포 요청 키의 내용이 다릅니다.",
        );
      return repeated;
    }
    const resource = scope?.dataKey ?? projectId;
    if (this.inFlight.has(resource))
      throw new HttpError(409, "DEPLOYMENT_BUSY", "이 사이트를 배포 중입니다.");
    const leases = new ResourceLeases(this.store.db),
      lease = leases.acquire(
        `deployment:${resource}`,
        randomUUID(),
        "exclusive",
        300_000,
      );
    let artifactLease: ReturnType<ResourceLeases["acquire"]>;
    try {
      artifactLease = leases.acquire(
        `artifact:${releaseId}`,
        randomUUID(),
        "shared",
        300_000,
      );
    } catch (error) {
      lease.release();
      throw error;
    }
    this.inFlight.add(resource);
    let entry: DeploymentEntry | undefined;
    try {
      const artifact = await this.artifact(releaseId);
      if (artifact.projectId !== projectId)
        throw new HttpError(403, "OWNERSHIP", "다른 프로젝트의 결과물입니다.");
      const artifactScope = this.store.operations.state(
        `generation:scope:${releaseId}`,
      ) as ExpansionScope | null;
      if (
        scope &&
        (artifactScope?.dataKey ?? projectId) !== (scope.dataKey ?? projectId)
      )
        throw new HttpError(
          403,
          "ENVIRONMENT_RELEASE",
          "선택한 환경에서 생성한 릴리스가 필요합니다.",
        );
      if (inspectProject(artifact.project).some((i) => i.severity === "error"))
        throw new HttpError(
          400,
          "DEPLOYMENT_QUALITY",
          "품질 오류를 해결한 후 배포하세요.",
        );
      const connection = this.connection(projectId, false, scope),
        bundle = await deploymentBundle(artifact, releaseId);
      lease.assertCurrent();
      artifactLease.assertCurrent();
      state = this.state(projectId, scope);
      entry = {
        id: randomUUID(),
        requestKey,
        releaseId,
        revision: artifact.project.revision,
        sha256: bundle.sha256,
        status: "preparing",
        operation,
        deploymentId: null,
        createdAt: new Date().toISOString(),
        verifiedAt: null,
        errorCode: null,
      };
      state.history.push(entry);
      this.save(projectId, state, scope);
      const response = record(
        await this.transport(
          connection,
          "POST",
          {
            protocol: 1,
            operation,
            projectId,
            environmentId: scope?.environmentId,
            releaseId,
            revision: entry.revision,
            sha256: entry.sha256,
            publicOrigin: state.settings!.publicOrigin,
            preserveData: true,
            dataVolume: scope?.dataKey ?? projectId,
            activateReleaseId: releaseId,
            files: bundle.files,
          },
          entry.id,
        ),
      );
      lease.assertCurrent();
      if (
        typeof response.deploymentId !== "string" ||
        !/^[-a-zA-Z0-9_:.]{1,200}$/.test(response.deploymentId)
      )
        throw new HttpError(
          502,
          "DEPLOYMENT_RESPONSE",
          "배포 공급자의 배포 ID를 확인하지 못했습니다.",
        );
      entry.deploymentId = response.deploymentId;
      entry.status = "verifying";
      this.save(projectId, state, scope);
      await this.verifyEntry(projectId, entry, scope);
      lease.assertCurrent();
      this.save(projectId, state, scope);
      this.store.audit("deployment." + operation, projectId, "success");
      this.store.operations.measure(
        projectId,
        "site.publish",
        "success",
        Date.now() - Date.parse(entry.createdAt),
      );
      return entry;
    } catch (error) {
      if (entry) {
        lease.assertCurrent();
        entry.status = "unknown";
        entry.errorCode =
          error instanceof HttpError ? error.code : "DEPLOYMENT_FAILED";
        this.save(projectId, state, scope);
        this.store.audit("deployment." + operation, projectId, "failed");
      }
      throw error;
    } finally {
      artifactLease.release();
      lease.release();
      this.inFlight.delete(resource);
    }
  }
  private async verifyEntry(
    projectId: string,
    entry: DeploymentEntry,
    scope?: ExpansionScope,
  ): Promise<void> {
    const raw = record(
        await this.transport(this.connection(projectId, true, scope), "GET"),
      ),
      health = record(raw.data ?? raw);
    if (
      health.status !== "ok" ||
      health.service !== "automade-site" ||
      health.projectId !== projectId ||
      health.revision !== entry.revision ||
      health.releaseId !== entry.releaseId ||
      health.deploymentSha256 !== entry.sha256
    )
      throw new HttpError(
        409,
        "DEPLOYMENT_VERSION",
        "공개 사이트의 프로젝트·릴리스·버전·패키지 해시가 배포 요청과 일치하지 않습니다. 공급자 상태를 확인하세요.",
      );
    entry.status = "verified";
    entry.errorCode = null;
    entry.verifiedAt = new Date().toISOString();
  }
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    scope?: ExpansionScope,
  ): Promise<boolean> {
    const match = url.pathname.match(
      /^\/api\/projects\/([a-zA-Z0-9_-]+)\/deployment(?:\/(readiness|test|publish|rollback|verify))?$/,
    );
    if (!match) return false;
    const projectId = match[1]!,
      action = match[2];
    if (!this.store.project(projectId))
      throw new HttpError(
        404,
        "PROJECT_NOT_FOUND",
        "프로젝트를 찾을 수 없습니다.",
      );
    if (!action && req.method === "GET") {
      reply(res, 200, this.state(projectId, scope));
      return true;
    }
    if (!action && req.method === "PUT") {
      reply(res, 200, this.configure(projectId, await body(req, 10000), scope));
      return true;
    }
    if (action === "readiness" && req.method === "GET") {
      reply(
        res,
        200,
        await this.readiness(
          projectId,
          url.searchParams.get("releaseId") ?? "",
          scope,
        ),
      );
      return true;
    }
    if (req.method !== "POST")
      throw new HttpError(405, "METHOD", "지원하지 않는 요청입니다.");
    const v = record(await body(req, 10000));
    if (action === "test") {
      await this.transport(this.connection(projectId, false, scope), "GET");
      reply(res, 200, {
        reachable: true,
        published: false,
        message:
          "연결 응답만 확인했습니다. 공개 버전 검증은 배포 후 수행합니다.",
      });
      return true;
    }
    if (action === "publish" || action === "rollback") {
      if (v.confirm !== true)
        throw new HttpError(
          400,
          "DEPLOYMENT_CONFIRM",
          "공개 주소와 변경 범위를 확인하세요.",
        );
      reply(
        res,
        200,
        await this.publish(
          projectId,
          String(v.releaseId ?? ""),
          String(v.requestKey ?? ""),
          action,
          scope,
        ),
      );
      return true;
    }
    if (action === "verify") {
      const state = this.state(projectId, scope),
        entry = state.history.find((e) => e.id === v.id);
      if (!entry)
        throw new HttpError(
          404,
          "DEPLOYMENT_NOT_FOUND",
          "배포 기록을 찾을 수 없습니다.",
        );
      await this.verifyEntry(projectId, entry, scope);
      this.save(projectId, state, scope);
      reply(res, 200, entry);
      return true;
    }
    throw new HttpError(404, "DEPLOYMENT_ACTION", "배포 작업을 확인하세요.");
  }
}
