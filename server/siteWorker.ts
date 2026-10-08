import { startSite, type RunningSite } from "./siteServer";
import { parseProject, record } from "../src/domain/validation";
import { HttpError } from "./http";
import { setConnectionSecretResolver } from "./platform/connections";
import { Store } from "./store";
import { workerEnvelope } from "./workerProtocol";
let site: RunningSite | undefined;
let coordinator: Store | undefined;
let closing: Promise<void> | undefined;
const close = (): Promise<void> =>
  (closing ??= (async () => {
    try {
      await site?.close();
    } finally {
      coordinator?.close();
      coordinator = undefined;
    }
  })());
process.on("message", (input: unknown) => {
  let value: Record<string, unknown>;
  try {
    value = workerEnvelope(input);
  } catch (error) {
    process.send?.(
      {
        protocol: 1,
        type: "error",
        code: error instanceof HttpError ? error.code : "SITE_WORKER_INPUT",
        message: "사이트 worker 메시지를 검증하지 못했습니다.",
      },
      () => {
        void close().finally(() => process.exit(1));
      },
    );
    return;
  }
  if (value.type === "pause" && typeof value.paused === "boolean") {
    site?.pauseWrites(value.paused);
    return;
  }
  if (value.type === "stop") {
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    return;
  }
  if (value.type !== "start" || site) return;
  void (async () => {
    const project = parseProject(value.project);
    if (
      typeof value.directory !== "string" ||
      typeof value.dataFile !== "string" ||
      typeof value.releaseId !== "string"
    )
      throw new HttpError(
        400,
        "SITE_WORKER_INPUT",
        "사이트 worker 입력을 확인하세요.",
      );
    let assertLease: (() => void) | undefined;
    if (value.leaseGuard) {
      const guard = record(value.leaseGuard);
      if (
        typeof guard.studioFile !== "string" ||
        !Array.isArray(guard.tokens) ||
        guard.tokens.length !== 2
      )
        throw new HttpError(
          400,
          "SITE_LEASE",
          "사이트 사용 권한을 확인하세요.",
        );
      const tokens = guard.tokens.map((input) => {
        const token = record(input);
        if (
          typeof token.resource !== "string" ||
          typeof token.token !== "string"
        )
          throw new HttpError(
            400,
            "SITE_LEASE",
            "사이트 사용 권한을 확인하세요.",
          );
        return { resource: token.resource, token: token.token };
      });
      coordinator = new Store(guard.studioFile);
      assertLease = () => {
        for (const token of tokens)
          if (
            !coordinator?.db
              .prepare(
                "SELECT token FROM resource_leases WHERE resource=? AND token=? AND expires_at>?",
              )
              .get(token.resource, token.token, Date.now())
          )
            throw new HttpError(
              409,
              "LEASE_LOST",
              "사이트 사용 권한이 만료되었습니다. 최신 사이트를 다시 여세요.",
            );
      };
      assertLease();
    }
    const environmentBinding =
      value.environmentBinding === undefined
        ? undefined
        : record(value.environmentBinding);
    site = await startSite(value.directory, project, 0, {
      dataFile: value.dataFile,
      releaseId: value.releaseId,
      readOnly: value.readOnly === true,
      assertLease,
      ...(environmentBinding
        ? {
            environmentBinding: {
              publicOrigin:
                typeof environmentBinding.publicOrigin === "string"
                  ? environmentBinding.publicOrigin
                  : undefined,
              configRevision:
                typeof environmentBinding.configRevision === "number"
                  ? environmentBinding.configRevision
                  : undefined,
              id:
                typeof environmentBinding.id === "string"
                  ? environmentBinding.id
                  : undefined,
              artifactSha256:
                typeof environmentBinding.artifactSha256 === "string"
                  ? environmentBinding.artifactSha256
                  : undefined,
            },
          }
        : {}),
    });
    if (process.env.APP_MODE === "managed")
      setConnectionSecretResolver(
        site.store.db,
        (reference) =>
          /^TENANT_[A-Z0-9_]{1,72}$/.test(reference)
            ? process.env[reference]
            : undefined,
        true,
      );
    process.send?.({
      protocol: 1,
      type: "ready",
      origin: site.origin,
      projectId: project.id,
    });
  })().catch((error: unknown) => {
    process.send?.(
      {
        protocol: 1,
        type: "error",
        code: error instanceof HttpError ? error.code : "SITE_WORKER_FAILED",
        message: "사이트 실행 worker가 준비되지 않았습니다.",
      },
      () => process.exit(1),
    );
  });
});
process.once("disconnect", () => {
  void close().finally(() => process.exit(0));
});
