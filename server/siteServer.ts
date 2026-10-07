import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
import { publicProject } from "../src/domain/publication";
export interface RunningSite {
  server: Server;
  store: Store;
  origin: string;
  close: () => Promise<void>;
  projectId: string;
  pauseWrites: (paused: boolean) => void;
}
export async function startSite(
  directory: string,
  project: Project,
  port = 0,
): Promise<RunningSite> {
  project = publicProject(project);
  const store = new Store(path.join(directory, ".site-data.sqlite"));
  const rates = new RateLimit();
  let origin = "";
  let writesPaused = false;
  const server = createServer((req, res) => {
    const requestId = randomUUID();
    headers(res);
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    void (async () => {
      ensureOrigin(req, origin);
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname === "/health") {
        reply(res, 200, { service: "automade-site", projectId: project.id });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (writesPaused && req.method !== "GET")
          throw new HttpError(
            409,
            "SITE_REPLACED",
            "이 사이트의 새 버전이 준비되었습니다. 최신 사이트를 열어 입력하세요.",
          );
        rates.check(req.socket.remoteAddress ?? "local", 120);
        ensureOrigin(req, origin, req.method !== "GET");
        const parts = url.pathname.split("/");
        const kind = parts[2],
          blockId = parts[3];
        const block = project.blocks.find(
          (x) =>
            x.id === blockId &&
            !x.hidden &&
            project.pages.some(
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
          const result = validateForm(block.props.fields, value.values);
          if (Object.keys(result.errors).length)
            throw new HttpError(
              400,
              "VALIDATION",
              Object.values(result.errors).join(" "),
            );
          reply(res, 201, store.submit(block.id, key, result.values));
          return;
        }
        if (kind === "tables" && block.type === "table") {
          if (req.method === "GET") {
            reply(
              res,
              200,
              store.table(
                block.id,
                block.props.rows,
                block.props.columns.length,
              ),
            );
            return;
          }
          if (req.method === "PUT") {
            const value = record(await body(req, 5_000_000));
            if (
              typeof value.expectedVersion !== "number" ||
              !Number.isSafeInteger(value.expectedVersion) ||
              value.expectedVersion < 0
            )
              throw new HttpError(400, "VERSION", "데이터 버전을 확인하세요.");
            const rows = parseRows(value.rows, block.props.columns.length);
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
            reply(res, 200, {
              version: store.saveTable(block.id, rows, value.expectedVersion),
            });
            return;
          }
        }
        throw new HttpError(405, "METHOD", "지원하지 않는 요청입니다.");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new HttpError(405, "METHOD", "지원하지 않는 요청입니다.");
      await staticFile(path.join(directory, "dist"), url.pathname, res, false);
    })().catch((error) => fail(res, error, requestId));
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("사이트 주소 확인 실패");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    store,
    origin,
    projectId: project.id,
    pauseWrites: (paused: boolean) => {
      writesPaused = paused;
    },
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => {
          store.close();
          if (error) reject(error);
          else resolve();
        }),
      ),
  };
}
if (process.argv.includes("--standalone")) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const raw = record(
    JSON.parse(
      readFileSync(path.join(directory, "project.interface.json"), "utf8"),
    ) as unknown,
  );
  const project = parseProject(raw.project ?? raw);
  const site = await startSite(directory, project);
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
