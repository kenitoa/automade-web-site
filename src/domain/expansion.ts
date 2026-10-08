export const EXPANSION_CAPABILITIES = ["org.manage", "workspace.manage", "project.create", "project.read", "project.edit", "project.publish", "data.read", "data.write", "team.manage", "connection.use", "connection.manage", "secret.rotate", "billing.manage", "asset.manage", "automation.manage", "review.approve", "backup.restore"] as const;
export type ExpansionCapability = typeof EXPANSION_CAPABILITIES[number];
export type OrganizationRole = "owner" | "admin" | "billing" | "member";
export interface ExpansionScope { organizationId: string; workspaceId: string; projectId: string; siteId?: string; environmentId?: string; dataKey?: string }
export interface CreatorIdentity { id: string; csrf: string; sessionId: string }
export interface CreatorAccount { id: string; email: string; displayName: string }
export interface CreatorSession { account: CreatorAccount | null; csrf: string; localOwner: boolean }
export interface Organization { id: string; name: string; createdAt: string; role: OrganizationRole | null }
export interface ExpansionWorkspace { id: string; organizationId: string; name: string; archived: boolean; config: Record<string, unknown>; updatedAt: string }
export interface ExpansionSite { id: string; organizationId: string; workspaceId: string; projectId: string; name: string; mode: "local" | "managed" | "selfhost"; archived: boolean; config: Record<string, unknown>; updatedAt: string }
export interface ExpansionEnvironment { id: string; siteId: string; organizationId: string; workspaceId: string; projectId: string; name: string; kind: "development" | "staging" | "production"; dataKey: string; configVersion: number; config: Record<string, unknown>; updatedAt: string }
export interface ExpansionBootstrap { session: CreatorSession; organizations: Organization[]; workspaces: ExpansionWorkspace[]; sites: ExpansionSite[]; environments: ExpansionEnvironment[]; currentScope: ExpansionScope | null; capabilities: ExpansionCapability[] }
export interface ExpansionMember { account: CreatorAccount; role: OrganizationRole; workspaceGrants: { workspaceId: string; capabilities: ExpansionCapability[] }[]; projectGrants: { projectId: string; capabilities: ExpansionCapability[] }[] }
export interface ExpansionBrand { id: string; organizationId: string; name: string; revision: number; theme: Record<string, unknown>; updatedAt: string; publishedRevision?: number }
export interface ExpansionLibraryItem { id: string; organizationId: string; kind: "component" | "theme" | "pack"; name: string; revision: number; body: unknown; updatedAt: string }
export interface BlobAsset { id: string; organizationId: string; projectId: string; sha256: string; mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; bytes: number; width: number; height: number; alt: string; source: string; license: string; createdAt: string; contentUrl: string; inspection?: import("./advancement").AssetInspection }
export type WorkflowTrigger = "form.submitted" | "order.paid" | "booking.created" | "manual";
export interface WorkflowCondition { field: string; operator: "equals" | "contains" | "greaterThan"; value: string | number | boolean | null }
export type WorkflowAction = { type: "submission.update"; status?: "new" | "processing" | "completed" | "archived"; tags?: string[]; assignee?: string } | { type: "connection.enqueue"; connectionId: string; template: Record<string, string> };
export interface AutomationWorkflow { id: string; scope: ExpansionScope; name: string; trigger: WorkflowTrigger; enabled: boolean; conditions: WorkflowCondition[]; actions: WorkflowAction[]; revision: number; updatedAt: string }
export interface AutomationRun { id: string; workflowId: string; eventKey: string; status: "pending" | "running" | "completed" | "failed"; completedActions: number; errorCode: string | null; createdAt: string; updatedAt: string }
export interface ApiCredential { id: string; name: string; scope: ExpansionScope; capabilities: ExpansionCapability[]; expiresAt: string; revoked: boolean; createdAt: string }
export interface FieldComment { id: string; projectId: string; revision: number; targetPath: string; body: string; authorId: string; resolved: boolean; createdAt: string }
export interface RevisionReview { id: string; scope: ExpansionScope; revision: number; fingerprint: string; status: "pending" | "approved" | "changes_requested"; createdBy: string; decidedBy: string | null; createdAt: string }
export interface PresenceEntry { accountId: string; displayName: string; projectId: string; revision: number; targetPath: string; expiresAt: string }
export interface UsageReservation { id: string; scope: ExpansionScope; metric: string; amount: number; committedAmount: number; key: string; status: "reserved" | "committed" | "released" | "expired"; expiresAt: string; createdAt: string }
export interface PackInstallation { id: string; scope: ExpansionScope; packageId: string; version: string; integrity: string; installedRevision: number; blockIds: string[]; removed: boolean; createdAt: string; updatedAt: string }
export interface ExpansionJobResult { id: string; status: string }
export interface ExpansionJobRequest { kind: string; scope: ExpansionScope; payload: unknown; key: string; actorId?: string }
export type WorkStatus = "waiting" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface WorkItem { id: string; kind: string; scope: ExpansionScope; payload: unknown; actorId?: string; status: WorkStatus; attempts: number; createdAt: number; startedAt: number | null; finishedAt: number | null; result: unknown; errorCode: string | null; cancelRequested: boolean }
export interface ExpansionSecret { id: string; organizationId: string; workspaceId: string | null; name: string; version: number; disabled: boolean; configured: boolean; updatedAt: string }
export interface SecretAuditEntry { id: string; secretId: string; actorId: string; operation: string; status: string; createdAt: string }
export interface ProviderAdapter { id: string; name: string; kind: "mail" | "crm" | "data" | "payment"; version: number; protocol: "generic-json"; mapping: Record<string, string>; updatedAt: string }
export interface UsageBudget { metric: string; period: string; limitAmount: number; used: number }
export interface ExpansionUsage { reservations: UsageReservation[]; budget: UsageBudget[] }
export interface CmsManagementPage { records: import("./types").ContentRecord[]; nextCursor: string | null; total: number; schemaRevision: number; projectRevision: number }
export interface CmsUpsertResult { project: import("./types").Project; record: import("./types").ContentRecord }
export interface ContentTransitionResult { project: import("./types").Project; job?: ExpansionJobResult }
export interface BookingRecurrence { id: string; projectId: string; resourceId: string; name: string; startDate: string; endDate: string; weekdays: number[]; startTime: string; durationMinutes: number; capacity: number; enabled: boolean; createdAt: string;timeZone?:string;disambiguation?:'reject'|'earlier'|'later';gapPolicy?:'reject'|'shift-forward';revision?:number }
export interface BookingHoliday { resourceId: string; date: string; reason: string }
export interface BookingWaitlistEntry { id: string; slotId: string; accountId: string; quantity: number; status: "waiting" | "offered" | "accepted" | "cancelled" | "expired"; offerExpiresAt: number | null; bookingId: string | null; createdAt: string }
export interface OrderFulfillment { orderId: string; projectId: string; status: "unfulfilled" | "processing" | "fulfilled" | "returned"; tracking: string; notes: string; updatedBy: string; updatedAt: string }
