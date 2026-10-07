import type { ApiEnvelope } from "../domain/types";
let csrf = "";
export async function connect(): Promise<void> {
  const response = await fetch("/api/session", {
    credentials: "same-origin",
    signal: AbortSignal.timeout(10000),
  });
  const envelope = (await response.json()) as ApiEnvelope<{ csrf: string }>;
  if (!response.ok || !envelope.data)
    throw new Error(
      "로컬 저장 서비스에 연결할 수 없습니다. start-site.cmd로 실행하세요.",
    );
  csrf = envelope.data.csrf;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (!csrf) await connect();
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(120000),
  });
  const result = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || result.error || result.data === null)
    throw new Error(result.error?.message ?? "요청을 처리하지 못했습니다.");
  return result.data;
}
