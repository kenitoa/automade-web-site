import type {
  CmsFieldDefinition,
  ContentRecord,
  ContentWorkflow,
  Project,
} from "./types";
import type { ExpansionCapability, ExpansionScope } from "./expansion";

export interface TranslationReview {
  sourceRevision: number;
  sourceFieldHashes: Record<string, string>;
  changedFields: string[];
  state: "draft" | "review" | "approved" | "stale";
  assignee?: string;
  reviewer?: string;
  glossaryVersion?: number;
}
export interface ContentPublication {
  revision: number;
  sequence: number;
  publishedAt: string;
  schemaRevision: number;
  schema: CmsFieldDefinition[];
  record: Omit<
    ContentRecord,
    | "publication"
    | "translationReviews"
    | "fieldRevisions"
    | "languageRevisions"
  >;
}
export interface ContentRecordResult {
  record: ContentRecord;
  recordRevision: number;
  publishedRevision: number | null;
  publicationSequence: number;
  fieldRevisions: Record<string, number>;
  languageRevisions: Record<string, number>;
  translations: Record<string, TranslationReview>;
}
export interface ContentPage {
  records: ContentRecord[];
  nextCursor: string | null;
  total: number;
  collectionRevision: number;
  schemaRevision: number;
}
export interface ContentUpsert {
  record: ContentRecord;
  expectedRevision: number;
  commandId: string;
}
export interface ContentTransition {
  state: ContentWorkflow["state"] | "unpublish" | "restore";
  expectedRevision: number;
  commandId: string;
  publishAt?: string;
  publicationRevision?: number;
}
export interface ContentEvent {
  id: string;
  scope: ExpansionScope;
  kind: "content.snapshot";
  sequence: number;
  payload: { revision: number; collections: Project["collections"] };
  actorId: string;
}
export interface ContentContext {
  scope: ExpansionScope;
  actorId: string;
  authorize: (capability: ExpansionCapability) => void;
  assertCurrent?: () => void;
  /** Recheck the persisted approver's current permission before activating an approved revision. */
  assertApprover?: (actorId: string) => void;
  /** Must perform synchronous SQL in this service's current transaction, never network delivery. */
  emit?: (event: ContentEvent) => void;
}
export interface ContentQueryOptions {
  member: boolean;
  manage?: boolean;
  view?: "draft" | "published";
}
export interface ContentMigrationPlan {
  id: string;
  collectionId: string;
  sourceSchemaRevision: number;
  sourceCollectionRevision?: number;
  sourceSchema?: CmsFieldDefinition[];
  preview?: {
    records: number;
    changes: number;
    invalidRecords: number;
    errors: { recordId: string; errors: string[] }[];
  };
  targetSchema: CmsFieldDefinition[];
  state: "preview" | "running" | "blocked" | "complete" | "cancelled";
  checkpoint: string;
  processed: number;
  errors: { recordId: string; errors: string[] }[];
  changes: number;
}
