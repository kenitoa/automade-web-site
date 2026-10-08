import { api } from "./api";
export type StudioOperation =
  | "project.start"
  | "site.first-run"
  | "quality.resolve"
  | "preview.mobile"
  | "form.submit"
  | "site.publish";
export async function trackStudioEvent(
  projectId: string,
  operation: StudioOperation,
  durationMs = 0,
  status: "success" | "failed" = "success",
): Promise<boolean> {
  try {
    await api("/api/telemetry", "POST", {
      projectId,
      operation,
      durationMs: Math.max(0, Math.round(durationMs)),
      status,
    });
    return true;
  } catch {
    console.warn(`이용 지표를 전송하지 못했습니다: ${operation}`);
    return false;
  }
}
