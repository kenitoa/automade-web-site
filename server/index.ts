import { createServer } from "node:http";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { parseProject, record } from "../src/domain/validation";
import type { ExportResult } from "../src/domain/types";
import {
  body,
  ensureOrigin,
  fail,
  headers,
  HttpError,
  RateLimit,
  reply,
  staticFile,
  contained,
} from "./http";
import { Store } from "./store";
import { generate, verifyAssets } from "./generator";
import {
  generateFromBrief,
  validateGenerationConfig,
} from "./generationAdapter";
import { startSite, type RunningSite } from "./siteServer";
import { sourceArchive } from "./archive";
const sourceRoot = process.env.AUTOMADE_ROOT
  ? path.resolve(process.env.AUTOMADE_ROOT)
  : path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      existsSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "../package.json",
        ),
      )
        ? ".."
        : ".",
    );
if (existsSync(path.join(sourceRoot, ".env")))
  process.loadEnvFile(path.join(sourceRoot, ".env"));
validateGenerationConfig();
const dataRoot = path.resolve(
  process.env.DATA_DIR || path.join(sourceRoot, ".data"),
);
const exportRoot = path.resolve(
  process.env.EXPORT_DIR || path.join(sourceRoot, "exports"),
);
mkdirSync(dataRoot, { recursive: true });
mkdirSync(exportRoot, { recursive: true });
const store = new Store(path.join(dataRoot, "studio.sqlite"));
store.recoverInterrupted();
const rates = new RateLimit();
const sessions = new Map<string, { csrf: string; expires: number }>();
const jobs = new Map<
  string,
  {
    stage: string;
    status: "building" | "ready" | "failed" | "cancelled";
    result?: ExportResult;
    error?: string;
    abort: AbortController;
  }
>();
const sites = new Map<string, RunningSite>();
const requests = new Map<string, { id: string; fingerprint: string }>();
let origin = "";
let vite: ViteDevServer | undefined;
let activeBuilds = 0;
const buildingProjects = new Set<string>();
const dev = process.argv[1]?.endsWith(".ts") ?? false;
const server = createServer((req, res) => {
  const requestId = randomUUID();
  const started = Date.now();
  headers(res);
  void (async () => {
    ensureOrigin(req, origin);
    const url = new URL(req.url ?? "/", origin);
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, "PATH", "Invalid path");
    }
    if (
      decodedPath.includes("\\") ||
      decodedPath.includes("\0") ||
      decodedPath.split("/").includes("..")
    )
      throw new HttpError(403, "PATH", "Invalid path");
    if (url.pathname === "/health") {
      reply(res, 200, {
        service: "automade-studio",
        status: "ok",
        workspaceId: createHash("sha256")
          .update(sourceRoot.toLowerCase())
          .digest("hex")
          .slice(0, 16),
        generatorVersion: "1.0.0",
      });
      return;
    }
    if (url.pathname === "/api/session" && req.method === "GET") {
      rates.check(`session:${req.socket.remoteAddress}`, 100);
      const cookie = String(req.headers.cookie ?? "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("automade-session="))
        ?.slice(17);
      let session = cookie ? sessions.get(cookie) : undefined;
      let token = cookie;
      if (!session || session.expires < Date.now()) {
        token = randomBytes(32).toString("hex");
        session = {
          csrf: randomBytes(32).toString("hex"),
          expires: Date.now() + 8 * 60 * 60 * 1000,
        };
        sessions.set(token, session);
        for (const [key, s] of sessions)
          if (s.expires < Date.now()) sessions.delete(key);
      }
      res.setHeader(
        "Set-Cookie",
        `automade-session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      );
      reply(res, 200, { csrf: session.csrf, role: "local-owner" });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      rates.check(req.socket.remoteAddress ?? "local", 300);
      const cookie = String(req.headers.cookie ?? "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("automade-session="))
        ?.slice(17);
      const session = cookie ? sessions.get(cookie) : undefined;
      if (!session || session.expires < Date.now())
        throw new HttpError(401, "SESSION", "세션을 다시 연결하세요.");
      if (req.method !== "GET") {
        ensureOrigin(req, origin, true);
        const token = String(req.headers["x-csrf-token"] ?? "");
        if (
          token.length !== session.csrf.length ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(session.csrf))
        )
          throw new HttpError(403, "CSRF", "요청 인증에 실패했습니다.");
      }
      if (url.pathname === "/api/projects" && req.method === "GET") {
        reply(res, 200, store.projects());
        return;
      }
      if (url.pathname === "/api/save-project" && req.method === "POST") {
        const raw = record(await body(req));
        const p = parseProject(raw.project ?? raw);
        verifyAssets(p);
        store.save(p);
        reply(res, 200, {
          revision: p.revision,
          projectId: p.id,
          source: "SQLite",
        });
        return;
      }
      if (url.pathname === "/api/projects" && req.method === "PUT") {
        const project = parseProject(await body(req));
        verifyAssets(project);
        store.save(project);
        reply(res, 200, { revision: project.revision });
        return;
      }
      const backup = url.pathname.match(
        /^\/api\/projects\/([a-zA-Z0-9_-]+)\/backups$/,
      );
      if (backup && req.method === "GET") {
        reply(res, 200, store.backups(backup[1]!));
        return;
      }
      if (url.pathname === "/api/generate" && req.method === "POST") {
        rates.check("generate", 5);
        const raw = record(await body(req, 20000));
        if (
          typeof raw.prompt !== "string" ||
          raw.prompt.length > 5000 ||
          !raw.prompt.trim() ||
          typeof raw.name !== "string" ||
          raw.name.length > 200
        )
          throw new HttpError(
            400,
            "BRIEF",
            "사이트 이름과 5000자 이내 요구 내용을 입력하세요.",
          );
        reply(res, 200, await generateFromBrief(raw.prompt, raw.name));
        return;
      }
      if (url.pathname === "/api/exports" && req.method === "POST") {
        rates.check("export", 20);
        const raw = record(await body(req));
        const project = parseProject(raw.project);
        verifyAssets(project);
        const key =
          typeof raw.idempotencyKey === "string" ? raw.idempotencyKey : "";
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key))
          throw new HttpError(
            400,
            "IDEMPOTENCY",
            "올바른 요청 키가 필요합니다.",
          );
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(project))
          .digest("hex");
        const existing = requests.get(`${project.id}:${key}`);
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new HttpError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "동일 요청 키의 프로젝트 내용이 다릅니다.",
            );
          reply(res, 202, { id: existing.id });
          return;
        }
        if (
          activeBuilds >= 2 ||
          sites.size >= 20 ||
          buildingProjects.has(project.id)
        )
          throw new HttpError(
            429,
            "BUILD_LIMIT",
            "동시 생성·실행 한도에 도달했습니다. 실행 중인 사이트를 종료하세요.",
          );
        store.save(project);
        const id = randomUUID(),
          abort = new AbortController();
        const job: {
          stage: string;
          status: "building" | "ready" | "failed" | "cancelled";
          result?: ExportResult;
          error?: string;
          abort: AbortController;
        } = { stage: "프로젝트 검사", status: "building", abort };
        jobs.set(id, job);
        requests.set(`${project.id}:${key}`, { id, fingerprint });
        store.exportStart(id, project.id);
        activeBuilds++;
        buildingProjects.add(project.id);
        const previousSites = [...sites.values()].filter(
          (site) => site.projectId === project.id,
        );
        reply(res, 202, { id });
        void generate(project, {
          root: exportRoot,
          sourceRoot,
          id,
          previousDirectory: store.latestDirectory(project.id),
          stage: (value) => {
            job.stage = value;
            if (value === "데이터 스냅샷 보존")
              previousSites.forEach((site) => site.pauseWrites(true));
          },
          signal: abort.signal,
        })
          .then(async (artifact) => {
            abort.signal.throwIfAborted();
            job.stage = "웹사이트 실행";
            const site = await startSite(artifact.source, project);
            sites.set(id, site);
            const health = await fetch(`${site.origin}/health`, {
              signal: AbortSignal.timeout(5000),
            });
            if (!health.ok) throw new Error("Health failed");
            job.result = { ...artifact, url: site.origin };
            job.status = "ready";
            job.stage = "완료";
            store.exportDone(id, artifact.path);
            store.audit("site.generate", project.id, "success");
          })
          .catch((error) => {
            previousSites.forEach((site) => site.pauseWrites(false));
            const failedSite = sites.get(id);
            if (failedSite) {
              void failedSite.close();
              sites.delete(id);
            }
            job.status = abort.signal.aborted ? "cancelled" : "failed";
            job.error =
              error instanceof HttpError
                ? error.message
                : abort.signal.aborted
                  ? "생성을 취소했습니다."
                  : "생성에 실패했습니다. 원본 프로젝트는 유지됩니다.";
            store.exportDone(
              id,
              "",
              error instanceof HttpError ? error.code : "GENERATION_FAILED",
            );
            console.error(
              JSON.stringify({
                timestamp: new Date().toISOString(),
                level: "error",
                service: "automade",
                requestId,
                operation: "site.generate",
                errorCode:
                  error instanceof HttpError ? error.code : "GENERATION_FAILED",
                artifactId: id,
                stage: job.stage,
                cause: error instanceof Error ? error.name : "unknown",
                diagnostic:
                  error instanceof Error
                    ? error.message
                        .replace(
                          /(?:Bearer|token|key)[=: ]+[^ ]+/gi,
                          "[redacted]",
                        )
                        .slice(0, 500)
                    : "unknown",
              }),
            );
          })
          .finally(() => {
            activeBuilds--;
            buildingProjects.delete(project.id);
            if (jobs.size > 200)
              for (const [oldId, oldJob] of jobs) {
                if (jobs.size <= 200) break;
                if (oldJob.status !== "building" && oldId !== id) {
                  jobs.delete(oldId);
                  for (const [key, request] of requests)
                    if (request.id === oldId) requests.delete(key);
                }
              }
          });
        return;
      }
      const jobRoute = url.pathname.match(
        /^\/api\/exports\/([a-f0-9-]+)(?:\/(cancel|stop|submissions|restart|download))?$/,
      );
      if (jobRoute) {
        const id = jobRoute[1]!,
          operation = jobRoute[2],
          job = jobs.get(id);
        if (operation === "download" && req.method === "GET") {
          const saved = store.exportRecord(id);
          if (
            !saved ||
            saved.status !== "ready" ||
            !contained(exportRoot, saved.directory)
          )
            throw new HttpError(
              404,
              "ARTIFACT_NOT_FOUND",
              "결과물을 찾을 수 없습니다.",
            );
          await sourceArchive(saved.directory, id, res);
          return;
        }
        if (operation === "restart" && req.method === "POST") {
          let site = sites.get(id);
          const saved = store.exportRecord(id);
          if (
            !saved ||
            saved.status !== "ready" ||
            !contained(exportRoot, saved.directory)
          )
            throw new HttpError(
              404,
              "ARTIFACT_NOT_FOUND",
              "완료된 결과물을 찾을 수 없습니다.",
            );
          if (!site) {
            if (sites.size >= 20)
              throw new HttpError(
                429,
                "SITE_LIMIT",
                "실행 중인 사이트를 먼저 종료하세요.",
              );
            const source = path.join(saved.directory, "output");
            const p = parseProject(
              JSON.parse(
                readFileSync(
                  path.join(source, "project.interface.json"),
                  "utf8",
                ),
              ).project,
            );
            site = await startSite(source, p);
            sites.set(id, site);
          }
          reply(res, 200, { url: site.origin });
          return;
        }
        if (operation === "stop" && req.method === "POST") {
          const site = sites.get(id);
          if (site) {
            await site.close();
            sites.delete(id);
          }
          reply(res, 200, { stopped: true });
          return;
        }
        if (operation === "submissions" && req.method === "GET") {
          const site = sites.get(id);
          if (!site)
            throw new HttpError(
              404,
              "SITE_STOPPED",
              "실행 중인 사이트를 선택하세요.",
            );
          const limit = Number(url.searchParams.get("limit") ?? 50),
            offset = Number(url.searchParams.get("offset") ?? 0);
          if (
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100 ||
            !Number.isInteger(offset) ||
            offset < 0
          )
            throw new HttpError(400, "PAGINATION", "조회 범위를 확인하세요.");
          reply(res, 200, site.store.submissions(limit, offset));
          return;
        }
        if (!job)
          throw new HttpError(
            404,
            "JOB_NOT_FOUND",
            "생성 작업을 찾을 수 없습니다.",
          );
        if (operation === "cancel" && req.method === "POST") {
          if (job.status === "building") job.abort.abort();
          reply(res, 200, { status: job.status });
          return;
        }
        if (req.method === "GET") {
          reply(res, 200, {
            stage: job.stage,
            status: job.status,
            result: job.result,
            error: job.error,
          });
          return;
        }
      }
      if (url.pathname === "/api/operations" && req.method === "GET") {
        reply(res, 200, {
          stats: store.stats(),
          jobs: store.exports(),
          running: [...sites].map(([id, site]) => ({ id, url: site.origin })),
          audit: store.audits(),
          generationProvider: process.env.GENERATION_API_URL
            ? "configured"
            : "local-templates",
        });
        return;
      }
      throw new HttpError(404, "NOT_FOUND", "요청한 기능이 없습니다.");
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new HttpError(405, "METHOD", "지원하지 않는 요청입니다.");
    if (vite) {
      vite.middlewares(req, res, () =>
        reply(res, 404, null, {
          code: "NOT_FOUND",
          message: "페이지가 없습니다.",
        }),
      );
      return;
    }
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    await staticFile(path.join(sourceRoot, "dist"), url.pathname, res, true);
  })()
    .catch((error) => fail(res, error, requestId))
    .finally(() => {
      if (req.url?.startsWith("/api/"))
        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "info",
            service: "automade",
            requestId,
            operation: (req.url ?? "").split("?")[0],
            durationMs: Date.now() - started,
            status: res.statusCode,
          }),
        );
    });
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
if (dev) {
  const { createServer } = await import("vite");
  vite = await createServer({
    root: sourceRoot,
    server: {
      middlewareMode: true,
      watch: {
        ignored: [
          exportRoot.replaceAll("\\", "/") + "/**",
          dataRoot.replaceAll("\\", "/") + "/**",
        ],
      },
    },
    appType: "spa",
  });
}
const configured = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(configured) || configured < 0 || configured > 65535)
  throw new Error("PORT must be 0..65535");
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(configured, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
});
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Invalid server address");
origin = `http://127.0.0.1:${address.port}`;
console.log(`AUTOMADE_URL=${origin}`);
const stop = async () => {
  await Promise.all([...sites.values()].map((s) => s.close()));
  await vite?.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
