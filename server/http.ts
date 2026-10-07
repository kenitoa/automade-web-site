import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ValidationError } from "../src/domain/validation";
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function reply(
  res: ServerResponse,
  status: number,
  data: unknown,
  error?: { code: string; message: string },
  requestId: string = randomUUID(),
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Request-ID": requestId,
  });
  res.end(
    JSON.stringify({
      data: error ? null : data,
      error: error ? { ...error, requestId } : null,
      meta: { requestId },
    }),
  );
}
export function headers(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
}
export async function body(
  req: IncomingMessage,
  max = 32_000_000,
): Promise<unknown> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
    throw new HttpError(415, "CONTENT_TYPE", "JSON 요청이 필요합니다.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > max)
      throw new HttpError(
        413,
        "BODY_TOO_LARGE",
        "요청 크기가 제한을 초과합니다.",
      );
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "JSON 형식이 올바르지 않습니다.");
  }
}
export function ensureOrigin(
  req: IncomingMessage,
  origin: string,
  write = false,
): void {
  if (req.headers.host !== new URL(origin).host)
    throw new HttpError(403, "HOST", "허용되지 않은 호스트입니다.");
  if (req.headers.origin && req.headers.origin !== origin)
    throw new HttpError(403, "ORIGIN", "다른 출처의 요청은 허용되지 않습니다.");
  if (write && req.headers.origin !== origin)
    throw new HttpError(403, "ORIGIN", "동일한 출처의 요청이 필요합니다.");
  if (req.headers["sec-fetch-site"] === "cross-site")
    throw new HttpError(
      403,
      "ORIGIN",
      "다른 사이트의 요청은 허용되지 않습니다.",
    );
}
export class RateLimit {
  private buckets = new Map<string, { count: number; reset: number }>();
  check(key: string, max = 100, windowMs = 60000): void {
    const now = Date.now();
    if (this.buckets.size > 10000)
      for (const [key, b] of this.buckets)
        if (b.reset < now) this.buckets.delete(key);
    const old = this.buckets.get(key);
    const bucket =
      old && old.reset > now ? old : { count: 0, reset: now + windowMs };
    bucket.count++;
    this.buckets.set(key, bucket);
    if (bucket.count > max)
      throw new HttpError(
        429,
        "RATE_LIMIT",
        "요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
      );
  }
}
export function contained(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};
export async function staticFile(
  root: string,
  pathname: string,
  res: ServerResponse,
  fallback = false,
): Promise<void> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "PATH", "잘못된 경로입니다.");
  }
  if (
    relative.includes("\\") ||
    relative.includes("\0") ||
    relative.split("/").some((x) => x.startsWith("."))
  )
    throw new HttpError(403, "PATH", "허용되지 않은 경로입니다.");
  let target = path.resolve(root, "." + relative);
  if (pathname === "/" || pathname.endsWith("/"))
    target = path.join(target, "index.html");
  if (!contained(root, target))
    throw new HttpError(403, "PATH", "허용되지 않은 경로입니다.");
  try {
    if ((await stat(target)).isDirectory())
      target = path.join(target, "index.html");
    if (!(await stat(target)).isFile()) throw new Error("Not a file");
  } catch {
    if (!fallback)
      throw new HttpError(404, "NOT_FOUND", "파일을 찾을 수 없습니다.");
    target = path.join(root, "index.html");
  }
  const realRoot = await realpath(root),
    realTarget = await realpath(target);
  if (!contained(realRoot, realTarget))
    throw new HttpError(403, "PATH", "허용되지 않은 경로입니다.");
  const content = await readFile(realTarget);
  res.writeHead(200, {
    "Content-Type": mime[path.extname(target)] ?? "application/octet-stream",
    "Cache-Control":
      path.extname(target) === ".html" ? "no-cache" : "public, max-age=3600",
  });
  res.end(content);
}
export function fail(
  res: ServerResponse,
  error: unknown,
  requestId: string,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const candidate = error as { code?: string };
  if (error instanceof HttpError)
    reply(
      res,
      error.status,
      null,
      { code: error.code, message: error.message },
      requestId,
    );
  else if (error instanceof ValidationError)
    reply(
      res,
      400,
      null,
      { code: error.code, message: error.message },
      requestId,
    );
  else if (candidate.code === "CONFLICT")
    reply(
      res,
      409,
      null,
      {
        code: "CONFLICT",
        message:
          error instanceof Error ? error.message : "충돌이 발생했습니다.",
      },
      requestId,
    );
  else {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        service: "automade",
        operation: "request",
        requestId,
        errorCode: "INTERNAL_ERROR",
      }),
    );
    reply(
      res,
      500,
      null,
      {
        code: "INTERNAL_ERROR",
        message: "처리 중 오류가 발생했습니다. 요청 ID로 로그를 확인하세요.",
      },
      requestId,
    );
  }
}
