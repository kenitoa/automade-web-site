import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { CreatorIdentity, ExpansionBootstrap, ExpansionCapability, ExpansionJobResult, ExpansionScope } from "../../src/domain/expansion";
import type { Project } from "../../src/domain/types";
import { parseProject, record } from "../../src/domain/validation";
import { body, HttpError, reply } from "../http";
import { audit, boolean, hash, integer, many, now, one, text } from "../platform/common";
import { enqueue, setConnectionSecretResolver, startPlatformWorker, validateEndpoint } from "../platform/connections";
import type { Store } from "../store";
import { ExpansionAccess } from "./access";
import { CreatorAuth } from "./auth";
import { OrganizationService } from "./organizations";
import { actorId } from "./access";
import { LibraryService } from "./library";
import { BlobService } from "./blobs";
import { SecretService } from "./secrets";
import { CredentialService } from "./credentials";
import { AdapterService } from "./adapters";
import { WorkflowService, WORKFLOW_TRIGGERS } from "./workflows";
import { contentFingerprint, ReviewService } from "./reviews";
import { PackService } from "./packs";
import { UsageService } from "./usage";
import { BookingExpansion } from "./bookings";
import { queryCollection } from "../../src/domain/cms";
import { ContentService } from "./content";
import type { WorkflowTrigger } from "../../src/domain/expansion";
import { bindOperation } from "../operationContext";
import { CatalogService } from "../advancement/catalog";
import { IndexedContentService } from "../advancement/content";
import { enqueueSystemEvent } from "../systemDelivery";

export interface ExpansionOptions {
  mode?: "local" | "managed";
  dataRoot: string;
  siteData: (scope: ExpansionScope) => Promise<Store>;
  enqueueJob: (kind: string, scope: ExpansionScope, payload: unknown, key: string, actorId?: string, options?: { notBefore?: number; recovery?: "retry" | "manual" }) => Promise<ExpansionJobResult>;
  assertJobLease?: () => void;
}
export interface ExpansionRequestContext { requestId: string; localOwner: boolean; trustedCsrf?: boolean; origin: string; creator?: CreatorIdentity | null }
export class ExpansionService {
  assertAdvancementRequest:(req:IncomingMessage,url:URL,context:{creator:CreatorIdentity|null;localOwner:boolean;scope?:ExpansionScope|null;input?:unknown})=>void=()=>{};
  readonly auth: CreatorAuth;
  readonly access: ExpansionAccess;
  readonly organizations: OrganizationService;
  readonly mode: "local" | "managed";
  readonly dataRoot: string;
  readonly library: LibraryService;
  readonly blobs: BlobService;
  readonly secrets: SecretService;
  readonly credentials: CredentialService;
  readonly adapters: AdapterService;
  readonly workflows: WorkflowService;
  readonly reviews: ReviewService;
  readonly packs: PackService;
  readonly usage: UsageService;
  readonly content: ContentService;
  private stopMailWorker: (() => Promise<void>) | null = null;
  constructor(readonly store: Store, readonly options: ExpansionOptions) {
    this.mode = options.mode ?? (process.env.APP_MODE === "managed" ? "managed" : "local");
    this.dataRoot = path.resolve(options.dataRoot);
    this.auth = new CreatorAuth(store.db); this.access = new ExpansionAccess(store.db, this.mode); this.organizations = new OrganizationService(store.db, this.access);
    this.library = new LibraryService(store.db); this.blobs = new BlobService(store.db, this.dataRoot); this.secrets = new SecretService(store.db); this.credentials = new CredentialService(store.db, this.access, this.secrets); this.adapters = new AdapterService(store.db); this.workflows = new WorkflowService(store.db); this.reviews = new ReviewService(store, (scope, accountId) => { this.authorizeJob(scope, accountId, "review.approve"); }); this.packs = new PackService(store); this.usage = new UsageService(store.db);
    this.content = new ContentService(store);
  }
  async initialize(): Promise<void> {
    await this.auth.bootstrap();
    if (!process.env.STUDIO_MAIL_ENDPOINT && !process.env.STUDIO_MAIL_SECRET_REF && !process.env.STUDIO_MAIL_ALLOWED_HOST) return;
    const endpoint = process.env.STUDIO_MAIL_ENDPOINT, reference = process.env.STUDIO_MAIL_SECRET_REF, allowedHost = process.env.STUDIO_MAIL_ALLOWED_HOST;
    if (!endpoint || !reference || !allowedHost || !/^AUTH_[A-Z0-9_]{1,72}$/.test(reference) || !process.env[reference]) throw new Error("Studio mail requires endpoint, allowed host and configured AUTH_ secret reference");
    validateEndpoint(endpoint, allowedHost);
    this.store.db.prepare("INSERT INTO platform_connections VALUES('creator-auth-mail','creator-auth','Creator recovery','mail',?,?,?,'','{}',0,'untested',NULL) ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,allowed_host=excluded.allowed_host,secret_ref=excluded.secret_ref").run(endpoint, allowedHost, reference);
    this.stopMailWorker = startPlatformWorker(this.store.db);
  }
  authenticateCreator(req: IncomingMessage): CreatorIdentity | null { return this.auth.authenticate(req); }
  resolveProjectScope(projectId: string): ExpansionScope { return this.access.project(projectId); }
  resolveEnvironmentScope(environmentId: string): ExpansionScope { return this.access.environment(environmentId); }
  accessibleProjectIds(creator: CreatorIdentity | null, localOwner = false): string[] { return this.access.accessible(creator, localOwner); }
  authorizeProject(creator: CreatorIdentity | null, projectId: string, capability: ExpansionCapability, localOwner = false): ExpansionScope { return this.access.authorize(creator, this.access.project(projectId), capability, localOwner); }
  registerProject(project: Project, workspaceId = "local", creator: CreatorIdentity | null = null, localOwner = false): ExpansionScope { return this.organizations.registerProject(project, workspaceId, creator, localOwner); }
  normalizeProjectWrite(previous: Project | null, proposed: Project): Project {
    const result = structuredClone(proposed);
    for (const collection of result.collections ?? []) for (const record of collection.records) {
      const old = previous?.collections?.find(item => item.id === collection.id)?.records.find(item => item.id === record.id);
      record.publication=old?.publication?structuredClone(old.publication):undefined;record.translationReviews=old?.translationReviews?structuredClone(old.translationReviews):undefined;record.fieldRevisions=old?.fieldRevisions?structuredClone(old.fieldRevisions):undefined;record.languageRevisions=old?.languageRevisions?structuredClone(old.languageRevisions):undefined;record.addressHistory=old?.addressHistory?structuredClone(old.addressHistory):undefined;
      if (old && contentFingerprint(old) === contentFingerprint(record)) { record.status = old.status; record.contentRevision = old.contentRevision; record.workflow = old.workflow ? structuredClone(old.workflow) : undefined; record.publishedAt = old.publishedAt; }
      else if (old || record.workflow || this.mode === "managed") { record.status = "draft"; record.contentRevision = old ? (old.contentRevision ?? 0) + 1 : 0; record.workflow = { state: "draft" }; }
    } return parseProject(result);
  }
  assertPublication(scopeInput: ExpansionScope, expectedProject?: Project): void {
    const publishing=expectedProject??this.store.project(scopeInput.projectId);if(publishing){this.blobs.assertPublishable(publishing.id,publishing.assets.flatMap(asset=>asset.blobRef?[asset.blobRef.id]:[]));for(const item of publishing.blockPackages??[])new CatalogService(this.store.db).assertInstall(item.id,item.version);}
    const scope = this.access.resolve(scopeInput), workspace = one(this.store.db, "SELECT config FROM expansion_workspaces WHERE id=?", scope.workspaceId), config = workspace ? record(JSON.parse(String(workspace.config))) : {};
    if (config.requireApproval !== true) return;
    const project = expectedProject ?? this.store.project(scope.projectId); if (!project || project.id !== scope.projectId) throw new HttpError(404, "PROJECT", "프로젝트를 찾을 수 없습니다.");
    const approved = one(this.store.db, "SELECT decided_by FROM expansion_reviews WHERE project_id=? AND revision=? AND fingerprint=? AND status='approved' ORDER BY decided_at DESC LIMIT 1", project.id, project.revision, hash(JSON.stringify(project)));
    if (!approved?.decided_by) throw new HttpError(409, "PUBLICATION_APPROVAL", "현재 문서 버전의 검토 승인이 필요합니다.");
    this.authorizeJob(scope, String(approved.decided_by), "review.approve");
  }
  configureRuntime(scopeInput: ExpansionScope, store: Store): void { const scope = this.access.resolve(scopeInput); setConnectionSecretResolver(store.db, reference => {const value=this.secrets.resolve(scope,reference);if(value===undefined&&this.secrets.registered(scope,reference))throw new HttpError(503,'SECRET_INACTIVE','해당 환경에서 시험한 비밀 버전을 활성화하세요.');return value;}, this.mode === "managed"); }
  async runtimeSecrets(scopeInput: ExpansionScope,suppliedSite?:Store): Promise<Record<string, string>> {
    const scope = this.access.resolve(scopeInput), site = suppliedSite??await this.options.siteData(scope); this.configureRuntime(scope, site);
    const refs = new Set(many(site.db, "SELECT secret_ref,webhook_secret_ref FROM platform_connections WHERE project_id=?", scope.projectId).flatMap(row => [String(row.secret_ref), String(row.webhook_secret_ref)]).filter(Boolean)), result: Record<string, string> = {};
    for (const reference of refs) {const registered=this.secrets.registered(scope,reference),scoped=this.secrets.resolve(scope,reference,"worker.start");if(registered&&scoped===undefined)throw new HttpError(503,'SECRET_INACTIVE','해당 환경에서 시험한 비밀 버전을 활성화하세요.');const value=scoped??(this.mode==='local'&&!registered?process.env[reference]:undefined);if(value)result[reference]=value;}return result;
  }
  async resolveBlob(projectId: string, blobId: string): Promise<string> { this.blobs.assertPublishable(projectId,[blobId]);const value = await this.blobs.read(projectId, blobId); return `data:${value.asset.mime};base64,${value.data.toString("base64")}`; }
  async validateProjectAssets(project: Project, actor: CreatorIdentity | null, localOwner = false): Promise<void> {
    const references = project.assets.filter(asset => asset.blobRef); if (!references.length) return;
    const authorized = (): ExpansionScope => {
      if (actor && !one(this.store.db, "SELECT id FROM creator_accounts WHERE id=? AND disabled=0", actor.id)) throw new HttpError(401, "CREATOR_REQUIRED", "활성 제작자 계정이 필요합니다.");
      return this.authorizeProject(actor, project.id, "project.read", localOwner);
    };
    authorized();
    for (const asset of references) {
      const reference = asset.blobRef!; if (reference.projectId !== project.id) throw new HttpError(403, "BLOB_SCOPE", "자산 참조의 프로젝트 범위가 일치하지 않습니다.");
      const stored = await this.blobs.read(project.id, reference.id), scope = authorized();
      if (stored.asset.organizationId !== scope.organizationId || reference.sha256 !== stored.asset.sha256 || asset.mime !== stored.asset.mime || asset.bytes !== undefined && asset.bytes !== stored.asset.bytes || asset.width !== undefined && asset.width !== stored.asset.width || asset.height !== undefined && asset.height !== stored.asset.height) throw new HttpError(409, "BLOB_REFERENCE", "저장된 자산의 해시·형식·크기와 문서 참조가 일치하지 않습니다.");
      if (asset.data) { const inline = asset.data.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/); if (!inline || inline[1] !== stored.asset.mime || !Buffer.from(inline[2]!, "base64").equals(stored.data)) throw new HttpError(409, "BLOB_REFERENCE", "문서의 이미지 원본과 저장된 자산이 일치하지 않습니다."); }
    }
  }
  reserveUsage(scope: ExpansionScope, metric: string, amount: number, key: string): ReturnType<UsageService["reserve"]> { return this.usage.reserve(this.access.resolve(scope), metric, amount, key); }
  settleUsage(scope: ExpansionScope, id: string, amount: number): ReturnType<UsageService["settle"]> { return this.usage.settle(this.access.resolve(scope), id, amount); }
  releaseUsage(scope: ExpansionScope, id: string): ReturnType<UsageService["settle"]> { return this.usage.settle(this.access.resolve(scope), id, 0, true); }
  authorizeJob(scope: ExpansionScope, actor: string | undefined, capability: ExpansionCapability): ExpansionScope {
    if (!actor || actor === "local-owner") { if (this.mode !== "local") throw new HttpError(403, "JOB_ACTOR", "관리형 작업에는 활성 제작자 권한이 필요합니다."); return this.access.authorize(null, scope, capability, true); }
    if (!one(this.store.db, "SELECT id FROM creator_accounts WHERE id=? AND disabled=0", actor)&&!one(this.store.db,"SELECT id FROM advancement_service_identities WHERE id=? AND revoked=0 AND expires_at>?",actor,Date.now())) throw new HttpError(403, "JOB_ACTOR", "작업 실행자의 권한이 회수되었습니다.");
    return this.access.authorize({ id: actor, csrf: "", sessionId: "" }, scope, capability);
  }
  guardRequest(req: IncomingMessage, url: URL, input: { localOwner: boolean; creator: CreatorIdentity | null; parsedBody?: unknown }): ExpansionScope | null {
    if (!input.creator && !(input.localOwner && this.mode === "local")) throw new HttpError(401, "LOGIN_REQUIRED", "제작자 로그인이 필요합니다.");
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET");
    if (mutation && input.creator) this.auth.csrf(req);
    const environmentId = url.searchParams.get("environmentId");
    let projectId = url.searchParams.get("projectId") ?? url.pathname.match(/^\/api\/projects\/([^/]+)/)?.[1];
    const raw = input.parsedBody === undefined ? null : record(input.parsedBody);
    const projectBody = ["/api/projects", "/api/save-project", "/api/exports", "/api/generate/proposal"].includes(url.pathname), submitted = raw && projectBody ? raw.project && typeof raw.project === "object" ? record(raw.project) : raw : null;
    const submittedProjectId = submitted && typeof submitted.id === "string" ? submitted.id : raw && (projectBody || url.pathname.startsWith("/api/platform/")) && typeof raw.projectId === "string" ? raw.projectId : undefined;
    if (projectId && submittedProjectId && projectId !== submittedProjectId) throw new HttpError(403, "SCOPE_MISMATCH", "요청 범위와 제출한 프로젝트가 일치하지 않습니다.");
    if (!projectId && submittedProjectId) projectId = submittedProjectId;
    const resource = url.pathname.match(/^\/api\/(?:exports|jobs)\/([^/]+)/)?.[1];
    if (!projectId && resource) projectId = String(one(this.store.db, "SELECT project_id FROM exports WHERE id=?", resource)?.project_id ?? one(this.store.db, "SELECT project_id FROM generation_jobs WHERE id=?", resource)?.project_id ?? "") || undefined;
    let capability: ExpansionCapability = mutation ? "project.edit" : "project.read";
    if (/\/(?:generate|launch|stop|deployment|deployments|environments)(?:\/|$)/.test(url.pathname)) capability = "project.publish";
    if (/^\/api\/generate(?:\/|$)/.test(url.pathname)) capability = mutation ? "project.edit" : "project.read";
    if (mutation && /^\/api\/(?:exports|jobs)(?:\/|$)/.test(url.pathname) || mutation && /\/(?:restart|retry|design-rollback)(?:\/|$)/.test(url.pathname)) capability = "project.publish";
    if (/\/(?:restore|data-restore)(?:\/|$)/.test(url.pathname)) capability = "backup.restore";
    if (/\/submissions(?:\.csv|\/|$)/.test(url.pathname)) capability = mutation ? "data.write" : "data.read";
    if (url.pathname.startsWith("/api/platform/")) {
      const route = url.pathname.slice(14);
      if (/^(?:connections|adapters)(?:\/|$)/.test(route)) capability = mutation && !/\/(?:test|data)$/.test(route) ? "connection.manage" : "connection.use";
      else if (/^(?:outbox)(?:\/|$)/.test(route)) capability = "connection.use";
      else if (/^(?:billing|usage|entitlements)(?:\/|$)/.test(route)) capability = "billing.manage";
      else if (/^(?:access|invites|accounts|password-reset|reviews)(?:\/|$)/.test(route)) capability = "team.manage";
      else if (/^(?:orders|catalog|products|booking|bookings|resources|slots)(?:\/|$)/.test(route)) capability = mutation ? "data.write" : "data.read";
      if (this.mode === "managed" && !projectId && !environmentId) throw new HttpError(400, "PROJECT_REQUIRED", "관리형 운영 API에는 프로젝트 범위가 필요합니다.");
    }
    if (environmentId) { const scope = this.access.environment(environmentId); if (projectId && scope.projectId !== projectId) throw new HttpError(403, "SCOPE_MISMATCH", "환경과 프로젝트가 일치하지 않습니다."); return this.access.authorize(input.creator, scope, capability, input.localOwner); }
    if (projectId && one(this.store.db, "SELECT project_id FROM expansion_project_scopes WHERE project_id=?", projectId)) { const authorized = this.authorizeProject(input.creator, projectId, capability, input.localOwner); if (mutation && ["/api/exports", "/api/save-project"].includes(url.pathname) || mutation && /\/design-rollback(?:\/|$)/.test(url.pathname)) this.authorizeProject(input.creator, projectId, "project.edit", input.localOwner); return authorized; }
    if (projectId && mutation && ["/api/projects", "/api/save-project", "/api/exports"].includes(url.pathname) && (url.pathname !== "/api/exports" || this.mode === "local" && input.localOwner)) {
      const workspaceId = url.searchParams.get("workspaceId") ?? (raw?.workspaceId as string | undefined) ?? (this.mode === "local" && input.localOwner ? "local" : undefined);
      if (!workspaceId) throw new HttpError(400, "WORKSPACE_REQUIRED", "새 프로젝트의 작업공간을 지정하세요.");
      const workspace = this.access.workspace(input.creator, workspaceId, "project.create", input.localOwner); return { ...workspace, projectId, dataKey: projectId };
    }
    if (projectId) throw new HttpError(404, "PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
    return null;
  }
  bootstrap(req: IncomingMessage, res: ServerResponse, url: URL, context: ExpansionRequestContext): ExpansionBootstrap {
    const session = this.auth.session(req, res, context.origin, context.localOwner && this.mode === "local"), creator = this.authenticateCreator(req);
    const environmentId = url.searchParams.get("environmentId"), projectId = url.searchParams.get("projectId");
    const currentScope = environmentId ? this.access.authorize(creator, this.access.environment(environmentId), "project.read", context.localOwner) : projectId ? this.authorizeProject(creator, projectId, "project.read", context.localOwner) : null;
    const organizations = this.organizations.organizations(creator, context.localOwner), workspaces = this.organizations.workspaces(creator, context.localOwner);
    return { session, organizations, workspaces, sites: this.organizations.sites(creator, context.localOwner), environments: this.organizations.environments(creator, context.localOwner), currentScope, capabilities: currentScope ? this.access.capabilities(creator, currentScope, context.localOwner) : [...new Set([...organizations.flatMap(org => this.access.capabilities(creator, { organizationId: org.id, workspaceId: "", projectId: "" }, context.localOwner)), ...workspaces.flatMap(workspace => this.access.capabilities(creator, { organizationId: workspace.organizationId, workspaceId: workspace.id, projectId: "" }, context.localOwner))])] };
  }
  supportedJobKinds(): string[] { return ["content.publish", "workflow.run", "booking.materialize", "booking.waitlist", "site.generate"]; }
  async syncCms(scope: ExpansionScope, project: Project, assertLease: () => void = () => {}): Promise<void> {
    // Canonical publication transitions already persist their public snapshot in the same transaction's outbox.
    if(this.store.db.prepare("SELECT 1 FROM advancement_content_projects WHERE project_id=?").get(scope.projectId))return;
    const site = await this.options.siteData(scope); assertLease(); site.assertWritable(); site.db.prepare("INSERT INTO runtime_state VALUES('project:cms',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ revision: project.revision, collections: project.collections ?? [] })); audit(site.db, "content.snapshot", scope.projectId);
  }
  async emitEvent(scopeInput: ExpansionScope, trigger: WorkflowTrigger, payload: unknown, eventKey: string, actor?: string): Promise<ExpansionJobResult[]> {
    const scope = this.access.resolve(scopeInput), ids = this.workflows.events(scope, trigger, payload, eventKey, actor), jobs: ExpansionJobResult[] = [];
    for (const id of ids) jobs.push(await this.options.enqueueJob("workflow.run", scope, { runId: id }, "workflow-" + id, this.workflows.runActor(id))); return jobs;
  }
  async executeJob(kind: string, scopeInput: ExpansionScope, payload: unknown, actor?: string, assertCurrent: () => void = this.options.assertJobLease ?? (() => {})): Promise<unknown> {
    if (!this.supportedJobKinds().includes(kind)) throw new HttpError(400, "JOB_KIND", "지원하지 않는 작업 종류입니다.");
    const capability: ExpansionCapability = kind === "workflow.run" ? "automation.manage" : kind.startsWith("booking.") ? "data.write" : "project.publish", scope = this.authorizeJob(scopeInput, actor, capability), input = record(payload);
    assertCurrent();
    if (kind === "workflow.run") return this.workflows.execute(scope, text(input.runId, "자동화 실행 ID", 100), () => this.options.siteData(scope), needed => { this.authorizeJob(scope, actor, needed); }, assertCurrent);
    if (kind === "content.publish") {
      if(this.store.db.prepare("SELECT 1 FROM advancement_content_projects WHERE project_id=?").get(scope.projectId)){
        const source=this.store.rawProject(scope.projectId);if(!source)throw new HttpError(404,"PROJECT","프로젝트를 찾을 수 없습니다.");
        const content=new IndexedContentService(this.store.db,id=>this.store.rawProject(id)),collectionId=text(input.collectionId,"컬렉션 ID",100),recordId=text(input.recordId,"레코드 ID",100),current=content.get(scope.projectId,collectionId,recordId,{member:true,manage:true});
        if(current.record.workflow?.state!=='published'||current.recordRevision!==input.contentRevision){
          if(current.record.workflow?.state!=='scheduled'||current.recordRevision!==input.contentRevision||current.record.workflow.publishAt!==input.publishAt||current.record.workflow.approvedRevision!==current.recordRevision)throw new HttpError(409,'CONTENT_SCHEDULE_STALE','예약 후 콘텐츠가 변경되거나 회수되었습니다.');
          if(Date.parse(current.record.workflow.publishAt!)>Date.now())throw new HttpError(409,'CONTENT_NOT_DUE','예약 발행 시각이 아직 도착하지 않았습니다.');
          content.transition({scope,actorId:actor??'local-owner',authorize:needed=>{this.authorizeJob(scope,actor,needed);},assertApprover:approver=>{this.authorizeJob(scope,approver,'review.approve');},assertCurrent,emit:event=>{enqueueSystemEvent(this.store.db,event);}},collectionId,recordId,{state:'published',expectedRevision:current.recordRevision,commandId:'scheduled_'+hash(JSON.stringify([scope,collectionId,recordId,current.recordRevision,input.publishAt])).slice(0,48)});
        }
        assertCurrent();this.authorizeJob(scope,actor,'project.publish');
        const project=content.snapshot(source),sequence=Number(this.store.db.prepare('SELECT publication_sequence FROM advancement_content_projects WHERE project_id=?').get(scope.projectId)!.publication_sequence);
        return {revision:project.revision,publicationSequence:sequence,releaseJob:await this.options.enqueueJob('site.generate',scope,{projectId:project.id,revision:project.revision},'cms-release-'+project.id+'-publication-'+sequence,actor)};
      }
      const project = this.reviews.publishScheduled(scope, input); await this.syncCms(scope, project, assertCurrent); this.authorizeJob(scope, actor, "project.publish"); return { revision: project.revision, releaseJob: await this.options.enqueueJob("site.generate", scope, { projectId: project.id, revision: project.revision }, "cms-release-" + project.id + "-" + project.revision, actor) };
    }
    const site = await this.options.siteData(scope); assertCurrent(); this.authorizeJob(scope, actor, capability); site.assertWritable();
    if (kind === "booking.materialize") return new BookingExpansion(site.db).materialize(scope.projectId, text(input.ruleId, "반복 규칙 ID", 100));
    if (kind === "booking.waitlist") return new BookingExpansion(site.db).offer(scope.projectId);
    throw new HttpError(503, "GENERATION_HANDLER", "생성 작업은 중앙 생성 워커가 처리해야 합니다.");
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, context: ExpansionRequestContext): Promise<boolean> {
    if (url.pathname.startsWith("/api/v1/")) return this.handlePublicApi(req, res, url, context);
    if (!url.pathname.startsWith("/api/expansion/")) return false;
    const route = url.pathname.slice("/api/expansion/".length), method = req.method ?? "GET", local = context.localOwner && this.mode === "local", creator = this.authenticateCreator(req);
    const send = (value: unknown, status = 200): boolean => { reply(res, status, value, undefined, context.requestId); return true; };
    if (method === "GET" && route === "session") return send(this.auth.session(req, res, context.origin, local));
    if (method === "GET" && route === "bootstrap") return send(this.bootstrap(req, res, url, context));
    if (method === "GET" && route === "openapi") return send(this.openApi());
    const webhook = route.match(/^webhooks\/([^/]+)$/);
    if (webhook && method === "POST") {
      this.auth.rate(req, "webhook");
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "CONTENT_TYPE", "JSON 웹훅이 필요합니다.");
      let length = 0; const chunks: Buffer[] = [];
      for await (const value of req) { const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array); length += chunk.length; if (length > 100_000) throw new HttpError(413, "WEBHOOK_SIZE", "웹훅 크기를 확인하세요."); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString("utf8"), authenticated = this.credentials.webhook(webhook[1]!, String(req.headers["x-webhook-timestamp"] ?? ""), raw, String(req.headers["x-webhook-signature"] ?? ""));
      let decoded: unknown; try { decoded = JSON.parse(raw) as unknown; } catch { throw new HttpError(400, "JSON", "웹훅 JSON을 확인하세요."); }
      const event = record(decoded); if (event.trigger !== "manual") throw new HttpError(400, "WEBHOOK_TRIGGER", "외부 자동화 웹훅은 manual 이벤트로 제출하세요. 결제·예약 확인은 전용 API가 처리합니다.");
      this.assertAdvancementRequest(req,url,{creator:authenticated.identity,localOwner:false,scope:authenticated.credential.scope,input:event});
      const claim = this.credentials.claimEvent(authenticated.credential.id, text(event.eventId, "이벤트 ID", 100), event);
      if (claim.completed) return send({ duplicate: true });
      const jobs = await this.emitEvent(authenticated.credential.scope, "manual", event.payload, "webhook-" + claim.id, authenticated.actorId); this.credentials.completeEvent(claim.id); return send({ accepted: true, jobs }, 202);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !(context.trustedCsrf && local)) this.auth.csrf(req);
    const input = method === "GET" || method === "DELETE" ? {} : record(await body(req));
    if (["accounts", "login", "password-reset/request", "password-reset/confirm"].includes(route) && method === "POST") this.auth.rate(req, route);
    if (route === "accounts" && method === "POST") {
      if (!local && process.env.STUDIO_ALLOW_REGISTRATION !== "true" && !input.inviteToken) throw new HttpError(403, "REGISTRATION_DISABLED", "관리자의 제작자 초대가 필요합니다.");
      return send(await this.auth.create(input), 201);
    }
    if (route === "login" && method === "POST") return send(await this.auth.login(req, res, context.origin, input));
    if (route === "logout" && method === "POST") { this.auth.logout(req, res, context.origin); return send({ loggedOut: true }); }
    if (route === "password-reset/request" && method === "POST") { const value = this.auth.requestReset(input.email), configured = Boolean(this.stopMailWorker); if (value && configured) { const recovery = one(this.store.db, "SELECT a.email,r.expires_at FROM creator_reset_tokens r JOIN creator_accounts a ON a.id=r.account_id WHERE r.token_hash=?", hash(value))!; enqueue(this.store.db, "creator-auth", "creator-auth-mail", "creator-reset-" + hash(value), { type: "creator.password_reset", to: recovery.email, token: value, expiresAt: new Date(Number(recovery.expires_at)).toISOString(), studioOrigin: context.origin }); } return send({ requested: true, delivery: configured ? "pending" : "not-configured", ...(local && value ? { localRecoveryToken: value } : {}) }); }
    if (route === "password-reset/confirm" && method === "POST") { await this.auth.reset(input); return send({ reset: true }); }
    if (!creator && !local) throw new HttpError(401, "LOGIN_REQUIRED", "제작자 로그인이 필요합니다.");
    let checked=false;const advance=(owned?:ExpansionScope):void=>{if(!checked){this.assertAdvancementRequest(req,url,{creator,localOwner:local,scope:owned,input});checked=true;}};
    if (route === "organizations" && method === "GET") return send(this.organizations.organizations(creator, local));
    if (route === "organizations" && method === "POST") {advance();return send(this.organizations.createOrganization(creator, local, input), 201);}
    const organization = route.match(/^organizations\/([^/]+)(?:\/(transfer))?$/);
    if (organization && method === "PUT") {this.access.organization(creator,organization[1]!,'org.manage',local);advance(); this.organizations.updateOrganization(creator, local, organization[1]!, input); return send({ updated: true }); }
    if (organization?.[2] && method === "POST") {this.access.organization(creator,organization[1]!,'org.manage',local);advance();this.organizations.transfer(creator, local, organization[1]!, text(input.accountId, "대상 계정", 100)); return send({ transferred: true }); }
    if (route === "workspaces" && method === "GET") return send(this.organizations.workspaces(creator, local, url.searchParams.get("organizationId") ?? undefined));
    if (route === "workspaces" && method === "POST") {this.access.organization(creator,text(input.organizationId,'조직 ID',100),'workspace.manage',local);advance();return send(this.organizations.createWorkspace(creator, local, input), 201);}
    const workspace = route.match(/^workspaces\/([^/]+)$/); if (workspace && method === "PUT") {const previous=one(this.store.db,'SELECT organization_id FROM expansion_workspaces WHERE id=?',workspace[1]!);if(!previous)throw new HttpError(404,'WORKSPACE_NOT_FOUND','작업공간을 찾을 수 없습니다.');this.access.organization(creator,String(previous.organization_id),'workspace.manage',local);advance();return send(this.organizations.updateWorkspace(creator, local, workspace[1]!, input));}
    if (route === "sites" && method === "GET") return send(this.organizations.sites(creator, local, url.searchParams.get("workspaceId") ?? undefined));
    if (route === "sites" && method === "POST") {const owned=this.authorizeProject(creator,text(input.projectId,'프로젝트 ID',100),'project.edit',local);advance(owned);return send(this.organizations.createSite(creator, local, input), 201);}
    const site = route.match(/^sites\/([^/]+)$/); if (site && method === "PUT") {const previous=one(this.store.db,'SELECT project_id FROM expansion_sites WHERE id=?',site[1]!);if(!previous)throw new HttpError(404,'SITE_NOT_FOUND','사이트를 찾을 수 없습니다.');advance(this.authorizeProject(creator,String(previous.project_id),'project.edit',local));return send(this.organizations.updateSite(creator, local, site[1]!, input));}
    if (route === "environments" && method === "GET") return send(this.organizations.environments(creator, local, url.searchParams.get("siteId") ?? undefined));
    if (route === "environments" && method === "POST") {const previous=one(this.store.db,'SELECT project_id FROM expansion_sites WHERE id=?',text(input.siteId,'사이트 ID',100));if(!previous)throw new HttpError(404,'SITE_NOT_FOUND','사이트를 찾을 수 없습니다.');advance(this.authorizeProject(creator,String(previous.project_id),'project.publish',local));return send(this.organizations.createEnvironment(creator, local, input), 201);}
    const environment = route.match(/^environments\/([^/]+)$/); if (environment && method === "PUT") {const owned=this.access.authorize(creator,this.access.environment(environment[1]!),'project.publish',local);advance(owned);return send(this.organizations.updateEnvironment(creator, local, environment[1]!, input));}
    if (route === "members" && method === "GET") return send(this.organizations.members(creator, local, text(url.searchParams.get("organizationId"), "조직 ID", 100)));
    const member = route.match(/^members\/([^/]+)$/); if (member && ["PUT", "DELETE"].includes(method)) {this.access.organization(creator,text(input.organizationId??url.searchParams.get('organizationId'),'조직 ID',100),'team.manage',local);advance();this.organizations.changeMember(creator, local, member[1]!, method === "DELETE" ? { organizationId: url.searchParams.get("organizationId") } : input, method === "DELETE"); return send({ updated: true }); }
    if (route === "invites" && method === "POST") {this.access.organization(creator,text(input.organizationId,'조직 ID',100),'team.manage',local);advance();return send(this.organizations.invite(creator, local, input), 201);}
    if (route === "invites/accept" && method === "POST") { this.organizations.accept(creator, input.token); return send({ accepted: true }); }
    const invite = route.match(/^invites\/([^/]+)$/); if (invite && method === "DELETE") {const previous=one(this.store.db,'SELECT organization_id FROM expansion_invites WHERE id=?',invite[1]!);if(!previous)throw new HttpError(404,'INVITE','초대를 찾을 수 없습니다.');this.access.organization(creator,String(previous.organization_id),'team.manage',local);advance(); this.organizations.revoke(creator, local, invite[1]!); return send({ revoked: true }); }
    const organizationId = (): string => text(input.organizationId ?? url.searchParams.get("organizationId"), "조직 ID", 100);
    const scope = (capability: ExpansionCapability): ExpansionScope => {const owned=this.access.authorize(creator, this.access.resolve({ projectId: input.projectId === undefined ? url.searchParams.get("projectId") ?? undefined : text(input.projectId, "프로젝트 ID", 100), environmentId: input.environmentId === undefined ? url.searchParams.get("environmentId") ?? undefined : text(input.environmentId, "환경 ID", 100) }), capability, local);advance(owned);return owned;};
    const actor = (): string => actorId(creator, local);
    const orgRead = (): string => { const id = organizationId(); if (!this.access.readable(creator, id, local)) throw new HttpError(403, "PERMISSION", "조직 리소스를 읽을 권한이 없습니다."); return id; };
    if (route === "brands" && method === "GET") return send(this.library.brands(orgRead()));
    if (route === "brands" && method === "POST") { const id = organizationId(); this.access.organization(creator, id, "asset.manage", local); return send(this.library.saveBrand(id, input), 201); }
    const brand = route.match(/^brands\/([^/]+)(?:\/(versions|publish))?$/);
    if (brand && method === "PUT") { const id = organizationId(); this.access.organization(creator, id, "asset.manage", local); return send(this.library.saveBrand(id, input, brand[1]!)); }
    if (brand?.[2] === "versions" && method === "GET") { const id = orgRead(); if (!one(this.store.db, "SELECT id FROM expansion_brands WHERE id=? AND organization_id=?", brand[1]!, id)) throw new HttpError(404, "BRAND", "브랜드를 찾을 수 없습니다."); return send(many(this.store.db, "SELECT revision,body,created_at AS createdAt FROM expansion_brand_versions WHERE brand_id=? ORDER BY revision DESC LIMIT 100", brand[1]!).map(row => ({ revision: Number(row.revision), theme: JSON.parse(String(row.body)) as unknown, createdAt: row.createdAt }))); }
    if (brand?.[2] === "publish" && method === "POST") { const id = organizationId(); this.access.organization(creator, id, "asset.manage", local); const current = one(this.store.db, "SELECT revision FROM expansion_brands WHERE id=? AND organization_id=?", brand[1]!, id); if (!current || current.revision !== input.baseRevision) throw new HttpError(409, "BRAND_REVISION", "현재 브랜드 버전을 확인하세요."); this.store.operations.setState("expansion:brand-published:" + brand[1], { revision: current.revision, actorId: actor(), publishedAt: now() }); audit(this.store.db, "brand.publish", brand[1]!); return send({ revision: current.revision, published: true }); }
    if (route === "library" && method === "GET") return send(this.library.items(orgRead()));
    if (route === "library" && method === "POST") { const id = organizationId(); this.access.organization(creator, id, "asset.manage", local); return send(this.library.saveItem(id, input), 201); }
    const library = route.match(/^library\/([^/]+)(?:\/(versions))?$/);
    if (library && method === "PUT") { const id = organizationId(); this.access.organization(creator, id, "asset.manage", local); return send(this.library.saveItem(id, input, library[1]!)); }
    if (library?.[2] && method === "GET") { const id = orgRead(); if (!one(this.store.db, "SELECT id FROM expansion_library_items WHERE id=? AND organization_id=?", library[1]!, id)) throw new HttpError(404, "LIBRARY", "라이브러리를 찾을 수 없습니다."); return send(many(this.store.db, "SELECT revision,body,created_at AS createdAt FROM expansion_library_versions WHERE item_id=? ORDER BY revision DESC LIMIT 100", library[1]!).map(row => ({ ...row, body: JSON.parse(String(row.body)) as unknown }))); }
    if (route === "blobs" && method === "GET") return send(this.blobs.list(scope("project.read")));
    const assetCurrent=(owned:ExpansionScope):void=>{this.access.authorize(creator,owned,'asset.manage',local);advance(owned);};
    if (route === "blobs" && method === "POST") {const owned=scope('asset.manage');return send(await this.blobs.upload(owned,input,()=>assetCurrent(owned)),201);}
    const blob = route.match(/^blobs\/([^/]+)(?:\/(content|approval|variants))?$/);
    if(blob?.[2]==='approval'&&method==='POST'){const owned=scope('asset.manage');return send(await this.blobs.approve(owned,blob[1]!,input,actor(),()=>assetCurrent(owned)));}
    if(blob?.[2]==='variants'&&method==='POST'){const owned=scope('asset.manage');return send(await this.blobs.variant(owned,blob[1]!,input,()=>assetCurrent(owned)),201);}
    if (blob?.[2]==='content' && method === "GET") {
      const owned = one(this.store.db, "SELECT project_id FROM expansion_blob_refs WHERE id=?", blob[1]!); if (!owned) throw new HttpError(404, "BLOB", "파일을 찾을 수 없습니다.");
      const ownedScope = this.authorizeProject(creator, String(owned.project_id), "project.read", local), value = await this.blobs.read(ownedScope.projectId, blob[1]!);
      res.writeHead(200, { "Content-Type": value.asset.mime, "Content-Length": value.data.length, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Request-ID": context.requestId }); res.end(value.data); return true;
    }
    if (blob && !blob[2] && method === "DELETE") { this.blobs.remove(scope("asset.manage"), blob[1]!); return send({ referenceRemoved: true, originalPreserved: true }); }
    if (route === "secrets" && method === "GET") { const id = organizationId(); this.access.organization(creator, id, "secret.rotate", local); return send(this.secrets.list(id)); }
    if (route === "secrets/audit" && method === "GET") { const id = organizationId(); this.access.organization(creator, id, "secret.rotate", local); return send(this.secrets.auditEntries(id)); }
    if (route === "secrets" && method === "POST") { const id = organizationId(); this.access.organization(creator, id, "secret.rotate", local);advance(); return send(this.secrets.save(id, actor(), input), 201); }
    const secret = route.match(/^secrets\/([^/]+)$/);
    if (secret && method === "PUT") { const id = organizationId(); this.access.organization(creator, id, "secret.rotate", local);advance(); return send(this.secrets.save(id, actor(), input, secret[1]!)); }
    if (secret && method === "DELETE") { const id = organizationId(); this.access.organization(creator, id, "secret.rotate", local);advance(); this.secrets.disable(id, secret[1]!, actor()); return send({ disabled: true }); }
    if (route === "credentials" && method === "GET") return send(this.credentials.list(scope("connection.manage")));
    if (route === "credentials" && method === "POST") return send(this.credentials.issue(scope("connection.manage"), creator, local, input), 201);
    const credential = route.match(/^credentials\/([^/]+)$/); if (credential && method === "DELETE") { this.credentials.revoke(scope("connection.manage"), credential[1]!); return send({ revoked: true }); }
    if (route === "adapters" && method === "GET") return send(this.adapters.list(orgRead()));
    if (route === "adapters" && method === "POST") { const id = organizationId(); this.access.organization(creator, id, "connection.manage", local); return send(this.adapters.save(id, input), 201); }
    const adapter = route.match(/^adapters\/([^/]+)(?:\/(execute))?$/);
    if (adapter && method === "PUT") { const id = organizationId(); this.access.organization(creator, id, "connection.manage", local); return send(this.adapters.save(id, input, adapter[1]!)); }
    if (adapter?.[2] && method === "POST") { const owned = scope("connection.use"), site = await this.options.siteData(owned); this.configureRuntime(owned, site); site.assertWritable(); return send(await this.adapters.execute(owned.organizationId, site.db, owned.projectId, adapter[1]!, input)); }
    if (route === "reviews" && method === "GET") return send(this.reviews.list(scope("project.read")));
    if (route === "reviews" && method === "POST") return send(this.reviews.submit(scope("project.edit"), actor(), integer(input.revision, "검토 버전")), 201);
    const review = route.match(/^reviews\/([^/]+)$/); if (review && method === "PUT") return send(this.reviews.decide(scope("review.approve"), actor(), review[1]!, input.decision));
    if (route === "comments" && method === "GET") return send(this.reviews.comments(scope("project.read")));
    if (route === "comments" && method === "POST") return send(this.reviews.comment(scope("project.read"), actor(), input), 201);
    const comment = route.match(/^comments\/([^/]+)$/); if (comment && method === "PUT") { this.reviews.resolveComment(scope("project.edit"), comment[1]!, boolean(input.resolved, "해결 상태", false)); return send({ updated: true }); }
    if (route === "presence" && method === "GET") return send(this.reviews.presence(scope("project.read")));
    if (route === "presence" && method === "POST") { const owned = scope("project.read"); if (!creator) throw new HttpError(401, "CREATOR_REQUIRED", "제작자 계정이 필요합니다."); this.reviews.heartbeat(owned, creator.id, input); return send({ expiresAt: new Date(Date.now() + 60_000).toISOString() }); }
    if (route === "cms/transitions" && method === "POST") {
      const owned = scope(input.state === "approved" ? "review.approve" : ["published", "scheduled"].includes(String(input.state)) ? "project.publish" : "project.edit"), result = this.reviews.content(owned, actor(), input); await this.syncCms(owned, result.project);
      const job = result.scheduledAt !== undefined ? await this.options.enqueueJob("content.publish", owned, { collectionId: input.collectionId, recordId: result.recordId, contentRevision: result.contentRevision, publishAt: input.publishAt }, "cms-" + hash(JSON.stringify([owned, result.recordId, result.contentRevision, input.publishAt])), actor(), { notBefore: result.scheduledAt }) : input.state === "published" ? await this.options.enqueueJob("site.generate", owned, { projectId: owned.projectId, revision: result.project.revision }, "cms-release-" + owned.projectId + "-" + result.project.revision, actor()) : undefined;
      return send({ project: result.project, ...(job ? { job } : {}) });
    }
    const cms = route.match(/^cms\/([^/]+)\/records$/);
    if (cms && method === "GET") return send(this.content.query(scope("project.read"), cms[1]!, url.searchParams));
    if (cms && method === "PUT") { const owned = scope("project.edit"), result = this.content.upsert(owned, cms[1]!, input); await this.syncCms(owned, result.project); return send(result); }
    if (route === "workflows" && method === "GET") return send(this.workflows.list(scope("automation.manage")));
    if (route === "workflows" && method === "POST") return send(this.workflows.save(scope("automation.manage"), actor(), input), 201);
    const workflow = route.match(/^workflows\/([^/]+)$/); if (workflow && method === "PUT") return send(this.workflows.save(scope("automation.manage"), actor(), input, workflow[1]!));
    if (route === "workflows/runs" && method === "GET") return send(this.workflows.runs(scope("automation.manage")));
    if (route === "workflows/events" && method === "POST") { const trigger = String(input.trigger) as WorkflowTrigger; if (!WORKFLOW_TRIGGERS.includes(trigger)) throw new HttpError(400, "WORKFLOW_TRIGGER", "이벤트 종류를 확인하세요."); return send({ jobs: await this.emitEvent(scope("automation.manage"), trigger, input.payload, text(input.key, "이벤트 키", 100), actor()) }, 202); }
    if (route === "packs" && method === "GET") return send(this.packs.list(scope("project.read")));
    if (route === "packs/catalog" && method === "GET") { const owned = scope("project.read"); return send(this.library.items(owned.organizationId).filter(item => item.kind === "pack")); }
    if (route === "packs/preview" && method === "POST") return send(await this.packs.preview(scope("project.edit"), actor(), input));
    if (route === "packs/apply" && method === "POST") return send({ project: await this.packs.apply(scope("project.edit"), actor(), input.approvalFingerprint) });
    if (route === "usage" && method === "GET") { const owned = scope("billing.manage"); return send({ reservations: this.usage.list(owned), budget: this.usage.budget(owned.organizationId) }); }
    if (route === "usage/limits" && method === "POST") { const id = organizationId(); this.access.organization(creator, id, "billing.manage", local); this.usage.limit(id, input); return send({ updated: true }); }
    if (route === "usage/reservations" && method === "POST") return send(this.usage.reserve(scope("billing.manage"), input.metric, input.amount, input.key), 201);
    const reservation = route.match(/^usage\/reservations\/([^/]+)\/(settle|release)$/); if (reservation && method === "POST") return send(this.usage.settle(scope("billing.manage"), reservation[1]!, input.amount, reservation[2] === "release"));
    if (route.startsWith("booking/") || route.startsWith("orders/")) {
      const owned = scope(method === "GET" ? "data.read" : "data.write"), site = await this.options.siteData(owned), business = new BookingExpansion(site.db); if (method !== "GET") site.assertWritable();
      if(route==='booking/reviews'&&method==='POST')return send(business.previewChange(owned.projectId,input),201);
      const bookingReview=route.match(/^booking\/reviews\/([^/]+)\/apply$/);if(bookingReview&&method==='POST')return send(business.applyChange(owned.projectId,bookingReview[1]!,input.approvalFingerprint));
      if (route === "booking/rules" && method === "GET") return send(business.rules(owned.projectId));
      if (route === "booking/rules" && method === "POST") return send(business.saveRule(owned.projectId, input), 201);
      const rule = route.match(/^booking\/rules\/([^/]+)(?:\/(materialize))?$/); if (rule && method === "PUT") return send(business.saveRule(owned.projectId, input, rule[1]!));
      if (rule?.[2] && method === "POST") return send(await this.options.enqueueJob("booking.materialize", owned, { ruleId: rule[1] }, "booking-rule-" + hash(JSON.stringify([rule[1], input.key])), actor()), 202);
      if (route === "booking/holidays" && method === "GET") return send(business.holidays(owned.projectId));
      if (route === "booking/holidays" && method === "POST") { business.saveHoliday(owned.projectId, input); return send({ updated: true }); }
      if (route === "booking/holidays" && method === "DELETE") { business.saveHoliday(owned.projectId, { resourceId: url.searchParams.get("resourceId"), date: url.searchParams.get("date") }, true); return send({ removed: true }); }
      if (route === "booking/waitlist" && method === "GET") return send(business.waitlist(owned.projectId));
      if (route === "booking/waitlist/offers" && method === "POST") return send(await this.options.enqueueJob("booking.waitlist", owned, {}, "waitlist-" + hash(JSON.stringify([owned, input.key])), actor()), 202);
      if (route === "orders/fulfillments" && method === "GET") return send(business.fulfillments(owned.projectId));
      const order = route.match(/^orders\/([^/]+)\/fulfillment$/); if (order && method === "PUT") return send(business.fulfill(owned.projectId, actor(), order[1]!, input));
    }
    throw new HttpError(404, "ROUTE", "확장 API 경로를 찾을 수 없습니다.");
  }
  async pollEvents(scopeInput: ExpansionScope): Promise<{ events: number; jobs: number }> {
    const scope = this.access.resolve(scopeInput), site = await this.options.siteData(scope); let events = 0, jobs = 0;
    for (const row of many(site.db, "SELECT key,value FROM runtime_state WHERE key LIKE 'workflow:event:%' ORDER BY key LIMIT 100")) {
      const event = record(JSON.parse(String(row.value))); if (event.projectId !== scope.projectId || !["form.submitted", "order.paid", "booking.created"].includes(String(event.trigger))) continue;
      const queued = await this.emitEvent(scope, event.trigger as WorkflowTrigger, event.payload, String(row.key)); jobs += queued.length;
      site.db.prepare("DELETE FROM runtime_state WHERE key=? AND value=?").run(String(row.key), String(row.value)); events++;
    } return { events, jobs };
  }
  openApi(): unknown {
    const response = { description: "JSON envelope", content: { "application/json": { schema: { type: "object", required: ["data", "error", "meta"], properties: { data: {}, error: { nullable: true }, meta: { type: "object" } } } } } };
    return { openapi: "3.0.3", info: { title: "Automade Scoped API", version: "1.0.0" }, servers: [{ url: "/" }], components: { securitySchemes: { ScopedApiKey: { type: "http", scheme: "bearer" } } }, security: [{ ScopedApiKey: [] }], paths: {
      "/api/v1/project": { get: { operationId: "getScopedProject", responses: { "200": response } }, put: { operationId: "replaceScopedProject", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["project", "baseRevision"], properties: { project: { type: "object" }, baseRevision: { type: "integer", minimum: 0 } } } } } }, responses: { "200": response, "409": response } } },
      "/api/v1/content/{collectionId}": { get: { operationId: "queryPublishedContent", parameters: [{ name: "collectionId", in: "path", required: true, schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "cursor", in: "query", schema: { type: "string" } }, { name: "q", in: "query", schema: { type: "string", maxLength: 200 } }], responses: { "200": response } } },
      "/api/v1/workflow-events": { post: { operationId: "submitManualWorkflowEvent", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["key", "payload"], properties: { key: { type: "string", maxLength: 100 }, payload: { type: "object" } } } } } }, responses: { "202": response } } }
    } };
  }
  async handlePublicApi(req: IncomingMessage, res: ServerResponse, url: URL, context: ExpansionRequestContext): Promise<boolean> {
    const method = req.method ?? "GET", send = (data: unknown, status = 200): boolean => { reply(res, status, data, undefined, context.requestId); return true; };
    this.auth.rate(req, "scoped-api");
    if (url.pathname === "/api/v1/project") {
      const authenticated = this.credentials.authenticate(req, method === "GET" ? "project.read" : "project.edit"), scope = authenticated.credential.scope;
      if (method === "GET") return send(this.store.project(scope.projectId));
      if (method === "PUT") { const input = record(await body(req)), parsed = parseProject(input.project); if (parsed.id !== scope.projectId) throw new HttpError(403, "API_SCOPE", "API 키에 지정된 프로젝트만 수정할 수 있습니다.");this.assertAdvancementRequest(req,url,{creator:authenticated.identity,localOwner:authenticated.actorId==='local-owner',scope,input});bindOperation(scope,authenticated.actorId,authenticated.identity?.sessionId.startsWith('service:')?'service':authenticated.identity?'creator':'local-owner'); const project = this.normalizeProjectWrite(this.store.project(parsed.id), parsed); await this.validateProjectAssets(project, authenticated.identity, this.mode === "local" && authenticated.actorId === "local-owner"); this.credentials.authenticate(req, "project.edit"); this.store.save(project, integer(input.baseRevision, "문서 버전")); await this.syncCms(scope, project); audit(this.store.db, "api.project.save", scope.projectId); return send({ project:this.store.project(project.id) }); }
    }
    const content = url.pathname.match(/^\/api\/v1\/content\/([^/]+)$/);
    if (content && method === "GET") { const authenticated = this.credentials.authenticate(req, "data.read"), project = this.store.project(authenticated.credential.scope.projectId); if (!project) throw new HttpError(404, "PROJECT", "프로젝트를 찾을 수 없습니다."); return send(queryCollection(project, content[1]!, url.searchParams, { member: true })); }
    if (url.pathname === "/api/v1/workflow-events" && method === "POST") { const authenticated = this.credentials.authenticate(req, "automation.manage"), input = record(await body(req, 100_000));this.assertAdvancementRequest(req,url,{creator:authenticated.identity,localOwner:authenticated.actorId==='local-owner',scope:authenticated.credential.scope,input});bindOperation(authenticated.credential.scope,authenticated.actorId,authenticated.identity?.sessionId.startsWith('service:')?'service':authenticated.identity?'creator':'local-owner'); return send({ jobs: await this.emitEvent(authenticated.credential.scope, "manual", input.payload, text(input.key, "이벤트 키", 100), authenticated.actorId) }, 202); }
    throw new HttpError(404, "API_ROUTE", "공개 API 경로를 찾을 수 없습니다.");
  }
  async close(): Promise<void> { await this.stopMailWorker?.(); this.stopMailWorker = null; }
}
