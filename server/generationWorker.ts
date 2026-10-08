import { Store } from "./store";
import { generate } from "./generator";
import { parseProject } from "../src/domain/validation";
import { HttpError } from "./http";
import { workerEnvelope } from "./workerProtocol";
import { beginWorkerUsage } from "./workerUsage";
process.once("disconnect", () => process.exit(1));
process.once("message", (input: unknown) => {
  const meter = beginWorkerUsage();
  void (async () => {
    const value = workerEnvelope(input),
      project = parseProject(value.project);
    for (const key of [
      "sourceRoot",
      "exportRoot",
      "dataFile",
      "studioFile",
      "id",
    ] as const)
      if (typeof value[key] !== "string")
        throw new HttpError(
          400,
          "WORKER_INPUT",
          "생성 worker 입력을 확인하세요.",
        );
    const studio = new Store(String(value.studioFile));
    const assertLease = (): void => {
      if (!process.connected)
        throw new HttpError(
          409,
          "WORKER_DISCONNECTED",
          "worker 연결이 종료되었습니다.",
        );
      if (
        value.leaseToken &&
        !studio.db
          .prepare(
            "SELECT token FROM resource_leases WHERE token=? AND resource=? AND expires_at>?",
          )
          .get(String(value.leaseToken), `generation:${project.id}`, Date.now())
      )
        throw new HttpError(
          409,
          "LEASE_LOST",
          "생성 실행 권한이 만료되었습니다.",
        );
    };
    try {
      assertLease();
      const result = await generate(project, {
        root: String(value.exportRoot),
        sourceRoot: String(value.sourceRoot),
        id: String(value.id),
        dataFile: String(value.dataFile),
        stage: (stage) => {
          assertLease();
          process.send?.({ protocol: 1, type: "stage", stage });
        },
        lifecycle: (event) => {
          assertLease();
          if (event === "before-data-snapshot") {
            const data = new Store(String(value.dataFile));
            try {
              data.pauseProjectWrites(true);
            } finally {
              data.close();
            }
          }
          process.send?.({ protocol: 1, type: "lifecycle", event });
        },
      });
      assertLease();
      process.send?.(
        { protocol: 1, type: "result", result, usage: meter.finish() },
        () => process.exit(0),
      );
    } finally {
      studio.close();
    }
  })().catch((error: unknown) => {
    process.send?.(
      {
        protocol: 1,
        type: "error",
        usage: meter.finish(),
        code: error instanceof HttpError ? error.code : "GENERATION_FAILED",
        message:
          error instanceof HttpError
            ? error.message
            : "생성 worker가 작업을 완료하지 못했습니다.",
      },
      () => process.exit(1),
    );
  });
});
