import { HttpError } from "./http";
import { record } from "../src/domain/validation";

/** Omitted version is the existing protocol 1 envelope; unknown versions never run work. */
export function workerEnvelope(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HttpError(
      400,
      "WORKER_ENVELOPE",
      "worker 메시지 형식을 확인하세요.",
    );
  const value = record(input);
  if (value.protocol !== undefined && value.protocol !== 1)
    throw new HttpError(
      400,
      "WORKER_PROTOCOL",
      "지원하지 않는 worker 메시지 버전입니다.",
    );
  return value;
}
