export type JobStatus = "building" | "ready" | "failed" | "cancelled";
export type SubmissionStatus = "new" | "processing" | "completed" | "archived";
export interface OperationMetric { operation: string; status: string; count: number; avgDurationMs: number; lastMeasuredAt: string }
export interface SubmissionEntry {
  id: string;
  block_id: string;
  created_at: string;
  values: Record<string, string>;
  status: SubmissionStatus;
  tags: string[];
  note: string;
  assignee: string;
  updatedAt: string;
}
export interface SubmissionPage { items: SubmissionEntry[]; total: number; limit: number; offset: number }
export interface DataBackup {
  id: string; projectId: string; releaseId: string | null; createdAt: string;
  bytes: number; reason: string; submissions: number; tables: number;
}
export interface RetentionPolicy {
  backupDays: number; artifactDays: number; auditDays: number;
  submissionDays: number; maxStorageMB: number; automaticCleanup: boolean;
}
export interface ReleaseSummary {
  id: string; project_id: string; status: JobStatus; created_at: string;
  revision: number; active: boolean; running: boolean; url: string | null;
  directory: string; stage: string; error_code: string | null;
}
export interface SiteSummary {
  projectId: string; name: string; activeReleaseId: string | null;
  revision: number | null; url: string | null; submissions: number; pending: number;
  tables: number; bytes: number; latestBackup: DataBackup | null;
  measuredAt: string; error: string | null;
}
