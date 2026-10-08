import type { ContentMigrationPlan } from "../domain/contentContracts";
import { parseCmsSchema } from "../domain/cms";
import { record } from "../domain/validation";

export interface CmsMigrationReceipt {
  plan: ContentMigrationPlan;
  reviewRevision: number;
}

/** A local handle to server candidates, never record bodies or converted values. */
export function readCmsMigrationReceipt(
  key: string,
): CmsMigrationReceipt | null {
  const saved = localStorage.getItem(key);
  if (!saved) return null;
  const item = record(JSON.parse(saved)),
    plan = record(item.plan);
  if (
    typeof plan.id !== "string" ||
    plan.id.length > 100 ||
    typeof plan.collectionId !== "string" ||
    !Number.isInteger(plan.sourceSchemaRevision) ||
    !Number.isInteger(item.reviewRevision) ||
    !Number.isInteger(plan.processed) ||
    !Number.isInteger(plan.changes) ||
    !["preview", "running", "complete"].includes(String(plan.state))
  )
    throw new Error("기기에 보관한 콘텐츠 이전 작업 정보를 확인하세요.");
  return {
    reviewRevision: item.reviewRevision as number,
    plan: {
      id: plan.id,
      collectionId: plan.collectionId,
      sourceSchemaRevision: plan.sourceSchemaRevision as number,
      targetSchema: parseCmsSchema(plan.targetSchema),
      state: plan.state as "preview" | "running" | "complete",
      checkpoint: "",
      processed: plan.processed as number,
      changes: plan.changes as number,
      errors: [],
    },
  };
}

export function saveCmsMigrationReceipt(
  key: string,
  receipt: CmsMigrationReceipt,
): void {
  const { plan, reviewRevision } = receipt;
  localStorage.setItem(
    key,
    JSON.stringify({
      reviewRevision,
      plan: {
        id: plan.id,
        collectionId: plan.collectionId,
        sourceSchemaRevision: plan.sourceSchemaRevision,
        targetSchema: plan.targetSchema,
        state: plan.state,
        processed: plan.processed,
        changes: plan.changes,
      },
    }),
  );
}

export function clearCmsMigrationReceipt(key: string): void {
  localStorage.removeItem(key);
}
