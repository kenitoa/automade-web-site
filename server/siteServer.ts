import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
declare const AUTOMADE_BUILD_HASH: string | undefined;
declare const AUTOMADE_BUILD_COMMIT: string | null | undefined;
import {
  parseProject,
  parseRows,
  record,
  validateForm,
} from "../src/domain/validation";
import { Store } from "./store";
import {
  body,
  ensureOrigin,
  fail,
  headers,
  HttpError,
  RateLimit,
  reply,
  staticFile,
} from "./http";
import type { Project } from "../src/domain/types";
import { publicProject, memberProject } from "../src/domain/publication";
import { validateTableRows } from "../src/domain/content";
import {
  handlePlatformRequest,
  bootstrapAdmin,
  startPlatformWorker,
  enqueueSubmission,
} from "./platform";
import { authorize, checkCsrf, session } from "./platform/auth";
import { consumeUsage, transaction } from "./platform/common";
import { saveTableWithHistory, tableHistory } from "./tableHistory";
import { parseTableQuery, queryTable } from "./tableQuery";
import { localizedPath, parseLocalizedPath } from "../src/domain/localization";
import { siteBusinessMetric, siteRequestLog } from "./siteObservability";
import { withCmsSnapshot } from "../src/domain/cms";
import { findContent } from "../src/domain/content";
import { html } from "../src/runtime/document";
import { sitemap, sitemapPage, robots } from "../src/domain/seo";
import { externalData, getConnection } from "./platform/connections";
import {
  IndexedContentService,
  applyRuntimeContentSnapshot,
} from "./advancement/content";
export interface RunningSite {
  server: Server;
  store: Store;
  origin: string;
  close: () => Promise<void>;
  projectId: string;
  pauseWrites: (paused: boolean) => void;
  readOnly: boolean;
}
export interface SiteOptions {
  dataFile?: string;
  releaseId?: string;
  readOnly?: boolean;
  assertLease?: () => void;
  environmentBinding?: {
    publicOrigin?: string;
    configRevision?: number;
    id?: string;
    artifactSha256?: string;
    runtimeSchema?: number;
  };
}
function textReleaseId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value))
    throw new Error("Invalid release metadata");
  return value;
}
export async function startSite(
  directory: string,
  project: Project,
  port = 0,
  options: SiteOptions = {},
): Promise<RunningSite> {
  if (options.environmentBinding?.publicOrigin) {
    const configured = new URL(options.environmentBinding.publicOrigin);
    if (
      configured.origin !== options.environmentBinding.publicOrigin ||
      configured.username ||
      configured.password ||
      (configured.protocol !== "https:" &&
        !(
          ["127.0.0.1", "localhost", "[::1]"].includes(configured.hostname) &&
          configured.protocol === "http:"
        ))
    )
      throw new Error("Invalid environment public origin");
    project = {
      ...project,
      settings: { ...project.settings, siteUrl: configured.origin },
    };
  }
  const privateProject = project;
  project = publicProject(project);
  const configuredHost = process.env.SITE_HOST || "127.0.0.1";
  const host = configuredHost === "localhost" ? "127.0.0.1" : configuredHost;
  const externallyBound = !["127.0.0.1", "::1", "localhost"].includes(host);
  const localOperator = !externallyBound && process.env.APP_MODE !== "managed";
  const publicOrigin = process.env.SITE_PUBLIC_ORIGIN;
  if (
    externallyBound &&
    (!publicOrigin ||
      !publicOrigin.startsWith("https://") ||
      !process.env.PLATFORM_ADMIN_EMAIL ||
      !process.env.PLATFORM_ADMIN_PASSWORD)
  )
    throw new Error(
      "Public binding requires HTTPS SITE_PUBLIC_ORIGIN and PLATFORM_ADMIN_EMAIL/PASSWORD",
    );
  if (publicOrigin) {
    const configured = new URL(publicOrigin);
    if (
      configured.origin !== publicOrigin ||
      configured.username ||
      configured.password
    )
      throw new Error("SITE_PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
  if (
    process.env.SITE_DEPLOYMENT_SHA256 &&
    !/^[a-f0-9]{64}$/.test(process.env.SITE_DEPLOYMENT_SHA256)
  )
    throw new Error("SITE_DEPLOYMENT_SHA256 must be a SHA256 hex digest");
  const store = new Store(
    options.dataFile ?? path.join(directory, ".site-data.sqlite"),
  );
  let latest = privateProject,
    cachedCmsRevision: unknown = undefined;
  const contentIndex = new IndexedContentService(store.db, (id) =>
    id === privateProject.id ? latest : null,
  );
  contentIndex.ensureLegacy(privateProject);
  if (process.env.SITE_ACTIVE_RELEASE_ID) {
    if (
      !options.releaseId ||
      process.env.SITE_ACTIVE_RELEASE_ID !== options.releaseId
    ) {
      store.close();
      throw new Error(
        "SITE_ACTIVE_RELEASE_ID must match this artifact release ID",
      );
    }
    store.activateRelease(options.releaseId);
  }
  try {
    await bootstrapAdmin(store.db, project.id);
  } catch (error) {
    store.close();
    throw error;
  }
  const rates = new RateLimit();
  let origin = "";
  let writesPaused = false;
  const assertWritable = (): void => {
    options.assertLease?.();
    if (writesPaused || options.readOnly)
      throw new HttpError(
        409,
        "SITE_REPLACED",
        "읽기 전용 사이트입니다. 최신 사이트를 열어 입력하세요.",
      );
    store.assertWritable(options.releaseId);
  };
  const stopWorker = startPlatformWorker(store.db, () => {
    try {
      assertWritable();
      return true;
    } catch {
      return false;
    }
  });
  const server = createServer((req, res) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    let errorCode: string | null = null;
    res.once("finish", () => {
      const durationMs = Date.now() - startedAt;
      console.log(
        JSON.stringify(
          siteRequestLog({
            rawUrl: req.url ?? "/",
            requestId,
            projectId: project.id,
            method: req.method ?? "GET",
            durationMs,
            status: res.statusCode,
            errorCode,
          }),
        ),
      );
      const metric = siteBusinessMetric(req.url ?? "/", req.method ?? "GET");
      if (metric) {
        try {
          store.operations.measure(
            project.id,
            metric,
            res.statusCode < 400 ? "success" : (errorCode ?? "failed"),
            durationMs,
          );
        } catch {
          console.error(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "error",
              service: "automade-site",
              projectId: project.id,
              requestId,
              operation: "telemetry.write",
              errorCode: "TELEMETRY_WRITE_FAILED",
            }),
          );
        }
      }
    });
    headers(res);
    res.setHeader("X-Request-ID", requestId);
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    void (async () => {
      options.assertLease?.();
      ensureOrigin(req, origin);
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname === "/health") {
        reply(res, 200, {
          service: "automade-site",
          projectId: project.id,
          revision: project.revision,
          releaseId: options.releaseId ?? store.activeRelease(),
          deploymentSha256: process.env.SITE_DEPLOYMENT_SHA256 ?? null,
          buildHash:
            typeof AUTOMADE_BUILD_HASH === "string"
              ? AUTOMADE_BUILD_HASH
              : null,
          buildCommit:
            typeof AUTOMADE_BUILD_COMMIT === "string"
              ? AUTOMADE_BUILD_COMMIT
              : null,
          status: "ok",
        });
        return;
      }
      const cmsRevision = store.db
        .prepare(
          "SELECT json_extract(value,'$.revision') AS revision FROM runtime_state WHERE key='project:cms'",
        )
        .get()?.revision;
      if (cmsRevision !== cachedCmsRevision) {
        const cmsSnapshot = store.operations.state("project:cms");
        latest = withCmsSnapshot(privateProject, cmsSnapshot);
        if (cmsSnapshot)
          applyRuntimeContentSnapshot(store.db, latest, cmsSnapshot);
        cachedCmsRevision = cmsRevision;
      }
      const contentRoute = url.pathname.match(
        /^\/api\/content\/([a-zA-Z0-9_-]+)$/,
      );
      if (contentRoute && req.method === "GET") {
        rates.check(`cms:${req.socket.remoteAddress}`, 120);
        const identity = session(
          store.db,
          req,
          res,
          origin,
          localOperator,
          false,
          project.id,
        );
        const collection = latest.collections?.find(
          (item) => item.id === contentRoute[1],
        );
        if (
          !collection ||
          (collection.access === "members" && !identity.accountId)
        )
          throw new HttpError(
            collection ? 401 : 404,
            collection ? "LOGIN_REQUIRED" : "COLLECTION_NOT_FOUND",
            "콘텐츠를 조회할 권한이 없습니다.",
          );
        reply(
          res,
          200,
          contentIndex.query(project.id, contentRoute[1]!, url.searchParams, {
            member: Boolean(identity.accountId),
          }),
        );
        return;
      }
      const bindingRoute = url.pathname.match(
        /^\/api\/platform\/data\/([a-zA-Z0-9_-]+)\/binding$/,
      );
      if (bindingRoute && req.method === "GET") {
        rates.check(`binding:${req.socket.remoteAddress}`, 60);
        if (
          url.searchParams.get("projectId") &&
          url.searchParams.get("projectId") !== project.id
        )
          throw new HttpError(403, "OWNERSHIP", "다른 사이트의 데이터입니다.");
        const identity = session(
            store.db,
            req,
            res,
            origin,
            localOperator,
            false,
            project.id,
          ),
          accessible = identity.accountId
            ? memberProject(latest)
            : publicProject(latest);
        const bindings = accessible.blocks
          .filter(
            (block) =>
              !block.hidden &&
              block.props.dataBinding?.connectionId === bindingRoute[1] &&
              accessible.pages.some(
                (page) =>
                  page.published &&
                  (block.pageId === "*" || block.pageId === page.id),
              ),
          )
          .map((block) => block.props.dataBinding!);
        if (!bindings.length)
          throw new HttpError(
            404,
            "BINDING_NOT_FOUND",
            "공개 데이터 연결이 없습니다.",
          );
        const connection = getConnection(store.db, bindingRoute[1]!);
        if (connection.projectId !== project.id)
          throw new HttpError(403, "OWNERSHIP", "데이터 연결 범위가 다릅니다.");
        const result = await externalData(store.db, connection.id),
          limit = Number(url.searchParams.get("limit") ?? 20),
          cursor = Number(url.searchParams.get("cursor") ?? 0);
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          !Number.isInteger(cursor) ||
          cursor < 0 ||
          cursor > 1000
        )
          throw new HttpError(
            400,
            "PAGINATION",
            "데이터 조회 범위를 확인하세요.",
          );
        const fields = new Set(
          bindings.flatMap((binding) =>
            Object.values(binding.mapping).filter(
              (value): value is string => typeof value === "string",
            ),
          ),
        );
        const q = url.searchParams.get("q") ?? "";
        if (q.length > 200)
          throw new HttpError(400, "SEARCH", "검색어는 200자 이내입니다.");
        const rows = (Array.isArray(result.rows) ? result.rows : [])
          .map((row) =>
            Object.fromEntries(
              Object.entries(record(row)).filter(([key]) => fields.has(key)),
            ),
          )
          .filter(
            (row) =>
              !q ||
              Object.values(row)
                .join(" ")
                .toLocaleLowerCase()
                .includes(q.toLocaleLowerCase()),
          );
        const mapped = rows.slice(cursor, cursor + limit);
        reply(res, 200, {
          rows: mapped,
          nextCursor:
            cursor + limit < rows.length ? String(cursor + limit) : null,
          fetchedAt: result.fetchedAt,
          cached: result.cached,
        });
        return;
      }
      if (
        await handlePlatformRequest(req, res, url, {
          db: store.db,
          requestId,
          projectId: project.id,
          localOwner: localOperator,
          origin,
          assertWritable,
          memberProject: () => memberProject(latest),
        })
      )
        return;
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") assertWritable();
        rates.check(req.socket.remoteAddress ?? "local", 120);
        ensureOrigin(req, origin, req.method !== "GET");
        const parts = url.pathname.split("/");
        const kind = parts[2],
          blockId = parts[3];
        const identity = session(
          store.db,
          req,
          res,
          origin,
          localOperator,
          false,
          project.id,
        );
        const accessibleProject = identity.accountId
          ? memberProject(privateProject)
          : project;
        const block = accessibleProject.blocks.find(
          (x) =>
            x.id === blockId &&
            !x.hidden &&
            accessibleProject.pages.some(
              (p) => (p.id === x.pageId || x.pageId === "*") && p.published,
            ),
        );
        if (!block || block.props.dataSource !== "local")
          throw new HttpError(404, "BLOCK_NOT_FOUND", "저장 대상이 없습니다.");
        if (
          kind === "forms" &&
          block.type === "form" &&
          req.method === "POST"
        ) {
          rates.check(`form:${req.socket.remoteAddress}`, 20);
          const value = record(await body(req, 100000));
          const key = value.idempotencyKey;
          if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(key))
            throw new HttpError(
              400,
              "IDEMPOTENCY",
              "올바른 요청 키가 필요합니다.",
            );
          const result = validateForm(
            block.props.fields,
            value.values,
            block.props.formSettings,
          );
          if (Object.keys(result.errors).length)
            throw new HttpError(
              400,
              "VALIDATION",
              Object.values(result.errors).join(" "),
            );
          const submission = transaction(store.db, () => {
            assertWritable();
            const prior = store.db
              .prepare(
                "SELECT id FROM submissions WHERE block_id=? AND idempotency_key=?",
              )
              .get(block.id, key);
            if (!prior) consumeUsage(store.db, project.id, "submissions");
            const saved = store.submit(block.id, key, result.values);
            enqueueSubmission(store.db, project.id, {
              id: saved.id,
              blockId: block.id,
              values: result.values,
            });
            return saved;
          });
          reply(res, 201, submission);
          return;
        }
        if (kind === "tables" && block.type === "table") {
          if (parts[4] === "history" && req.method === "GET") {
            authorize(store.db, identity, project.id, ["operator"]);
            reply(
              res,
              200,
              tableHistory(
                store.db,
                block.id,
                block.props.columns.length,
                Number(url.searchParams.get("limit") ?? 10),
                Number(
                  url.searchParams.get("beforeVersion") ??
                    Number.MAX_SAFE_INTEGER,
                ),
              ),
            );
            return;
          }
          if (req.method === "GET") {
            const table = store.table(
              block.id,
              block.props.rows,
              block.props.columns.length,
            );
            const query = parseTableQuery(url, block.props.columns);
            reply(
              res,
              200,
              query
                ? {
                    version: table.version,
                    ...queryTable(table.rows, block.props.columns, query),
                  }
                : table,
            );
            return;
          }
          if (req.method === "PUT") {
            if (!localOperator) {
              const identity = session(
                store.db,
                req,
                res,
                origin,
                false,
                false,
                project.id,
              );
              authorize(store.db, identity, project.id, ["operator"]);
              checkCsrf(req, identity);
            }
            const value = record(await body(req, 5_000_000));
            if (
              typeof value.expectedVersion !== "number" ||
              !Number.isSafeInteger(value.expectedVersion) ||
              value.expectedVersion < 0
            )
              throw new HttpError(400, "VERSION", "데이터 버전을 확인하세요.");
            const rows = parseRows(value.rows, block.props.columns.length);
            const tableErrors = validateTableRows(
              block.props.columns,
              rows,
              store.table(
                block.id,
                block.props.rows,
                block.props.columns.length,
              ).rows,
            );
            if (tableErrors.length)
              throw new HttpError(
                400,
                "TABLE_VALIDATION",
                tableErrors.map((issue) => issue.message).join(" "),
              );
            for (const row of rows)
              for (const [i, column] of block.props.columns.entries()) {
                const cell = row.values[i] ?? "";
                if (
                  column.type === "number" &&
                  cell &&
                  !Number.isFinite(Number(cell))
                )
                  throw new HttpError(
                    400,
                    "TABLE_VALUE",
                    "숫자 열에는 숫자를 입력하세요.",
                  );
                if (
                  column.type === "date" &&
                  cell &&
                  Number.isNaN(Date.parse(cell))
                )
                  throw new HttpError(
                    400,
                    "TABLE_VALUE",
                    "날짜 열 형식을 확인하세요.",
                  );
              }
            assertWritable();
            reply(res, 200, {
              // Recheck after asynchronous body reading so a replacement cannot write through an old lease.
              version: saveTableWithHistory(
                store.db,
                block.id,
                block.props.columns,
                block.props.rows,
                rows,
                value.expectedVersion,
                identity.accountId ?? "local-owner",
                assertWritable,
              ),
            });
            return;
          }
        }
        throw new HttpError(405, "METHOD", "지원하지 않는 요청입니다.");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new HttpError(405, "METHOD", "지원하지 않는 요청입니다.");
      const sitemapPart = url.pathname.match(/^\/sitemaps\/([0-9]+)\.xml$/);
      if (
        url.pathname === "/sitemap.xml" ||
        url.pathname === "/robots.txt" ||
        sitemapPart
      ) {
        rates.check(`seo:${req.socket.remoteAddress}`, 60);
        let content: string;
        try {
          const routeProject = contentIndex.routeSnapshot(latest);
          content =
            url.pathname === "/robots.txt"
              ? robots(latest)
              : sitemapPart
                ? sitemapPage(routeProject, Number(sitemapPart[1]))
                : sitemap(routeProject);
        } catch (error) {
          if (error instanceof RangeError)
            throw new HttpError(
              404,
              "SITEMAP_NOT_FOUND",
              "사이트맵 페이지가 없습니다.",
            );
          throw error;
        }
        res.writeHead(200, {
          "Content-Type":
            url.pathname === "/robots.txt"
              ? "text/plain; charset=utf-8"
              : "application/xml; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : content);
        return;
      }
      const localized = parseLocalizedPath(privateProject, url.pathname);
      const identity = session(
        store.db,
        req,
        res,
        origin,
        localOperator,
        false,
        project.id,
      );
      let address: ReturnType<IndexedContentService["address"]>;
      try {
        address = contentIndex.address(
          project.id,
          url.pathname.replace(/\/$/, "") || "/",
          localized.language,
          Boolean(identity.accountId),
        );
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== "LOGIN_REQUIRED")
          throw error;
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          req.method === "HEAD"
            ? undefined
            : html(
                latest,
                latest.pages.find((page) => page.published)?.id,
                localized.path,
                localized.language,
              ),
        );
        return;
      }
      if (address) {
        if (address.redirect) {
          res.writeHead(308, {
            Location: `${address.path}${url.search}`,
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
        const renderProject = contentIndex.renderSnapshot(latest, address);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          req.method === "HEAD"
            ? undefined
            : html(
                renderProject,
                latest.pages.find((page) => page.published)?.id,
                localized.path,
                localized.language,
              ),
        );
        return;
      }
      const detail = findContent(latest, localized.path);
      if (detail) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          html(
            latest,
            latest.pages.find((page) => page.published)?.id,
            localized.path,
            localized.language,
          ),
        );
        return;
      }
      const alias = privateProject.pages.find(
        (page) => page.published && page.aliases?.includes(localized.path),
      );
      if (alias) {
        res.writeHead(308, {
          Location: `${localizedPath(privateProject, alias.path, localized.language)}${url.search}`,
        });
        res.end();
        return;
      }
      const declaredPage = latest.pages.find(
        (page) => page.published && page.path === localized.path,
      );
      if (declaredPage) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          req.method === "HEAD"
            ? undefined
            : html(
                contentIndex.renderSnapshot(latest),
                declaredPage.id,
                undefined,
                localized.language,
              ),
        );
        return;
      }
      await staticFile(path.join(directory, "dist"), url.pathname, res, false);
    })().catch((error: unknown) => {
      errorCode = error instanceof HttpError ? error.code : "INTERNAL";
      fail(res, error, requestId);
    });
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await stopWorker();
    store.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("사이트 주소 확인 실패");
  origin = externallyBound
    ? publicOrigin!
    : `http://${host === "::1" ? "[::1]" : "127.0.0.1"}:${address.port}`;
  return {
    server,
    store,
    origin,
    projectId: project.id,
    get readOnly() {
      try {
        assertWritable();
        return false;
      } catch {
        return true;
      }
    },
    pauseWrites: (paused: boolean) => {
      writesPaused = paused;
    },
    close: async () => {
      await stopWorker();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => {
          store.close();
          if (error) reject(error);
          else resolve();
        }),
      );
    },
  };
}
if (process.argv.includes("--standalone")) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const { verifyArtifactIntegrity } = await import("./artifactIntegrity");
  const { verifyDeploymentIntegrity } = await import("./deploymentIntegrity");
  const integrity = existsSync(path.join(directory, "artifact.contract.json"))
    ? await verifyArtifactIntegrity(directory)
    : await verifyDeploymentIntegrity(directory, {
        buildHash:
          typeof AUTOMADE_BUILD_HASH === "string" ? AUTOMADE_BUILD_HASH : null,
        buildCommit:
          typeof AUTOMADE_BUILD_COMMIT === "string"
            ? AUTOMADE_BUILD_COMMIT
            : null,
      });
  if (!integrity.supported)
    throw new Error(
      `Artifact verification failed: ${integrity.errors.join("; ")}`,
    );
  const raw = record(
    JSON.parse(
      readFileSync(path.join(directory, "project.interface.json"), "utf8"),
    ) as unknown,
  );
  const project = parseProject(raw.project ?? raw);
  let releaseId: string | undefined;
  try {
    releaseId = textReleaseId(
      record(
        JSON.parse(
          readFileSync(path.join(directory, ".release.json"), "utf8"),
        ) as unknown,
      ).id,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const configuredPort = Number(process.env.SITE_PORT ?? 0);
  if (
    !Number.isInteger(configuredPort) ||
    configuredPort < 0 ||
    configuredPort > 65535
  )
    throw new Error("SITE_PORT must be 0..65535");
  const site = await startSite(directory, project, configuredPort, {
    releaseId,
    ...(process.env.SITE_DATA_FILE
      ? { dataFile: path.resolve(process.env.SITE_DATA_FILE) }
      : {}),
  });
  console.log(
    `\n웹사이트가 실행되었습니다: ${site.origin}\n브라우저가 열리지 않으면 위 주소를 입력하세요.\n종료: Ctrl+C\n`,
  );
  if (process.argv.includes("--open")) {
    const { spawn } = await import("node:child_process");
    const command =
      process.platform === "win32"
        ? "powershell.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    const args =
      process.platform === "win32"
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            `Start-Process '${site.origin}'`,
          ]
        : [site.origin];
    await new Promise<void>((resolve) => {
      const child = spawn(command, args, {
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => {
        console.error(`브라우저 실행 실패. 직접 열기: ${site.origin}`);
        resolve();
      });
      child.once("exit", (code) => {
        if (code)
          console.error(`브라우저 실행 실패. 직접 열기: ${site.origin}`);
        resolve();
      });
    });
  }
  const stop = () => {
    void site.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
