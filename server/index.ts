import { createServer } from "node:http";
import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { parseProject, record } from "../src/domain/validation";
import { TEMPLATES, type TemplateId } from "../src/domain/templates";
import {
  body,
  ensureOrigin,
  fail,
  headers,
  HttpError,
  RateLimit,
  reply,
  staticFile,
} from "./http";
import { Store } from "./store";
import { verifyAssets, GENERATOR_VERSION } from "./generator";
import {
  generateFromBrief,
  validateGenerationConfig,
} from "./generationAdapter";
import { OperationsService } from "./operationsService";
import { handlePlatformRequest } from "./platform/index";
import { generationSettings, reserveGeneration, validateGenerationBudget } from "./generationBudget";
import { type ProposalOperation } from "../src/domain/proposals";
import { mergeScopedProposal, validateProposalScope, type ProposalScope } from "../src/domain/scopedProposals";
import { ExpansionService } from "./expansion/service";
import { StudioSessions } from "./studioSessions";
import { studioConfig } from "./studioConfig";
import { WorkQueue } from "./workQueue";
import { executeInWorker } from "./workerClient";
import { studioOperation } from "./studioObservability";
import { initializeVaultKey } from "./localVault";
import {AdvancementService} from './advancement/service';
import {SystemRuntimeService} from './systemRuntimeService';
import {SystemDelivery,persistedEnvironmentScopes,enqueueSystemEvent} from './systemDelivery';
import {readiness,buildIdentity} from './runtimeIdentity';
import {applyProjectCommand,commandFingerprint,parseProjectCommand} from './projectCommands';
import {hydrateContentProject,reconcileContentWrite} from './advancement/content';
import {PrivatePreview} from './privatePreview';
import {operationContext,newOperation,bindOperation} from './operationContext';
import type {ContentEvent} from '../src/domain/contentContracts';
import {exportOtlp} from './systemObservability';
import {jobUseCase} from './useCases';
const sourceRoot = process.env.AUTOMADE_ROOT
  ? path.resolve(process.env.AUTOMADE_ROOT)
  : path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      existsSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "../package.json",
        ),
      )
        ? ".."
        : ".",
    );
if (existsSync(path.join(sourceRoot, ".env")))
  process.loadEnvFile(path.join(sourceRoot, ".env"));
validateGenerationConfig();
validateGenerationBudget();
const configuration = studioConfig(process.env);
if (configuration.mode === "managed" && (!process.env.STUDIO_ADMIN_EMAIL || !process.env.STUDIO_ADMIN_PASSWORD)) throw new Error("Managed mode requires STUDIO_ADMIN_EMAIL and STUDIO_ADMIN_PASSWORD bootstrap configuration");
const dataRoot = path.resolve(
  process.env.DATA_DIR || path.join(sourceRoot, ".data"),
);
const exportRoot = path.resolve(
  process.env.EXPORT_DIR || path.join(sourceRoot, "exports"),
);
mkdirSync(dataRoot, { recursive: true });
mkdirSync(exportRoot, { recursive: true });
await initializeVaultKey(dataRoot,configuration.mode);
const store = new Store(path.join(dataRoot, "studio.sqlite"));
store.projectHydrator=project=>hydrateContentProject(store.db,project);
store.beforeProjectWrite=(previous,incoming)=>{const current=operationContext.getStore(),scope=current?.scope;if(!scope||scope.projectId!==incoming.id)return reconcileContentWrite(store.db,previous,incoming);return reconcileContentWrite(store.db,previous,incoming,{scope,actorId:current.actorKey??'local-owner',authorize:capability=>{expansion.authorizeJob(scope,current.actorKey,capability);if(capability==='project.publish')advancement.assertJob(scope,'content.publish');},assertApprover:actor=>{expansion.authorizeJob(scope,actor,'review.approve');},emit:event=>enqueueSystemEvent(store.db,event)});};
store.recoverInterrupted();
const rates = new RateLimit();
const sessions = new StudioSessions(store.db);
const operations = new OperationsService(store, sourceRoot, exportRoot, dataRoot);
const queue = new WorkQueue(store.db, randomUUID(), configuration.concurrency);
const expansion = new ExpansionService(store, {
  mode: configuration.mode, dataRoot,
  siteData: async scope => {const site=await operations.scopeData(scope);expansion.configureRuntime(scope,site);return site;},
  enqueueJob: async (kind, scope, payload, key, actorId, options) => {
    if (kind !== "site.generate" && !expansion.supportedJobKinds().includes(kind)) throw new HttpError(400, "JOB_KIND", "지원하지 않는 작업입니다.");
    const item = queue.enqueue(kind, scope, payload, key, actorId, { recovery: /webhook|connection|deploy|workflow/.test(kind) ? "manual" : "retry",...options,traceId:operationContext.getStore()?.traceId });
    return { id: item.id, status: item.status };
  },
});
await expansion.initialize();
const advancement=new AdvancementService(store,expansion,{dataRoot,exportRoot,siteData:async scope=>{const site=await operations.scopeData(scope);expansion.configureRuntime(scope,site);return site;},rawProject:id=>store.rawProject(id),backupScope:scope=>operations.backupScope(scope),restoreScope:(scope,id)=>operations.restoreScope(scope,id),withFreeze:(scope,work)=>operations.withScopeFreeze(scope,work),emit:(_scope,event)=>enqueueSystemEvent(store.db,event as ContentEvent),enqueueJob:async(kind,scope,payload,key,actor)=>{const item=queue.enqueue(kind,scope,payload,key,actor,{recovery:/webhook|connection|deploy|workflow/.test(kind)?'manual':'retry',traceId:operationContext.getStore()?.traceId});return {id:item.id,status:item.status};}});
expansion.assertAdvancementRequest=(req,url,context)=>{bindOperation(context.scope??undefined,context.creator?.id??(context.localOwner?'local-owner':undefined),context.creator?'creator':context.localOwner?'local-owner':'system');advancement.assertRequest(req,url,context);};
const systemRuntime=new SystemRuntimeService(store,expansion,operations,queue,advancement,sourceRoot,dataRoot);
const privatePreview=new PrivatePreview(store,expansion,operations);
operations.beforeDataRestore=(scope,site)=>advancement.beforeRestore(scope,site);
operations.afterDataRestore=(scope,site,checkpoint)=>advancement.afterRestore(scope,site,checkpoint);
const delivery=new SystemDelivery(store.db,async scope=>{const site=await operations.scopeData(scope);expansion.configureRuntime(scope,site);return site;},event=>{advancement.assertJob(event.scope,'content.publish');expansion.authorizeJob(event.scope,event.actorId,'project.publish');});
operations.runtimeSecrets=(scope,site)=>expansion.runtimeSecrets(scope,site);
operations.deployment.resolveSecret=(reference,scope)=>{if(!scope)return configuration.mode==='local'?process.env[reference]:undefined;const value=expansion.secrets.resolve(scope,reference,'deployment.use');if(!value&&expansion.secrets.registered(scope,reference))throw new HttpError(503,'SECRET_INACTIVE','등록한 환경 비밀의 시험된 활성 버전이 필요합니다.');return value??(configuration.mode==='local'?process.env[reference]:undefined);};
operations.authorizePublisher=(scope,actor,project)=>{expansion.authorizeJob(scope,actor,"project.publish");expansion.assertPublication(scope,project);};
operations.normalizeProject=project=>expansion.normalizeProjectWrite(store.project(project.id),project);
operations.observeStorageUsage=(scope,bytes)=>{const key='usage:storage:last:'+(scope.environmentId??scope.projectId),last=store.operations.state(key);if(last!==bytes){advancement.observeUsage(scope,'storage-'+randomUUID(),'storageBytes',bytes);store.operations.setState(key,bytes);}};
operations.reserveGenerationUsage=(scope,key)=>expansion.reserveUsage(scope,"generations",1,key).id;
operations.observeWorkerUsage=(scope,usage)=>advancement.observeUsage(scope,usage.operationId,'cpu',usage.cpuMs);
operations.settleGenerationUsage=(scope,id,success)=>{if(success){expansion.settleUsage(scope,id,1);advancement.observeUsage(scope,'generation-'+id,'generations',1);}else expansion.releaseUsage(scope,id);};
operations.resolveGenerationProject=async project=>{
  const next=structuredClone(project);
  for(const asset of next.assets)if(asset.blobRef)asset.data=await expansion.resolveBlob(project.id,asset.blobRef.id);
  return next;
};
queue.start(async (item, lease) => {
  lease.assertCurrent();
  advancement.assertJob(item.scope,item.kind);expansion.authorizeJob(item.scope,item.actorId,jobUseCase(item.kind).capability);lease.phase('execute');
  if (item.kind === "site.generate") {
    expansion.authorizeJob(item.scope, item.actorId, "project.publish");
    const value = record(item.payload), project = store.project(item.scope.projectId);
    if (!project) throw new HttpError(404, "PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
    if (value.revision !== undefined && value.revision !== project.revision) throw new HttpError(409, "REVISION_CONFLICT", "게시 요청 이후 원본이 변경되었습니다.");
    expansion.assertPublication(item.scope,project);
    return operations.enqueueAndWait(project, item.id, item.scope, lease.signal,item.actorId,lease.phase);
  }
  return executeInWorker(sourceRoot,path.join(dataRoot,"studio.sqlite"),dataRoot,item,lease.signal,configuration.workTimeoutMs,usage=>advancement.observeUsage(item.scope,usage.operationId,'cpu',usage.cpuMs));
});
let pollingEvents:Promise<void>|null=null;
const eventTimer=setInterval(()=>{if(pollingEvents)return;pollingEvents=(async()=>{store.recoverInterrupted();operations.recoverPromotions();await advancement.recoverPendingWorkflowRuns();for(let i=0;i<20;i++)if(!await delivery.deliverOne())break;for(const scope of persistedEnvironmentScopes(store.db)){let code:string|null=null;try{const site=await operations.scopeData(scope);expansion.configureRuntime(scope,site);await expansion.pollEvents(scope);}catch(error){code=error instanceof HttpError?error.code:'WORK_EVENTS_FAILED';}finally{store.db.prepare('INSERT INTO system_environment_cursors(environment_id,last_checked,last_success,last_error) VALUES(?,?,?,?) ON CONFLICT(environment_id) DO UPDATE SET last_checked=excluded.last_checked,last_success=COALESCE(excluded.last_success,last_success),last_error=excluded.last_error').run(scope.environmentId!,Date.now(),code?null:Date.now(),code);await operations.releaseIdleScope(scope);}}})().catch((error:unknown)=>{console.error(JSON.stringify({timestamp:new Date().toISOString(),level:"error",service:"automade-studio",operation:"automation.poll",errorCode:error instanceof HttpError?error.code:"WORK_EVENTS_FAILED"}));}).finally(()=>{pollingEvents=null;});},5000);eventTimer.unref();
let origin = "";
let vite: ViteDevServer | undefined;
const dev = process.argv[1]?.endsWith(".ts") ?? false;
const server = createServer((req, res) => {
  const requestId = randomUUID();
  const started = Date.now();
  const context=newOperation(requestId),traceId=context.traceId;
  headers(res);
  res.setHeader("X-Request-ID",requestId);
  res.setHeader('Traceparent',`00-${traceId}-${context.spanId}-01`);
  void operationContext.run(context,async () => {
    ensureOrigin(req, origin);
    const url = new URL(req.url ?? "/", origin);
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, "PATH", "Invalid path");
    }
    if (
      decodedPath.includes("\\") ||
      decodedPath.includes("\0") ||
      decodedPath.split("/").includes("..")
    )
      throw new HttpError(403, "PATH", "Invalid path");
    if (url.pathname === "/health") {
      reply(res, 200, {
        service: "automade-studio",
        status: "ok",
        workspaceId: createHash("sha256")
          .update(sourceRoot.toLowerCase())
          .digest("hex")
          .slice(0, 16),
        generatorVersion: GENERATOR_VERSION,
        buildHash:buildIdentity(sourceRoot).buildHash,
        apiProtocol:1,
        buildCommit:buildIdentity(sourceRoot).buildCommit,
      });
      return;
    }
    if(url.pathname==='/ready'){const value=readiness(sourceRoot,dataRoot,store,systemRuntime.draining);reply(res,value.ready?200:503,{ready:value.ready,status:value.status});return;}
    if(url.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(req.method??'GET')){if(systemRuntime.draining)throw new HttpError(503,'SERVICE_DRAINING','Service is draining');if(/generate|publish|promote|checkout|refund|workflow.*run|deployment/.test(url.pathname)&&!readiness(sourceRoot,dataRoot,store,false).ready)throw new HttpError(503,'SERVICE_NOT_READY','Service is not ready for new cost or publication work');}
    const ownerCookie = String(req.headers.cookie ?? "").split(";").map(x => x.trim()).find(x => x.startsWith("automade-session="))?.slice(17);
    const ownerSession = configuration.mode === "local" ? sessions.get(ownerCookie) : null;
    const localOwner = Boolean(ownerSession);
    const creator = expansion.authenticateCreator(req);
    const previewContext={creator,localOwner,sessionKey:creator?`creator:${creator.id}:${creator.sessionId}`:createHash('sha256').update(ownerCookie??'').digest('hex')};
    if(url.pathname.startsWith('/preview/')&&await privatePreview.handle(req,res,url,previewContext))return;
    const ownerToken = String(req.headers["x-csrf-token"] ?? "");
    const trustedCsrf = Boolean(ownerSession && ownerToken.length === ownerSession.csrf.length && timingSafeEqual(Buffer.from(ownerToken), Buffer.from(ownerSession.csrf)));
    if (url.pathname === "/api/session" && req.method === "GET") {
      rates.check(`session:${req.socket.remoteAddress}`, 100);
      const cookie = String(req.headers.cookie ?? "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("automade-session="))
        ?.slice(17);
      if (configuration.mode === "managed") { const value = expansion.auth.session(req, res, origin, false); reply(res, 200, { csrf: value.csrf, role: value.account ? "creator" : "anonymous" }); return; }
      let session = sessions.get(cookie);
      let token = cookie;
      if (!session || session.expires < Date.now()) {
        const created = sessions.create(); token = created.token; session = created;
      }
      res.setHeader(
        "Set-Cookie",
        `automade-session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      );
      reply(res, 200, { csrf: session.csrf, role: "local-owner" });
      return;
    }
    if (url.pathname.startsWith("/api/expansion/") || url.pathname.startsWith("/api/v1/")) {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET") && !url.pathname.startsWith("/api/v1/") && !url.pathname.startsWith("/api/expansion/webhooks/")) ensureOrigin(req, origin, true);
      const initialLocalSession = configuration.mode === "local" && url.pathname === "/api/expansion/session" && req.method === "GET";
      if (await expansion.handle(req, res, url, { requestId, localOwner: localOwner || initialLocalSession, trustedCsrf, origin, creator })) return;
    }
    // Provider callbacks authenticate their raw body signature, without a browser session.
    if(req.method==="POST"&&/^\/api\/platform\/(?:billing\/)?webhooks\/[a-zA-Z0-9_-]+$/.test(url.pathname)){
      const projectId=url.searchParams.get("projectId"),environmentId=url.searchParams.get("environmentId");
      if(!projectId&&!environmentId)throw new HttpError(400,"PROJECT_SCOPE","웹훅의 프로젝트 또는 환경 범위를 지정하세요.");
      const scope=expansion.access.resolve({...(projectId?{projectId}:{}),...(environmentId?{environmentId}:{})});
      await operations.withProjectRequest(scope.projectId,async()=>{
        const data=await operations.scopeData(scope);expansion.configureRuntime(scope,data);
        if(!await handlePlatformRequest(req,res,url,{db:data.db,requestId,projectId:scope.projectId,localOwner:false,origin,assertWritable:()=>data.assertWritable()}))throw new HttpError(404,"WEBHOOK_ROUTE","웹훅 경로를 확인하세요.");
      });return;
    }
    let requestScope: ReturnType<typeof expansion.guardRequest> = null;
    if (url.pathname.startsWith("/api/")) {
      if (!creator && !localOwner) throw new HttpError(401, "SESSION", "제작자 로그인 또는 로컬 세션이 필요합니다.");
      const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET");
      if (mutation) { ensureOrigin(req, origin, true); if (creator) expansion.auth.csrf(req); else if (!trustedCsrf) throw new HttpError(403, "CSRF", "요청 인증에 실패했습니다."); }
      const optionalCommandBody=req.method==="POST"&&/^\/api\/exports\/[a-zA-Z0-9_-]+\/(?:stop|restart|cancel|retry|design-rollback)$/.test(url.pathname)||req.method==='DELETE'&&/^\/api\/advancement\/runtime\/previews\/[a-f0-9]{64}$/.test(url.pathname);
      const parsedBody = mutation && !optionalCommandBody && String(req.headers["content-type"] ?? "").startsWith("application/json") ? await body(req) : undefined;
      if(parsedBody&&typeof parsedBody==='object'){const commandInput=record(parsedBody);const base=commandInput.baseRevision??commandInput.expectedRevision;if(Number.isSafeInteger(base)&&Number(base)>=0)context.baseRevision=Number(base);const key=commandInput.requestKey??commandInput.commandId;if(typeof key==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(key))context.requestKey=key;context.fingerprint=createHash('sha256').update(JSON.stringify(parsedBody)).digest('hex');}
      requestScope = url.pathname.startsWith('/api/advancement/')?null:expansion.guardRequest(req, url, { localOwner, creator, parsedBody });
      bindOperation(requestScope??undefined,creator?.id??'local-owner',creator?'creator':'local-owner');
      if(systemRuntime.draining&&!['GET','HEAD','OPTIONS'].includes(req.method??'GET'))throw new HttpError(503,'SERVICE_DRAINING','서버가 안전하게 종료 중입니다. 잠시 후 다시 시도하세요.');
      if(!url.pathname.startsWith('/api/advancement/'))advancement.assertRequest(req,url,{creator,localOwner,scope:requestScope,input:parsedBody});
      if(requestScope&&/\/(?:data-backups|data-transfer)(?:\/|$)/.test(url.pathname))expansion.access.authorize(creator,requestScope,"backup.restore",localOwner);
      if(requestScope&&url.pathname.endsWith("/deployment")&&req.method==="PUT")expansion.access.authorize(creator,requestScope,"connection.manage",localOwner);
    }
    if(await privatePreview.handle(req,res,url,previewContext))return;
    if(await systemRuntime.handle(req,res,url,{creator,localOwner}))return;
    if(await advancement.handle(req,res,url,{creator,localOwner,origin,requestId}))return;
    if(url.pathname.startsWith("/api/work-items")){
      const match=url.pathname.match(/^\/api\/work-items(?:\/([a-zA-Z0-9_-]+)(?:\/(cancel|retry))?)?$/);
      if(!match)throw new HttpError(404,"WORK_NOT_FOUND","작업 경로를 확인하세요.");
      const id=match[1],action=match[2],scope=requestScope;
      if(!scope)throw new HttpError(400,"WORK_SCOPE","작업을 조회할 프로젝트를 선택하세요.");
      if(url.searchParams.get("organizationId")&&url.searchParams.get("organizationId")!==scope.organizationId)throw new HttpError(403,"SCOPE_MISMATCH","조직 범위가 다릅니다.");
      const can=(kind:string):void=>{expansion.access.authorize(creator,scope,kind==="workflow.run"?"automation.manage":kind.startsWith("booking.")?"data.write":"project.publish",localOwner);};
      const publicItem=(item:ReturnType<WorkQueue["list"]>[number])=>({...item,payload:null,result:null});
      if(id==="metrics"&&req.method==="GET"){reply(res,200,queue.metrics(scope.organizationId,scope.projectId,scope.environmentId));return;}
      if(!id&&req.method==="GET"){reply(res,200,queue.list(scope.organizationId,100,scope.projectId,scope.environmentId).map(publicItem));return;}
      const item=id?queue.get(id):null;
      if(!item||item.scope.organizationId!==scope.organizationId||item.scope.projectId!==scope.projectId||scope.environmentId&&item.scope.environmentId!==scope.environmentId)throw new HttpError(404,"WORK_NOT_FOUND","선택한 범위의 작업을 찾을 수 없습니다.");
      if(!action&&req.method==="GET"){reply(res,200,publicItem(item));return;}
      can(item.kind);
      if(action==="cancel"&&req.method==="POST"){queue.cancel(item.id);reply(res,200,publicItem(queue.get(item.id)!));return;}
      if(action==="retry"&&req.method==="POST"){await body(req,2000);if(item.status==='unknown')advancement.evidence.assertRetry(scope,item.id);reply(res,202,publicItem(queue.retry(item.id,item.status==='unknown')));return;}
      throw new HttpError(405,"METHOD","작업 요청 방식을 확인하세요.");
    }
    if (url.pathname.startsWith("/api/platform/")) {
      rates.check(req.socket.remoteAddress ?? "local", 300);
      const projectId = url.searchParams.get("projectId") ?? undefined;
      if (configuration.mode === "managed" && !requestScope) throw new HttpError(400, "PROJECT_SCOPE", "운영 API에는 사이트 범위가 필요합니다.");
      const dispatch=async():Promise<boolean>=>{
        const data = requestScope ? await operations.scopeData(requestScope) : projectId ? await operations.projectData(projectId) : store;
        if(requestScope)expansion.configureRuntime(requestScope,data);
        if(projectId&&url.pathname==="/api/platform/usage"&&req.method==="GET")await operations.measureStorage(projectId,requestScope??undefined);
        return await handlePlatformRequest(req, res, url, { db: data.db, requestId, projectId, localOwner: localOwner || Boolean(creator && requestScope), origin, trustedCsrf: trustedCsrf || Boolean(creator && requestScope), assertWritable: () => data.assertWritable() });
      };
      if (await (projectId?operations.withProjectRequest(projectId,dispatch):dispatch())) return;
    }
    if (url.pathname.startsWith("/api/")) {
      rates.check(req.socket.remoteAddress ?? "local", 300);
      if (url.pathname === "/api/projects" && req.method === "GET") {
        const permitted = new Set(expansion.accessibleProjectIds(creator, localOwner));
        reply(res, 200, store.projects().filter(p => permitted.has(p.id)));
        return;
      }
      const projectResource = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)$/);
      const commands=url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/commands$/);
      if(commands){const projectId=commands[1]!,scope=expansion.access.resolve({projectId});expansion.access.authorize(creator,scope,req.method==='GET'?'project.read':'project.edit',localOwner);const actorKey=creator?`creator:${creator.id}`:'local-owner';
        if(req.method==='GET'){reply(res,200,store.commandReceipts(projectId,actorKey,(url.searchParams.get('ids')??'').split(',').filter(Boolean)));return;}
        if(req.method==='POST'){const command=parseProjectCommand(await body(req,16000000));context.baseRevision=command.baseRevision;context.requestKey=command.commandId;context.fingerprint=commandFingerprint(command);const current=store.project(projectId);if(!current)throw new HttpError(404,'PROJECT_NOT_FOUND','프로젝트를 찾을 수 없습니다.');const receipt=store.db.prepare('SELECT fingerprint FROM system_command_receipts WHERE actor_key=? AND project_id=? AND command_id=?').get(actorKey,projectId,command.commandId);if(!receipt){const candidate=expansion.normalizeProjectWrite(current,applyProjectCommand(current,command));await expansion.validateProjectAssets(candidate,creator,localOwner);}expansion.access.authorize(creator,scope,'project.edit',localOwner);const ack=store.saveCommand(projectId,actorKey,command.commandId,commandFingerprint(command),canonical=>{const candidate=expansion.normalizeProjectWrite(canonical,applyProjectCommand(canonical,command));verifyAssets(candidate,{allowBlobReferences:true});return candidate;});reply(res,200,ack);return;}
        throw new HttpError(405,'METHOD','명령 요청 방식을 확인하세요.');
      }
      if (projectResource && req.method === "GET") { const project = store.project(projectResource[1]!); if (!project) throw new HttpError(404, "PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다."); reply(res, 200, project); return; }
      if (url.pathname === "/api/save-project" && req.method === "POST") {
        const raw = record(await body(req));
        const submitted = parseProject(raw.project ?? raw),p=expansion.normalizeProjectWrite(store.project(submitted.id),submitted);
        await expansion.validateProjectAssets(p,creator,localOwner);
        expansion.guardRequest(req,url,{localOwner,creator,parsedBody:raw});
        verifyAssets(p,{allowBlobReferences:true});
        const base = typeof raw.baseRevision === "number" ? raw.baseRevision : undefined;
        if (configuration.mode === "managed" && base === undefined) throw new HttpError(400, "BASE_REVISION", "저장 기준 버전이 필요합니다.");
        const newProject = !store.project(p.id);
        store.save(p, base);
        if (newProject) expansion.registerProject(p, requestScope?.workspaceId ?? "local", creator, localOwner);
        reply(res, 200, {
          revision: p.revision,
          projectId: p.id,
          source: "SQLite",
        });
        return;
      }
      if (url.pathname === "/api/projects" && req.method === "PUT") {
        const raw = record(await body(req)), submitted = parseProject(raw.project ?? raw), project=expansion.normalizeProjectWrite(store.project(submitted.id),submitted);
        await expansion.validateProjectAssets(project,creator,localOwner);
        expansion.guardRequest(req,url,{localOwner,creator,parsedBody:raw});
        verifyAssets(project,{allowBlobReferences:true});
        const base = typeof raw.baseRevision === "number" ? raw.baseRevision : undefined;
        if (configuration.mode === "managed" && base === undefined) throw new HttpError(400, "BASE_REVISION", "저장 기준 버전이 필요합니다.");
        const newProject = !store.project(project.id);
        store.save(project, base);
        if (newProject) expansion.registerProject(project, requestScope?.workspaceId ?? "local", creator, localOwner);
        reply(res, 200, { revision: project.revision, project });
        return;
      }
      const backup = url.pathname.match(
        /^\/api\/projects\/([a-zA-Z0-9_-]+)\/backups$/,
      );
      if (backup && req.method === "GET") {
        reply(res, 200, store.backups(backup[1]!));
        return;
      }
      if (url.pathname === "/api/generate" && req.method === "POST") {
        rates.check("generate", 5);
        const raw = record(await body(req, 20000));
        if (
          typeof raw.prompt !== "string" ||
          raw.prompt.length > 5000 ||
          !raw.prompt.trim() ||
          typeof raw.name !== "string" ||
          raw.name.length > 200
        )
          throw new HttpError(
            400,
            "BRIEF",
            "사이트 이름과 5000자 이내 요구 내용을 입력하세요.",
          );
        const template = TEMPLATES.find(t => t.id === raw.template)?.id;
        if (raw.template !== undefined && !template) throw new HttpError(400, "TEMPLATE", "템플릿을 확인하세요.");
        if (raw.mode !== undefined && raw.mode !== "template" && raw.mode !== "recommend") throw new HttpError(400, "GENERATION_MODE", "초안 생성 방식을 확인하세요.");
        const materials = raw.materials === undefined ? [] : raw.materials;
        if (!Array.isArray(materials) || materials.length > 100 || materials.some(x => typeof x !== "string" || x.length > 1000)) throw new HttpError(400,"BRIEF_MATERIALS","실제 자료는 1000자 이내 최대 100개입니다.");
        for (const field of ["audience", "primaryGoal", "tone"] as const) if (raw[field] !== undefined && (typeof raw[field] !== "string" || String(raw[field]).length > 1000)) throw new HttpError(400,"BRIEF", "목적별 안내 내용을 확인하세요.");
        const purpose = ["business","portfolio","service","workspace"].includes(String(raw.purpose)) ? raw.purpose as "business"|"portfolio"|"service"|"workspace" : "business";
        const brief = {purpose, audience:String(raw.audience??""), primaryGoal:String(raw.primaryGoal??""), tone:String(raw.tone??""), materials:materials as string[]};
        const workspaceId=url.searchParams.get("workspaceId")??(configuration.mode==="local"&&localOwner?"local":undefined);
        if(!workspaceId)throw new HttpError(400,"WORKSPACE_REQUIRED","초안을 만들 작업공간을 지정하세요.");
        const workspace=expansion.access.workspace(creator,workspaceId,"project.create",localOwner);
        reserveGeneration(store,workspace.organizationId);
        reply(res, 200, await generateFromBrief(raw.prompt, raw.name, {template:template as TemplateId|undefined,mode:raw.mode === "template"?"template":"recommend",brief}));
        return;
      }
      if (url.pathname === "/api/generate/proposal" && req.method === "POST") {
        rates.check("generate", 5);
        if (!process.env.GENERATION_API_URL) throw new HttpError(503,"GENERATION_NOT_CONFIGURED","AI 공급자를 연결하면 선택 영역의 문구·번역·디자인 제안을 사용할 수 있습니다.");
        const raw = record(await body(req));
        const project = parseProject(raw.project);
        if (typeof raw.instruction !== "string" || !raw.instruction.trim() || raw.instruction.length > 5000 || !["copy","tone","translate","layout","mobile"].includes(String(raw.operation))) throw new HttpError(400,"PROPOSAL","제안 범위와 5000자 이내 지시를 확인하세요.");
        const blockId = typeof raw.blockId === "string" ? raw.blockId : "";
        if (blockId && !project.blocks.some(b=>b.id===blockId)) throw new HttpError(400,"PROPOSAL_TARGET","수정할 블록을 확인하세요.");
        const scopeRaw=raw.scope===undefined?null:record(raw.scope);
        if(scopeRaw?.allowedFieldIds!==undefined&&!Array.isArray(scopeRaw.allowedFieldIds))throw new HttpError(400,"PROPOSAL_SCOPE","허용 필드 목록을 확인하세요.");
        const proposalScope:ProposalScope=scopeRaw?{kind:scopeRaw.kind as ProposalScope["kind"],...(typeof scopeRaw.targetId==="string"?{targetId:scopeRaw.targetId}:{}),...(Array.isArray(scopeRaw.allowedFieldIds)?{allowedFieldIds:scopeRaw.allowedFieldIds as ProposalScope["allowedFieldIds"]}:{})}:blockId?{kind:"block",targetId:blockId}:{kind:"site"};
        validateProposalScope(project,proposalScope);
        if(!requestScope)throw new HttpError(400,"PROJECT_SCOPE","제안 대상 프로젝트를 지정하세요.");
        expansion.access.authorize(creator,requestScope,"project.edit",localOwner);
        reserveGeneration(store,requestScope.organizationId);
        const result = await generateFromBrief(`${raw.instruction}\n선택한 수정 범위 밖의 콘텐츠는 유지하세요.`, project.name, {baseProject:project,operation:String(raw.operation),targetBlockId:blockId||undefined,proposalScope});
        reply(res,200,{...result,project:mergeScopedProposal(project,result.project,raw.operation as ProposalOperation,proposalScope),external:true});return;
      }
      if (url.pathname === "/api/generate/settings" && req.method === "GET") { reply(res,200,generationSettings(store)); return; }
      if(url.pathname==="/api/exports"&&req.method==="POST"){
        const submitted=parseProject(record(await body(req)).project),project=expansion.normalizeProjectWrite(store.project(submitted.id),submitted);
        await expansion.validateProjectAssets(project,creator,localOwner);
        requestScope=expansion.guardRequest(req,url,{localOwner,creator,parsedBody:await body(req)});
        if(!store.project(project.id)){store.save(project,-1);expansion.registerProject(project,requestScope?.workspaceId??"local",creator,localOwner);requestScope=expansion.resolveProjectScope(project.id);}
        if(requestScope)expansion.assertPublication(requestScope,project);
      }
      if (await operations.handle(req, res, url, new Set(expansion.accessibleProjectIds(creator, localOwner)), requestScope ?? undefined,creator?.id??"local-owner")) return;
      throw new HttpError(404, "NOT_FOUND", "요청한 기능이 없습니다.");
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new HttpError(405, "METHOD", "지원하지 않는 요청입니다.");
    if (vite) {
      vite.middlewares(req, res, () =>
        reply(res, 404, null, {
          code: "NOT_FOUND",
          message: "페이지가 없습니다.",
        }),
      );
      return;
    }
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    await staticFile(path.join(sourceRoot, "dist"), url.pathname, res, true);
  })
    .catch((error) => fail(res, error, requestId))
    .finally(() => {
      if(req.url?.startsWith('/api/')){try{const scope=context.scope,finished=Date.now();store.db.prepare('INSERT INTO system_trace_spans VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(context.spanId,traceId,null,studioOperation(req.url),scope?.organizationId??null,scope?.projectId??null,scope?.environmentId??null,started,finished-started,res.statusCode>=400?'error':'ok',res.statusCode>=400?`HTTP_${res.statusCode}`:null);store.db.prepare('INSERT INTO system_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(context.operationId,requestId,traceId,context.actorKey??null,context.realm??'system',scope?.organizationId??null,scope?.projectId??null,scope?.environmentId??null,context.baseRevision??null,context.requestKey??null,context.fingerprint??null,context.policyVersion,(req.method??'GET')+':'+studioOperation(req.url),res.statusCode>=400?'failed':'succeeded',started,finished,res.statusCode>=400?`HTTP_${res.statusCode}`:null);}catch(error){console.error(JSON.stringify({timestamp:new Date().toISOString(),level:'error',service:'automade-studio',requestId,traceId,operation:'observability.persist',errorCode:error instanceof HttpError?error.code:'TELEMETRY_STORE_FAILED'}));}}
      if (req.url?.startsWith("/api/"))
        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "info",
            service: "automade",
            requestId,
            traceId,
            operationId:context.operationId,
            operation: studioOperation(req.url??"/"),
            durationMs: Date.now() - started,
            status: res.statusCode,
          }),
        );
    });
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
if (dev) {
  const { createServer } = await import("vite");
  vite = await createServer({
    root: sourceRoot,
    server: {
      middlewareMode: true,
      watch: {
        ignored: [
          exportRoot.replaceAll("\\", "/") + "/**",
          dataRoot.replaceAll("\\", "/") + "/**",
        ],
      },
    },
    appType: "spa",
  });
}
const configured = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(configured) || configured < 0 || configured > 65535)
  throw new Error("PORT must be 0..65535");
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(configured, configuration.host, () => {
    server.off("error", reject);
    resolve();
  });
});
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Invalid server address");
origin = configuration.publicOrigin ?? `http://127.0.0.1:${address.port}`;
console.log(`AUTOMADE_URL=${origin}`);
let telemetryTask:Promise<void>|null=null;const telemetryTimer=setInterval(()=>{if(telemetryTask)return;telemetryTask=(async()=>{await exportOtlp(store.db);store.db.prepare('DELETE FROM system_trace_spans WHERE started_at<?').run(Date.now()-30*86400000);store.db.prepare('DELETE FROM system_operations WHERE started_at<?').run(Date.now()-30*86400000);store.db.prepare("DELETE FROM runtime_state WHERE key LIKE 'system:preview:%' AND json_valid(value) AND json_extract(value,'$.expiresAt')<?").run(Date.now());})().catch(()=>console.error(JSON.stringify({timestamp:new Date().toISOString(),level:'error',service:'automade-studio',operation:'telemetry.maintain',errorCode:'TELEMETRY_MAINTENANCE_FAILED'}))).finally(()=>{telemetryTask=null;});},10000);telemetryTimer.unref();
let stopping=false;
const stop = async () => {
  if(stopping)return;stopping=true;
  systemRuntime.draining=true;
  const hardStop=setTimeout(()=>{console.error(JSON.stringify({timestamp:new Date().toISOString(),level:'error',service:'automade-studio',operation:'shutdown.deadline',errorCode:'SHUTDOWN_TIMEOUT'}));process.exit(1);},30000);hardStop.unref();
  const drained=new Promise<void>(resolve=>server.close(()=>resolve()));
  server.closeIdleConnections();
  await vite?.close();
  clearInterval(eventTimer);clearInterval(telemetryTimer);
  const forceClose=setTimeout(()=>server.closeAllConnections(),queue.policy().drainMs);forceClose.unref();
  await queue.close();await drained;clearTimeout(forceClose);await pollingEvents;await telemetryTask;
  await expansion.close();
  await operations.close();
  store.close();
  process.exit(0);
};
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
