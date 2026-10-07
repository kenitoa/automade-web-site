import { useRef, useState } from "react";
import type { ExportResult, Project } from "../domain/types";
import { parseProject } from "../domain/validation";
import { uid } from "../domain/catalog";
import { persistProject } from "../infrastructure/library";
import { api } from "../infrastructure/api";
import { errorText, type StudioState } from "./useStudio";
export interface Operations {
  stats: Record<string, number>;
  jobs: Array<{ id: string; status: string; created_at: string }>;
  running: Array<{ id: string; url: string }>;
  generationProvider: string;
}
interface Job {
  stage: string;
  status: "building" | "ready" | "failed" | "cancelled";
  result?: ExportResult;
  error?: string;
}
export function useGeneration(studio: StudioState) {
  const [busy, setBusy] = useState(false),
    [job, setJob] = useState<Job | null>(null),
    [result, setResult] = useState<ExportResult | null>(null),
    [operations, setOperations] = useState<Operations | null>(null),
    [submissions, setSubmissions] = useState<unknown[]>([]);
  const jobId = useRef<string | null>(null);
  const lastProject = useRef<Project | null>(null);
  const refresh = async () => {
    try {
      setOperations(await api<Operations>("/api/operations"));
    } catch (error) {
      studio.setMessage(errorText(error));
    }
  };
  const oneClick = async () => {
    if (busy) return;
    if (studio.issues.some((i) => i.severity === "error")) {
      studio.setPanel("quality");
      studio.setMessage(
        "생성 전에 오류를 수정하세요. 오류를 누르면 해당 위치로 이동합니다.",
      );
      return;
    }
    const popup = window.open("about:blank", "_blank");
    if (popup) {
      popup.opener = null;
      popup.document.body.textContent =
        "사이트를 생성하고 있습니다. 완료되면 자동으로 열립니다.";
    }
    setBusy(true);
    setJob({ stage: "프로젝트 검사", status: "building" });
    studio.setMessage("");
    try {
      const snapshot = parseProject(studio.project);
      await persistProject(snapshot);
      const response = await api<{ id: string }>("/api/exports", "POST", {
        project: snapshot,
        idempotencyKey: uid(),
      });
      jobId.current = response.id;
      let finished = false;
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const current = await api<Job>(`/api/exports/${response.id}`);
        setJob(current);
        if (current.status === "ready" && current.result) {
          finished = true;
          setResult(current.result);
          lastProject.current = snapshot;
          if (popup && !popup.closed) popup.location.href = current.result.url;
          studio.setMessage("웹사이트 생성과 실행이 완료되었습니다.");
          studio.setPanel("output");
          break;
        }
        if (current.status === "failed" || current.status === "cancelled")
          throw new Error(current.error || "사이트 생성이 중단되었습니다.");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!finished)
        throw new Error(
          "생성이 계속 진행 중일 수 있습니다. 운영 패널에서 상태를 확인하세요.",
        );
    } catch (error) {
      studio.setMessage(errorText(error));
      if (popup && !popup.closed)
        popup.document.body.textContent = `사이트를 열지 못했습니다. ${errorText(error)} 편집기의 품질 검사와 작업 상태를 확인하세요.`;
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const cancel = () => {
    if (jobId.current)
      void api(`/api/exports/${jobId.current}/cancel`, "POST").catch((error) =>
        studio.setMessage(errorText(error)),
      );
  };
  const stop = async (id: string) => {
    try {
      await api(`/api/exports/${id}/stop`, "POST");
      await refresh();
    } catch (error) {
      studio.setMessage(errorText(error));
    }
  };
  const restart = async (id: string) => {
    try {
      const response = await api<{ url: string }>(
        "/api/exports/" + id + "/restart",
        "POST",
      );
      studio.setMessage("사이트가 다시 실행되었습니다: " + response.url);
      await refresh();
    } catch (error) {
      studio.setMessage(errorText(error));
    }
  };
  const loadSubmissions = async (id: string) => {
    try {
      setSubmissions(await api<unknown[]>(`/api/exports/${id}/submissions`));
    } catch (error) {
      studio.setMessage(errorText(error));
    }
  };
  const stale = Boolean(
    result &&
    (lastProject.current?.id !== studio.project.id ||
      lastProject.current?.revision !== studio.project.revision),
  );
  return {
    busy,
    job,
    result,
    operations,
    submissions,
    refresh,
    oneClick,
    cancel,
    stop,
    loadSubmissions,
    restart,
    stale,
  };
}
export type GenerationState = ReturnType<typeof useGeneration>;
