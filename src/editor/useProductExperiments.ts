import { useEffect, useState } from "react";
import type { Experiment } from "../domain/systemRuntime";
import { api } from "../infrastructure/api";
import { systemEndpoint } from "./useSystemActions";
import type { ExpansionState } from "./useExpansion";
import type { StudioState } from "./useStudio";
interface Outcome {
  projectId: string;
  environmentId?: string;
  eventId: string;
  metric: Experiment["metric"];
  value?: number;
  failed?: boolean;
}
export function reportProductOutcome(outcome: Outcome): void {
  window.dispatchEvent(
    new CustomEvent("automade:outcome", { detail: outcome }),
  );
}
export function useProductExperiments(s: StudioState, x: ExpansionState) {
  const [variant, setVariant] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    setError("");
    setVariant("");
    if (!x.scope) return;
    let active = true;
    let loadSequence = 0;
    const assignments: {
      experiment: Experiment;
      assignmentId: string;
      variant: string;
    }[] = [];
    const endpoint = (path: string) =>
      systemEndpoint(`runtime/${path}`, s.project.id, x.environmentId);
    async function load() {
      const request = ++loadSequence;
      try {
        const experiments = await api<Experiment[]>(endpoint("experiments"));
        if (!active || request !== loadSequence) return;
        assignments.length = 0;
        if (active) setVariant("");
        for (const experiment of experiments.filter(
          (item) => item.status === "running",
        )) {
          const unitId =
            experiment.unit === "workspace"
              ? x.scope!.workspaceId
              : x.session.account?.id ||
                (x.session.localOwner ? "local-owner" : undefined);
          if (!unitId) continue;
          const result = await api<{ assignmentId: string; variant: string }>(
            endpoint(`experiments/${experiment.id}/assignment`),
            "POST",
            { unitId },
          );
          if (!active || request !== loadSequence) return;
          assignments.push({ experiment, ...result });
          if (
            experiment.metric === "task-completed" &&
            assignments.filter(
              (item) => item.experiment.metric === "task-completed",
            ).length === 1
          )
            setVariant(result.variant);
        }
        if (active && request === loadSequence) setError("");
      } catch (e) {
        if (active && request === loadSequence)
          setError(
            e instanceof Error ? e.message : "실험 상태를 확인하지 못했습니다.",
          );
      }
    }
    const outcome = (event: Event) => {
      const detail = (event as CustomEvent<Outcome>).detail;
      if (
        !detail ||
        detail.projectId !== s.project.id ||
        (detail.environmentId || "") !== x.environmentId
      )
        return;
      for (const assignment of assignments)
        if (assignment.experiment.metric === detail.metric)
          void api(
            endpoint(`experiments/${assignment.experiment.id}/events`),
            "POST",
            {
              assignmentId: assignment.assignmentId,
              eventId: `${assignment.experiment.id}:${detail.eventId}`,
              metric: detail.metric,
              value: detail.value ?? 1,
              failed: detail.failed === true,
            },
          ).catch((e) => {
            if (active)
              setError(
                e instanceof Error
                  ? e.message
                  : "실험 결과 전송을 확인하지 못했습니다.",
              );
          });
    };
    void load();
    window.addEventListener("automade:outcome", outcome);
    const changed = () => void load();
    window.addEventListener("automade:experiments", changed);
    return () => {
      active = false;
      window.removeEventListener("automade:outcome", outcome);
      window.removeEventListener("automade:experiments", changed);
    };
  }, [
    s.project.id,
    x.environmentId,
    x.scope?.workspaceId,
    x.session.account?.id,
  ]);
  return { variant, error };
}
