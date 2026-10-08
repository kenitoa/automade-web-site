import { HttpError } from "./http";
export interface StudioConfig { mode: "local" | "managed"; host: string; publicOrigin: string | null; concurrency: number; workTimeoutMs: number }
export function studioConfig(env: Record<string, string | undefined> = process.env): StudioConfig {
  const mode = env.APP_MODE || "local";
  if (mode !== "local" && mode !== "managed") throw new HttpError(500, "APP_MODE", "APP_MODE는 local 또는 managed입니다. 독립 실행은 생성 결과의 start-site.cmd를 사용하세요.");
  const host = env.STUDIO_HOST || (mode === "managed" ? "0.0.0.0" : "127.0.0.1");
  if (mode === "local" && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new HttpError(500, "LOCAL_BIND", "로컬 제작 도구는 loopback 주소에만 실행할 수 있습니다.");
  let publicOrigin: string | null = null;
  if (mode === "managed") {
    try { const url = new URL(env.STUDIO_PUBLIC_ORIGIN || ""); if (url.protocol !== "https:" || url.username || url.password || url.origin !== env.STUDIO_PUBLIC_ORIGIN) throw new Error("origin"); publicOrigin = url.origin; }
    catch { throw new HttpError(500, "STUDIO_ORIGIN", "관리형 실행에는 정확한 HTTPS STUDIO_PUBLIC_ORIGIN과 TLS 프록시가 필요합니다."); }
  }
  const concurrency = Number(env.WORKER_CONCURRENCY || 2), workTimeoutMs = Number(env.WORKER_TIMEOUT_MS || 180_000);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16 || !Number.isInteger(workTimeoutMs) || workTimeoutMs < 1000 || workTimeoutMs > 900_000) throw new HttpError(500, "WORKER_CONFIG", "worker 동시 실행은 1~16, 제한 시간은 1000~900000ms입니다.");
  return { mode, host, publicOrigin, concurrency, workTimeoutMs };
}
