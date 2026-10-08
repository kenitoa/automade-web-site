import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, lstat, rename, readdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { inspectPortableDatabase } from "./dataPortability";
import { compareOperationalData, persistReconciliation, type ReconciliationReport } from "./expansion/reconciliation";
import path from "node:path";
import { Store } from "./store";
import { verifyAssets } from "./generator";
import { generateInWorker, startSiteInWorker, type IsolatedSite } from "./workerClient";
import { ResourceLeases } from "./workQueue";
import type { ExpansionScope } from "../src/domain/expansion";
import { sourceArchive } from "./archive";
import { body, contained, HttpError, reply, RateLimit } from "./http";
import { parseProject, record } from "../src/domain/validation";
import type { Project } from "../src/domain/types";
import type { DataBackup, SiteSummary } from "../src/domain/operations";
import type { SubmissionFilter } from "./operationsStore";
import { startPlatformWorker } from "./platform/index";
import { DeploymentService,deploymentBundle } from "./deploymentService";
import { checkUsageLimit, consumeUsage, period } from "./platform/common";
import { RetentionService } from "./retentionService";

import type {WorkerUsage} from "./workerUsage";

const csvCell=(value:string):string=>`"${(/^[=+@\-\t\r]/.test(value)?"'":"")+value.replaceAll('"','""')}"`;
const idPattern=/^[a-zA-Z0-9_-]{1,100}$/;
type ResourceLease=ReturnType<ResourceLeases["acquire"]>;
export class OperationsService {
  readonly sites=new Map<string,IsolatedSite>();
  readonly leases: ResourceLeases;
  readonly dataScopes=new Map<string,ExpansionScope>();
  authorizePublisher:(scope:ExpansionScope,actor?:string,project?:Project)=>void=()=>{};
  private siteKeys=new Map<string,string>();
  private liveSiteLeases=new Map<string,ResourceLease[]>();
  private leaseHeartbeat:ReturnType<typeof setInterval>;
  runtimeSecrets: (scope: ExpansionScope,site?:Store) => Promise<Record<string,string>> = async () => ({});
  resolveGenerationProject: (project: Project) => Promise<Project> = async project => project;
  normalizeProject:(project:Project)=>Project=project=>project;
  reserveGenerationUsage:(scope:ExpansionScope,key:string)=>string=()=>"";
  observeStorageUsage:(scope:ExpansionScope,bytes:number)=>void=()=>{};
  observeWorkerUsage:(scope:ExpansionScope,usage:WorkerUsage)=>void=()=>{};
  settleGenerationUsage:(scope:ExpansionScope,id:string,success:boolean)=>void=()=>{};
  beforeDataRestore:(scope:ExpansionScope,site:Store)=>unknown=()=>null;
  afterDataRestore:(scope:ExpansionScope,site:Store,checkpoint:unknown)=>void=()=>{};
  private builds=new Map<string,AbortController>();
  private buildingProjects=new Set<string>();
  private rates=new RateLimit();
  private canonicalStores=new Map<string,{store:Store;stopWorker:()=>Promise<void>;lease:ResourceLease}>();
  private tasks=new Set<Promise<void>>();
  private projectRequests=new Map<string,number>();
  private restoringProjects=new Set<string>();
  readonly deployment:DeploymentService;
  readonly retention:RetentionService;
  constructor(readonly store:Store,readonly sourceRoot:string,readonly exportRoot:string,readonly dataRoot:string) {
    this.leases = new ResourceLeases(store.db);
    this.deployment=new DeploymentService(store,id=>this.artifact(id));
    this.retention=new RetentionService(store,exportRoot,dataRoot,()=>new Set([...this.sites.keys(),...this.builds.keys(),...this.leases.resources("artifact:").map(resource=>resource.slice(9))]),project=>this.buildingProjects.has(project)||this.projectRequests.has(project)||this.leases.active(`generation:${project}`));
    this.retention.start();
    this.leaseHeartbeat=setInterval(()=>{try{for(const [id,leases]of this.liveSiteLeases){if(leases.some(lease=>!lease.renew())){const site=this.sites.get(id);site?.pauseWrites(true);void site?.close().then(()=>this.sites.delete(id)).catch(()=>console.error(JSON.stringify({timestamp:new Date().toISOString(),level:"error",service:"automade-studio",operation:"site.lease-close",errorCode:"SITE_CLOSE_FAILED"})));}}for(const entry of this.canonicalStores.values())entry.lease.renew();}catch{for(const site of this.sites.values())site.pauseWrites(true);for(const controller of this.builds.values())controller.abort();console.error(JSON.stringify({timestamp:new Date().toISOString(),level:"error",service:"automade-studio",operation:"leases.renew",errorCode:"LEASE_RENEW_FAILED"}));}},5000);this.leaseHeartbeat.unref();
  }
  private async artifact(id:string):Promise<{directory:string;projectId:string;project:Project}> {
    this.retention.assertAvailable(id);
    const saved=this.store.exportRecord(id);
    if(!saved||saved.status!=="ready"||!contained(this.exportRoot,saved.directory))throw new HttpError(404,"ARTIFACT_NOT_FOUND","완료된 결과물을 찾을 수 없습니다.");
    const resolved=await realpath(saved.directory);
    if(!contained(await realpath(this.exportRoot),resolved))throw new HttpError(403,"PATH","결과물 경로를 확인하세요.");
    const source=await realpath(path.join(resolved,"output/project.interface.json"));
    if(!contained(resolved,source))throw new HttpError(403,"PATH","편집 원본 경로를 확인하세요.");
    const raw=record(JSON.parse(await readFile(source,"utf8")) as unknown);
    return {directory:resolved,projectId:saved.project_id,project:parseProject(raw.project??raw)};
  }
  private activeRelease(projectId: string, dataKey = projectId): string | null {
    return dataKey === projectId ? this.store.operations.projectRelease(projectId) : this.store.operations.state(`environment:release:${dataKey}`) as string | null;
  }
  private activate(projectId: string, dataKey: string, releaseId: string): void {
    if (dataKey === projectId) this.store.operations.activateProject(projectId, releaseId);
    else this.store.operations.setState(`environment:release:${dataKey}`, releaseId);
  }
  private async siteFile(projectId:string,dataKey=projectId):Promise<string> {
    if(!idPattern.test(projectId)||!idPattern.test(dataKey))throw new HttpError(400,"PROJECT_ID","프로젝트를 확인하세요.");
    const folder=path.join(this.dataRoot,"sites",dataKey);
    await mkdir(folder,{recursive:true});
    if(!contained(await realpath(this.dataRoot),await realpath(folder)))throw new HttpError(403,"PATH","데이터 저장 경로를 확인하세요.");
    const pointer=this.store.operations.state(`storage:active:${dataKey}`);
    let file=path.join(folder,"site.sqlite");
    if(pointer){const candidate=record(pointer).file;if(typeof candidate!=='string'||!path.isAbsolute(candidate)||path.extname(candidate)!=='.sqlite'||!contained(await realpath(this.dataRoot),path.resolve(candidate)))throw new HttpError(403,'STORAGE_PATH','승인된 저장소 경로가 아닙니다.');for(let current=path.resolve(candidate);current!==path.resolve(this.dataRoot);current=path.dirname(current))if((await lstat(current)).isSymbolicLink())throw new HttpError(403,'STORAGE_PATH','저장소 연결 경로를 사용할 수 없습니다.');if(!(await lstat(candidate)).isFile()||!contained(await realpath(this.dataRoot),await realpath(candidate)))throw new HttpError(403,'STORAGE_PATH','저장소 파일을 확인하세요.');file=candidate;}
    try { await stat(file);if(!contained(await realpath(this.dataRoot),await realpath(file)))throw new HttpError(403,"PATH","데이터 파일 경로를 확인하세요."); }
    catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
      const previous=dataKey===projectId?this.store.latestDirectory(projectId):null;
      if(previous&&contained(this.exportRoot,previous)&&contained(await realpath(this.exportRoot),await realpath(previous))){
        const source=path.join(previous,"output/.site-data.sqlite");
        try {await stat(source);if(!contained(await realpath(this.exportRoot),await realpath(source)))throw new HttpError(403,"PATH","이전 데이터 파일 경로를 확인하세요.");const db=new Store(source);try{db.snapshot(file);}finally{db.close();}}
        catch(cause){if((cause as NodeJS.ErrnoException).code!=="ENOENT")throw cause;}
      }
    }
    const db=new Store(file);
    try {
      let active=this.activeRelease(projectId,dataKey);
      if(active&&this.store.exportRecord(active)?.status!=="ready")active=null;
      if(!active&&dataKey===projectId){
        const row=this.store.db.prepare("SELECT id FROM exports WHERE project_id=? AND status='ready' ORDER BY created_at DESC LIMIT 1").get(projectId);
        if(row){active=String(row.id);this.store.operations.activateProject(projectId,active);}
      }
      if(active&&db.activeRelease()!==active)db.activateRelease(active);
      // A process restart cannot retain a transient generation pause.
      if(!this.leases.active(`generation:${projectId}`))db.pauseProjectWrites(false);
    }finally{db.close();}
    return file;
  }
  async projectData(projectId:string):Promise<Store> {
    return this.dataFor(projectId,projectId);
  }
  async currentScopeFile(scope:ExpansionScope):Promise<string>{await this.scopeData(scope);return this.siteFile(scope.projectId,scope.dataKey??scope.projectId);}
  async scopeData(scope:ExpansionScope):Promise<Store> {
    const row=scope.environmentId?this.store.db.prepare("SELECT * FROM expansion_environments WHERE id=?").get(scope.environmentId):this.store.db.prepare("SELECT *,project_id AS data_key FROM expansion_project_scopes WHERE project_id=?").get(scope.projectId);
    if(!row||row.project_id!==scope.projectId||row.workspace_id!==scope.workspaceId||row.organization_id!==scope.organizationId||String(row.data_key)!==(scope.dataKey??scope.projectId)||(scope.siteId&&row.site_id!==scope.siteId))throw new HttpError(403,"SCOPE_MISMATCH","운영 데이터 소유 범위가 일치하지 않습니다.");
    const data=await this.dataFor(scope.projectId,scope.dataKey??scope.projectId);this.dataScopes.set(scope.dataKey??scope.projectId,scope);return data;
  }
  async backupScope(scope:ExpansionScope):Promise<DataBackup>{return this.backup(scope.projectId,"consistent-set",scope);}
  async restoreScope(scope:ExpansionScope,backupId:string):Promise<unknown>{return this.restore(scope.projectId,backupId,scope);}
  async withScopeFreeze<T>(scope:ExpansionScope,work:(site:Store,guard:{studioFile:string;tokens:{resource:string;token:string}[]})=>Promise<T>):Promise<T>{
    const projectId=scope.projectId,dataKey=scope.dataKey??projectId;
    if(this.restoringProjects.has(projectId)||this.projectRequests.has(projectId))throw new HttpError(409,"OPERATIONS_BUSY","다른 운영 요청이 끝난 뒤 다시 시도하세요.");
    const generation=this.leases.acquire(`generation:${projectId}`,randomUUID(),"exclusive",300000),stopped:string[]=[];let dataLease:ResourceLease|undefined,site:Store|undefined;
    this.restoringProjects.add(projectId);let leaseLost=false;const heartbeat=setInterval(()=>{try{if(!generation.renew()||dataLease&&!dataLease.renew())leaseLost=true;}catch{leaseLost=true;}},5000);heartbeat.unref();
    try{
      for(const [id,running]of this.sites)if(running.projectId===projectId&&(this.siteKeys.get(id)??projectId)===dataKey){await running.close();this.sites.delete(id);stopped.push(id);}
      const cached=this.canonicalStores.get(dataKey);if(cached){await cached.stopWorker();cached.store.close();this.canonicalStores.delete(dataKey);}
      dataLease=this.leases.acquire(`site-data:${dataKey}`,randomUUID(),"exclusive",300000);
      site=new Store(await this.siteFile(projectId,dataKey));site.pauseProjectWrites(true);generation.assertCurrent();dataLease.assertCurrent();const result=await work(site,{studioFile:path.join(this.dataRoot,'studio.sqlite'),tokens:[{resource:`generation:${projectId}`,token:generation.token},{resource:`site-data:${dataKey}`,token:dataLease.token}]});if(leaseLost)throw new HttpError(409,'LEASE_LOST','Scope lease renewal failed');generation.assertCurrent();dataLease.assertCurrent();return result;
    }finally{
      try{if(site){generation.assertCurrent();dataLease?.assertCurrent();site.pauseProjectWrites(false);}}finally{site?.close();clearInterval(heartbeat);dataLease?.release();generation.release();this.restoringProjects.delete(projectId);}
      for(const id of stopped){const artifact=await this.artifact(id);const running=await this.launchSite(path.join(artifact.directory,"output"),artifact.project,{dataFile:await this.siteFile(projectId,dataKey),releaseId:id,readOnly:this.activeRelease(projectId,dataKey)!==id,secrets:await this.runtimeSecrets(scope)},dataKey);this.sites.set(id,running);this.siteKeys.set(id,dataKey);}
    }
  }
  async releaseIdleScope(scope:ExpansionScope):Promise<void>{
    const dataKey=scope.dataKey??scope.projectId;if(this.projectRequests.has(scope.projectId)||this.buildingProjects.has(scope.projectId)||[...this.siteKeys.values()].includes(dataKey))return;
    const entry=this.canonicalStores.get(dataKey);if(entry){await entry.stopWorker();entry.store.close();this.canonicalStores.delete(dataKey);this.dataScopes.delete(dataKey);}
  }
  async releasePreview(releaseId:string,source:ExpansionScope,target:ExpansionScope):Promise<Record<string,unknown>>{
    const artifact=await this.artifact(releaseId),saved=this.store.operations.state(`generation:scope:${releaseId}`) as ExpansionScope|null;
    if(artifact.projectId!==source.projectId||target.projectId!==source.projectId||target.organizationId!==source.organizationId||target.workspaceId!==source.workspaceId||(saved?.dataKey??artifact.projectId)!==(source.dataKey??source.projectId))throw new HttpError(403,'RELEASE_SCOPE','같은 사이트의 원본 환경과 대상 환경을 선택하세요.');
    if(!target.environmentId||source.environmentId===target.environmentId)throw new HttpError(400,'RELEASE_TARGET','서로 다른 환경을 선택하세요.');
    const config=this.store.db.prepare('SELECT config_version,config FROM expansion_environments WHERE id=?').get(target.environmentId);if(!config)throw new HttpError(404,'ENVIRONMENT','대상 환경이 없습니다.');
    const environment=record(JSON.parse(String(config.config))),bundle=await deploymentBundle(artifact),contract=record(JSON.parse(await readFile(path.join(artifact.directory,'output/artifact.contract.json'),'utf8'))),issues:string[]=[];
    if(contract.target!=='node')issues.push('현재 원본은 Node 런타임 승격 계약을 지원하지 않습니다.');if(typeof contract.databaseMigration!=='number'||contract.databaseMigration>15)issues.push('지원하지 않는 데이터베이스 계약입니다.');
    const requiresStaticVariant=contract.target==='static'&&typeof environment.publicOrigin==='string'&&environment.publicOrigin!==artifact.project.settings.siteUrl;
    if(requiresStaticVariant)issues.push('정적 결과의 공개 주소가 달라 새 SEO 변형 빌드가 필요합니다.');
    const manifest={format:1,artifactReleaseId:releaseId,artifactHash:bundle.sha256,projectId:source.projectId,sourceEnvironmentId:source.environmentId??null,targetEnvironmentId:target.environmentId,dataKey:target.dataKey??target.projectId,configRevision:Number(config.config_version),runtimeSchema:Number(contract.databaseMigration),dynamicDataPolicy:'preserve-current-customer-data',flags:this.store.db.prepare('SELECT name,enabled,revision,expires_at AS expiresAt FROM advancement_flags WHERE scope_key=? ORDER BY name').all(target.environmentId),secretVersions:this.store.db.prepare("SELECT name,version,key_id AS keyId FROM advancement_secret_versions WHERE organization_id=? AND project_id=? AND environment_id=? AND status='active' ORDER BY name").all(target.organizationId,target.projectId,target.environmentId),...(typeof environment.publicOrigin==='string'?{publicOrigin:environment.publicOrigin}:{})};const reviewFingerprint=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');return {releaseId,artifactHash:bundle.sha256,sourceEnvironmentId:source.environmentId??null,targetEnvironmentId:target.environmentId,expectedConfigRevision:Number(config.config_version),reviewFingerprint,compatible:issues.length===0,issues,requiresStaticVariant,manifest};
  }
  async previewArtifact(id:string,scope:ExpansionScope):Promise<{directory:string;projectId:string;project:Project}>{const artifact=await this.artifact(id),owned=this.store.operations.state(`generation:scope:${id}`) as ExpansionScope|null;if(artifact.projectId!==scope.projectId||(owned?.dataKey??artifact.projectId)!==(scope.dataKey??scope.projectId))throw new HttpError(403,'PREVIEW_SCOPE','선택한 환경의 결과물만 검토할 수 있습니다.');return artifact;}
  recoverPromotions():void {for(const row of this.store.db.prepare("SELECT * FROM system_release_activations WHERE status='preparing' LIMIT 100").all()){if(this.leases.active(`generation:${String(row.project_id)}`))continue;const scope=this.store.operations.state(`generation:scope:${String(row.id)}`) as ExpansionScope|null;this.store.db.prepare("UPDATE system_release_activations SET status='unknown' WHERE id=? AND status='preparing'").run(String(row.id));if(scope)this.store.db.prepare("INSERT INTO system_incidents VALUES(?,?,?,?,?,'open',?,?,?)").run(randomUUID(),scope.organizationId,scope.projectId,scope.environmentId??null,'promotion-interrupted',JSON.stringify({activationId:String(row.id),sourceReleaseId:String(row.source_release_id),reconciliationRequired:true}),Date.now(),Date.now());}}
  async reconcilePromotion(id:string,scope:ExpansionScope,authorize:()=>void):Promise<Record<string,unknown>>{authorize();const row=this.store.db.prepare('SELECT * FROM system_release_activations WHERE id=? AND project_id=? AND target_environment_id=?').get(id,scope.projectId,scope.environmentId??null);if(!row)throw new HttpError(404,'PROMOTION_SCOPE','선택한 환경의 승격 이력이 없습니다.');if(row.status==='ready'||row.status==='failed')return {id,status:row.status};if(row.status!=='unknown')throw new HttpError(409,'PROMOTION_STATE','중단된 승격만 대사할 수 있습니다.');const manifest=record(JSON.parse(String(row.manifest)));return this.withScopeFreeze(scope,async site=>{authorize();let status='failed';if(site.activeRelease()===id&&this.store.exportRecord(id)?.status==='ready'){const artifact=await this.artifact(id),bundle=await deploymentBundle(artifact);if(bundle.sha256!==row.artifact_hash)throw new HttpError(409,'PROMOTION_INTEGRITY','검수한 결과물 해시가 다릅니다.');status='ready';this.activate(scope.projectId,scope.dataKey??scope.projectId,id);}else if(site.activeRelease()===id){const previous=manifest.previousReleaseId;if(typeof previous==='string'&&this.store.exportRecord(previous)?.status==='ready'){site.activateRelease(previous);this.activate(scope.projectId,scope.dataKey??scope.projectId,previous);}else{site.db.prepare("DELETE FROM runtime_state WHERE key='activeRelease'").run();this.store.operations.setState(`environment:release:${scope.dataKey??scope.projectId}`,null);}}this.store.db.prepare('UPDATE system_release_activations SET status=? WHERE id=?').run(status,id);this.store.db.prepare("UPDATE system_incidents SET status='resolved',updated_at=? WHERE project_id=? AND environment_id IS ? AND kind='promotion-interrupted' AND json_extract(body,'$.activationId')=?").run(Date.now(),scope.projectId,scope.environmentId??null,id);return {id,status,dataPreserved:true,evidence:'local-activation-and-immutable-artifact'};});}
  async promoteRelease(releaseId:string,source:ExpansionScope,target:ExpansionScope,expectedConfigRevision:number,requestKey:string,authorize:(project?:Project)=>void,expectedReviewFingerprint?:string):Promise<Record<string,unknown>>{
    if(!idPattern.test(requestKey)||!Number.isSafeInteger(expectedConfigRevision)||expectedConfigRevision<1)throw new HttpError(400,'RELEASE_INPUT','승격 요청 키와 검토한 설정 버전이 필요합니다.');authorize();
    const fingerprint=createHash('sha256').update(JSON.stringify({releaseId,source,target,expectedConfigRevision,expectedReviewFingerprint})).digest('hex'),previous=this.store.db.prepare('SELECT * FROM system_release_activations WHERE project_id=? AND target_environment_id=? AND request_key=?').get(source.projectId,target.environmentId!,requestKey);
    if(previous){if(previous.fingerprint!==fingerprint)throw new HttpError(409,'RELEASE_IDEMPOTENCY','같은 승격 요청 키의 내용이 다릅니다.');if(previous.status==='ready')return {id:String(previous.id),releaseId:String(previous.id),status:'ready',artifactHash:String(previous.artifact_hash),targetEnvironmentId:target.environmentId,manifest:JSON.parse(String(previous.manifest))};throw new HttpError(409,'RELEASE_RECONCILIATION','이전 승격 결과를 먼저 대사하세요.');}
    const preview=await this.releasePreview(releaseId,source,target);if(preview.compatible!==true)throw new HttpError(409,'RELEASE_COMPATIBILITY',String((preview.issues as string[]).join(' ')));if(preview.expectedConfigRevision!==expectedConfigRevision)throw new HttpError(409,'CONFIG_CONFLICT','검토 이후 대상 환경 설정이 변경되었습니다.');
    if(expectedReviewFingerprint!==undefined&&expectedReviewFingerprint!==preview.reviewFingerprint)throw new HttpError(409,'RELEASE_CHANGED','Flags, active secret versions or the release changed after review');
    const id=randomUUID(),manifest:Record<string,unknown>={...record(preview.manifest),id,previousReleaseId:this.activeRelease(target.projectId,target.dataKey??target.projectId)},artifactLease=this.leases.acquire(`artifact:${releaseId}`,randomUUID(),'shared',300000);let oldActive=this.activeRelease(target.projectId,target.dataKey??target.projectId);
    this.store.db.prepare("INSERT INTO system_release_activations VALUES(?,?,?,?,?,?,?,?,?,'preparing',?)").run(id,target.projectId,releaseId,source.environmentId??null,target.environmentId!,requestKey,fingerprint,String(preview.artifactHash),JSON.stringify(manifest),Date.now());
    let result:Record<string,unknown>,activationAttempted=false;
    try{result=await this.withScopeFreeze(target,async(site,guard)=>{
      authorize();artifactLease.assertCurrent();oldActive=site.activeRelease()??this.activeRelease(target.projectId,target.dataKey??target.projectId);manifest.previousReleaseId=oldActive;this.store.db.prepare('UPDATE system_release_activations SET manifest=? WHERE id=?').run(JSON.stringify(manifest),id);const again=await this.releasePreview(releaseId,source,target);if(again.artifactHash!==preview.artifactHash||again.expectedConfigRevision!==expectedConfigRevision||again.reviewFingerprint!==preview.reviewFingerprint)throw new HttpError(409,'RELEASE_CHANGED','Release or environment changed after review');
      const artifact=await this.artifact(releaseId),secrets=await this.runtimeSecrets(target,site);authorize(artifact.project);
      this.store.operations.createJob(id,artifact.project,'promotion-'+id,fingerprint);this.store.operations.setState(`generation:scope:${id}`,target);this.store.operations.setState(`promotion:source:${id}`,releaseId);this.store.operations.setState(`promotion:binding:${id}`,manifest);
      const probe=await startSiteInWorker(this.sourceRoot,path.join(artifact.directory,'output'),artifact.project,{dataFile:await this.siteFile(target.projectId,target.dataKey??target.projectId),releaseId:id,readOnly:true,secrets,environmentBinding:{id,artifactSha256:String(preview.artifactHash),configRevision:expectedConfigRevision,...(typeof manifest.publicOrigin==='string'?{publicOrigin:manifest.publicOrigin}:{})},leaseGuard:guard});
      try{const response=await fetch(probe.origin+'/health',{signal:AbortSignal.timeout(5000)}),health=record(record(await response.json()).data);if(!response.ok||health.releaseId!==id||health.projectId!==target.projectId)throw new HttpError(503,'RELEASE_HEALTH','Promoted runtime health did not match');authorize();artifactLease.assertCurrent();}finally{await probe.close();}
      try{activationAttempted=true;site.activateRelease(id);this.activate(target.projectId,target.dataKey??target.projectId,id);this.store.operations.finish(id,'ready',{id,url:'',path:artifact.directory,source:path.join(artifact.directory,'output'),entry:path.join(artifact.directory,'output/dist/index.html'),issues:[],durationMs:0});this.store.db.prepare("UPDATE system_release_activations SET status='ready' WHERE id=?").run(id);}catch(error){if(oldActive){site.activateRelease(oldActive);this.activate(target.projectId,target.dataKey??target.projectId,oldActive);}else{site.db.prepare("DELETE FROM runtime_state WHERE key='activeRelease'").run();this.store.operations.setState(`environment:release:${target.dataKey??target.projectId}`,null);}throw error;}
      return {id,releaseId:id,status:'ready',artifactHash:preview.artifactHash,targetEnvironmentId:target.environmentId,manifest};
    });const artifact=await this.artifact(id),running=await this.launchSite(path.join(artifact.directory,'output'),artifact.project,{dataFile:await this.siteFile(target.projectId,target.dataKey??target.projectId),releaseId:id,secrets:await this.runtimeSecrets(target)},target.dataKey??target.projectId);this.sites.set(id,running);this.siteKeys.set(id,target.dataKey??target.projectId);return {...result,url:running.origin};
    }catch(error){const running=this.sites.get(id);if(running){await running.close();this.sites.delete(id);this.siteKeys.delete(id);}if(this.activeRelease(target.projectId,target.dataKey??target.projectId)===id||activationAttempted&&this.activeRelease(target.projectId,target.dataKey??target.projectId)===oldActive)try{await this.withScopeFreeze(target,async site=>{if(site.activeRelease()!==id||![id,oldActive].includes(this.activeRelease(target.projectId,target.dataKey??target.projectId)))return;if(oldActive){site.activateRelease(oldActive);this.activate(target.projectId,target.dataKey??target.projectId,oldActive);}else{site.db.prepare("DELETE FROM runtime_state WHERE key='activeRelease'").run();this.store.operations.setState(`environment:release:${target.dataKey??target.projectId}`,null);}});}catch{this.store.db.prepare("UPDATE system_release_activations SET status='unknown' WHERE id=?").run(id);this.store.db.prepare("INSERT INTO system_incidents VALUES(?,?,?,?,?,'open',?,?,?)").run(randomUUID(),target.organizationId,target.projectId,target.environmentId??null,'promotion-interrupted',JSON.stringify({activationId:id,sourceReleaseId:releaseId,reconciliationRequired:true}),Date.now(),Date.now());throw new HttpError(503,'RELEASE_RECONCILIATION','The interrupted activation requires reconciliation');}this.store.db.prepare("UPDATE system_release_activations SET status='failed' WHERE id=?").run(id);if(this.store.operations.job(id))this.store.operations.finish(id,'failed',undefined,'PROMOTION_FAILED','Promotion failed; existing data and release retained');throw error;}finally{artifactLease.release();}
  }

  private async dataFor(projectId:string,dataKey:string):Promise<Store> {
    if(this.restoringProjects.has(projectId))throw new HttpError(409,"RESTORE_ACTIVE","운영 데이터를 복구 중입니다. 복구가 끝난 뒤 다시 시도하세요.");
    if(!this.store.project(projectId))throw new HttpError(404,"PROJECT_NOT_FOUND","프로젝트를 찾을 수 없습니다.");
    const existing=this.canonicalStores.get(dataKey);if(existing){existing.lease.assertCurrent();return existing.store;}
    const file=await this.siteFile(projectId,dataKey);
    const repeated=this.canonicalStores.get(dataKey);if(repeated){repeated.lease.assertCurrent();return repeated.store;}
    const lease=this.leases.acquire(`site-data:${dataKey}`,randomUUID(),"shared");
    let store:Store;try{store=new Store(file);}catch(error){lease.release();throw error;}
    const stop=startPlatformWorker(store.db,()=>{try{lease.assertCurrent();store.assertWritable();return true;}catch{return false;}});
    const stopWorker=async():Promise<void>=>{try{await stop();}finally{lease.release();}};
    this.canonicalStores.set(dataKey,{store,stopWorker,lease});return store;
  }
  private async launchSite(directory:string,project:Project,options:Parameters<typeof startSiteInWorker>[3],dataKey:string):Promise<IsolatedSite>{
    const binding=this.store.operations.state(`promotion:binding:${options.releaseId}`);if(binding&&typeof binding==='object'&&!options.environmentBinding){const value=record(binding);options={...options,environmentBinding:{id:options.releaseId,publicOrigin:typeof value.publicOrigin==='string'?value.publicOrigin:undefined,configRevision:Number(value.configRevision),artifactSha256:String(value.artifactHash)}};}
    const resources=[`artifact:${options.releaseId}`,`site-data:${dataKey}`],leases:ResourceLease[]=[];
    try{for(const resource of resources)leases.push(this.leases.acquire(resource,randomUUID(),"shared"));
      const site=await startSiteInWorker(this.sourceRoot,directory,project,{...options,leaseGuard:{studioFile:path.join(this.dataRoot,"studio.sqlite"),tokens:resources.map((resource,i)=>({resource,token:leases[i]!.token}))}});
      const close=site.close;let closed=false;site.close=async()=>{if(closed)return;closed=true;try{await close();}finally{leases.forEach(lease=>lease.release());this.liveSiteLeases.delete(options.releaseId);}};
      this.liveSiteLeases.set(options.releaseId,leases);return site;
    }catch(error){leases.forEach(lease=>lease.release());throw error;}
  }
  private async withData<T>(projectId:string,operation:(db:Store)=>T,scope?:ExpansionScope):Promise<T> {
    return operation(scope?await this.scopeData(scope):await this.projectData(projectId));
  }
  async enqueue(project:Project,key:string,scope?:ExpansionScope,actorId?:string,phase?:(name:string,budgetMs?:number)=>void):Promise<string> {
    project=this.normalizeProject(project);
    const originalProject=project;
    project=await this.resolveGenerationProject(project);
    const dataKey=scope?.dataKey??project.id;
    if(scope)await this.scopeData(scope);
    if(dataKey!==project.id)key=createHash("sha256").update(`${dataKey}:${key}`).digest("hex");
    verifyAssets(project);
    if(!idPattern.test(key))throw new HttpError(400,"IDEMPOTENCY","올바른 요청 키가 필요합니다.");
    const fingerprint=createHash("sha256").update(JSON.stringify(originalProject)).digest("hex");
    const existing=this.store.operations.request(project.id,key);
    if(existing){if(existing.fingerprint!==fingerprint)throw new HttpError(409,"IDEMPOTENCY_CONFLICT","동일 요청 키의 프로젝트 내용이 다릅니다.");return existing.id;}
    if(this.builds.size>=2||this.sites.size>=20||this.buildingProjects.has(project.id))throw new HttpError(429,"BUILD_LIMIT","동시 생성·실행 한도에 도달했습니다. 작업 완료 후 다시 시도하세요.");
    this.store.save(originalProject);
    const dataFile=await this.siteFile(project.id,dataKey);
    // Recheck after filesystem awaits: concurrent HTTP requests must not double enqueue.
    const repeated=this.store.operations.request(project.id,key);
    if(repeated){if(repeated.fingerprint!==fingerprint)throw new HttpError(409,"IDEMPOTENCY_CONFLICT","동일 요청 키의 프로젝트 내용이 다릅니다.");return repeated.id;}
    if(this.buildingProjects.has(project.id)||this.builds.size>=2)throw new HttpError(429,"BUILD_LIMIT","이 프로젝트를 생성 중입니다.");
    const operational=scope?await this.scopeData(scope):await this.projectData(project.id);
    const usage=await this.measureStorage(project.id,scope);
    const reservedBytes=(await stat(process.execPath)).size+(await stat(path.join(this.sourceRoot,"dist-service/site-server.mjs"))).size+await directoryBytes(path.join(this.sourceRoot,"src/runtime"))+await directoryBytes(path.join(this.sourceRoot,"src/domain"))+Buffer.byteLength(JSON.stringify(project))*3;
    const finalRequest=this.store.operations.request(project.id,key);
    if(finalRequest){if(finalRequest.fingerprint!==fingerprint)throw new HttpError(409,"IDEMPOTENCY_CONFLICT","동일 요청 키의 프로젝트 내용이 다릅니다.");return finalRequest.id;}
    if(this.buildingProjects.has(project.id)||this.builds.size>=2)throw new HttpError(429,"BUILD_LIMIT","이 프로젝트를 생성 중입니다.");
    checkUsageLimit(operational.db,project.id,"storageBytes",usage+reservedBytes);
    const previousUsage=Number(operational.db.prepare("SELECT value FROM platform_usage WHERE project_id=? AND metric='generations' AND period=?").get(project.id,period())?.value??0);
    const id=randomUUID(),abort=new AbortController();
    const lease=this.leases.acquire(`generation:${project.id}`,id);
    let slot:ReturnType<ResourceLeases["acquire"]>|undefined;
    let reservation="";
    try{for(let i=0;i<2;i++){try{slot=this.leases.acquire(`generation-slot:${i}`,id);break;}catch(error){if(!(error instanceof HttpError)||error.code!=="RESOURCE_BUSY")throw error;}}if(!slot)throw new HttpError(429,"BUILD_LIMIT","다른 생성 worker 작업이 완료된 뒤 시도하세요.");consumeUsage(operational.db,project.id,"generations");if(scope)reservation=this.reserveGenerationUsage(scope,id);this.store.operations.createJob(id,originalProject,key,fingerprint);if(scope)this.store.operations.setState(`generation:scope:${id}`,scope);if(reservation)this.store.operations.setState(`generation:usage:${id}`,reservation);}catch(error){try{if(scope&&reservation)this.settleGenerationUsage(scope,reservation,false);operational.db.prepare("UPDATE platform_usage SET value=? WHERE project_id=? AND metric='generations' AND period=?").run(previousUsage,project.id,period());}finally{lease.release();slot?.release();}throw error;}
    this.builds.set(id,abort);this.buildingProjects.add(project.id);
    if(actorId)this.store.operations.setState(`generation:actor:${id}`,actorId);
    const task=this.run(id,project,dataFile,abort,lease,slot,scope,actorId,phase);this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));
    return id;
  }
  async enqueueAndWait(project:Project,key:string,scope:ExpansionScope,signal:AbortSignal,actorId?:string,phase?:(name:string,budgetMs?:number)=>void):Promise<unknown> {
    const id=await this.enqueue(project,key,scope,actorId,phase);
    const abort=():void=>{this.builds.get(id)?.abort();};signal.addEventListener("abort",abort,{once:true});
    try { while(true){signal.throwIfAborted();const job=this.store.operations.job(id);if(!job)throw new HttpError(404,"JOB_NOT_FOUND","생성 작업을 찾을 수 없습니다.");if(job.status==="ready")return {id,status:job.status,result:job.result};if(["failed","cancelled"].includes(job.status))throw new HttpError(503,"GENERATION_FAILED","생성 결과와 오류를 확인하세요.");await new Promise<void>(resolve=>setTimeout(resolve,100));} } finally {signal.removeEventListener("abort",abort);}
  }
  async measureStorage(projectId:string,scope?:ExpansionScope):Promise<number> {
    let bytes=0,scopedBytes=0;
    const data=scope?await this.scopeData(scope):await this.projectData(projectId),folders=new Map<string,{bytes:number;scoped:boolean}>();
    const matching=(value:unknown):boolean=>{if(!scope||!value||typeof value!=='object'||Array.isArray(value))return false;const stored=value as Record<string,unknown>;return stored.organizationId===scope.organizationId&&stored.workspaceId===scope.workspaceId&&stored.projectId===projectId&&(stored.dataKey??stored.projectId)===(scope.dataKey??scope.projectId);};
    const add=async(folder:string,root:string,selected:boolean):Promise<void>=>{if(!contained(root,path.resolve(folder)))throw new HttpError(403,'PATH','사용량 측정 경로를 확인하세요.');try{const actual=await realpath(folder);if(!contained(await realpath(root),actual))throw new HttpError(403,'PATH','사용량 측정 경로를 확인하세요.');const key=process.platform==='win32'?actual.toLowerCase():actual,previous=folders.get(key);if(previous){previous.scoped ||= selected;return;}folders.set(key,{bytes:await directoryBytes(actual),scoped:selected});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}};
    const dataKeys=new Set([projectId,...this.store.db.prepare("SELECT data_key FROM expansion_environments WHERE project_id=?").all(projectId).map(row=>String(row.data_key))]);
    if([...dataKeys].some(key=>!idPattern.test(key)))throw new HttpError(403,"PATH","환경 데이터 저장 범위를 확인하세요.");
    for(const key of dataKeys)await add(path.join(this.dataRoot,'sites',key),this.dataRoot,!!scope&&key===(scope.dataKey??projectId));
    await add(path.join(this.dataRoot,'backups',projectId),this.dataRoot,false);
    const scopedBackups=new Map<string,number>();if(scope)for(const row of this.store.db.prepare('SELECT id,file FROM data_backups WHERE project_id=?').all(projectId)){const owned=this.store.operations.state('backup:scope:'+String(row.id));if(!owned||typeof owned!=='object'||Array.isArray(owned))continue;const value=owned as Record<string,unknown>;if(value.dataKey!==(scope.dataKey??projectId)||(value.environmentId??null)!==(scope.environmentId??null))continue;const file=String(row.file),base=path.join(this.dataRoot,'backups',projectId);if(!contained(base,path.resolve(file)))throw new HttpError(403,'PATH','백업 사용량 측정 경로를 확인하세요.');try{const actual=await realpath(file);if(!contained(await realpath(base),actual)||(await lstat(file)).isSymbolicLink())throw new HttpError(403,'PATH','백업 사용량 측정 경로를 확인하세요.');const entry=await stat(actual);if(entry.isFile())scopedBackups.set(process.platform==='win32'?actual.toLowerCase():actual,entry.size);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    for(const row of this.store.db.prepare("SELECT id,directory FROM exports WHERE project_id=? AND directory<>''").all(projectId)){
      const folder=String(row.directory);if(!contained(this.exportRoot,folder))continue;
      await add(folder,this.exportRoot,matching(this.store.operations.state('generation:scope:'+String(row.id))));
    }
    for(const [table,base] of [['advancement_backup_sets','backup-sets'],['system_storage_migrations','storage-migrations']] as const)for(const row of this.store.db.prepare(`SELECT id,scope FROM ${table} WHERE json_extract(scope,'$.projectId')=?`).all(projectId)){if(!idPattern.test(String(row.id)))throw new HttpError(403,'PATH','저장량 메타데이터 범위를 확인하세요.');await add(path.join(this.dataRoot,base,String(row.id)),this.dataRoot,matching(JSON.parse(String(row.scope))));}
    for(const folder of folders.values()){bytes+=folder.bytes;if(folder.scoped)scopedBytes+=folder.bytes;}
    for(const size of scopedBackups.values())scopedBytes+=size;
    data.db.prepare("INSERT INTO platform_usage VALUES(?,?,?,?) ON CONFLICT(project_id,metric,period) DO UPDATE SET value=excluded.value").run(projectId,"storageBytes",period(),bytes);
    if(scope)this.observeStorageUsage(scope,scopedBytes);
    return bytes;
  }
  private async run(id:string,project:Project,dataFile:string,abort:AbortController,lease:ReturnType<ResourceLeases["acquire"]>,slot:ReturnType<ResourceLeases["acquire"]>,scope?:ExpansionScope,actorId?:string,phase?:(name:string,budgetMs?:number)=>void):Promise<void> {
    const started=Date.now();
    const dataKey=scope?.dataKey??project.id;
    const previous=[...this.sites].filter(([release,site])=>site.projectId===project.id&&(this.siteKeys.get(release)??project.id)===dataKey);
    const active=this.activeRelease(project.id,dataKey);
    const heartbeat=setInterval(()=>{try{if(!lease.renew()||!slot.renew())abort.abort();}catch{abort.abort();}},5000);heartbeat.unref();
    try {
      const artifact=await generateInWorker(project,{exportRoot:this.exportRoot,sourceRoot:this.sourceRoot,studioFile:path.join(this.dataRoot,"studio.sqlite"),id,dataFile,leaseToken:lease.token,stage:stage=>{lease.assertCurrent();const index=["\uC18C\uC2A4 \uAD6C\uC131","\uC0AC\uC774\uD2B8 \uBE4C\uB4DC","\uAC80\uC99D\uACFC \uB370\uC774\uD130 \uBCF4\uC874","\uACB0\uACFC \uD655\uC815"].indexOf(stage);if(index>=0)phase?.(["source","build","data-verify","commit"][index]!,[30000,180000,30000,15000][index]!);this.store.operations.stage(id,stage);},lifecycle:event=>{
        if(event==="before-data-snapshot"){
          const db=new Store(dataFile);try{db.pauseProjectWrites(true);}finally{db.close();}
          previous.forEach(([,site])=>site.pauseWrites(true));
        }
      },signal:abort.signal,onUsage:usage=>{if(scope)this.observeWorkerUsage(scope,usage);}});
      abort.signal.throwIfAborted();phase?.('start',15000);
      this.store.operations.stage(id,"웹사이트 실행");
      lease.assertCurrent();
      const secrets=scope?await this.runtimeSecrets(scope):{};
      const site=await this.launchSite(artifact.source,project,{dataFile,releaseId:id,secrets},dataKey);
      this.sites.set(id,site);this.siteKeys.set(id,dataKey);
      const health=await fetch(site.origin+"/health",{signal:AbortSignal.timeout(5000)});
      if(!health.ok)throw new HttpError(503,"HEALTH","새 사이트의 준비 상태를 확인하지 못했습니다.");
      abort.signal.throwIfAborted();
      const totalBytes=await this.measureStorage(project.id,scope)+await directoryBytes(artifact.path);
      const operational=scope?await this.scopeData(scope):await this.projectData(project.id);
      checkUsageLimit(operational.db,project.id,"storageBytes",totalBytes);
      operational.db.prepare("INSERT INTO platform_usage VALUES(?,?,?,?) ON CONFLICT(project_id,metric,period) DO UPDATE SET value=excluded.value").run(project.id,"storageBytes",period(),totalBytes);
      lease.assertCurrent();
      if(scope)this.authorizePublisher(scope,actorId,parseProject(this.store.operations.jobProject(id)));
      this.store.operations.finish(id,"ready",{...artifact,url:site.origin});
      this.activate(project.id,dataKey,id);
      site.store.activateRelease(id);site.store.pauseProjectWrites(false);
      previous.forEach(([,old])=>old.pauseWrites(true));
      this.store.audit("site.generate",project.id,"success");
      this.store.operations.measure(project.id,"generation","success",Date.now()-started);
    }catch(error){
      const failed=this.sites.get(id);if(failed){await failed.close();this.sites.delete(id);}
      if(this.leases.active(`generation:${project.id}`)){try{lease.assertCurrent();const db=new Store(dataFile);try{if(active)db.activateRelease(active);db.pauseProjectWrites(false);}finally{db.close();}if(active)this.activate(project.id,dataKey,active);}catch(cause){if(!(cause instanceof HttpError)||cause.code!=="LEASE_LOST")throw cause;}}
      previous.forEach(([oldId,site])=>site.pauseWrites(oldId!==active));
      const code=abort.signal.aborted?"GENERATION_CANCELLED":error instanceof HttpError?error.code:"GENERATION_FAILED";
      const message=abort.signal.aborted?"생성을 취소했습니다. 원본과 기존 운영 데이터는 유지됩니다.":error instanceof HttpError?error.message:"생성에 실패했습니다. 원본과 마지막 정상 사이트는 유지됩니다.";
      this.store.operations.finish(id,abort.signal.aborted?"cancelled":"failed",undefined,code,message);
      this.store.operations.measure(project.id,"generation",code,Date.now()-started);
      console.error(JSON.stringify({timestamp:new Date().toISOString(),level:"error",service:"automade",operation:"site.generate",artifactId:id,errorCode:code}));
    }finally{try{const reservation=this.store.operations.state(`generation:usage:${id}`);if(scope&&typeof reservation==="string")this.settleGenerationUsage(scope,reservation,this.store.operations.job(id)?.status==="ready");}catch(error){this.store.audit("generation.usage.settle",project.id,error instanceof HttpError?error.code:"USAGE_SETTLEMENT_FAILED");}finally{clearInterval(heartbeat);lease.release();slot.release();this.builds.delete(id);this.buildingProjects.delete(project.id);}}
  }
  private filter(url:URL):SubmissionFilter {
    const limit=Number(url.searchParams.get("limit")??50),offset=Number(url.searchParams.get("offset")??0);
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)throw new HttpError(400,"PAGINATION","조회 범위를 확인하세요.");
    const query=url.searchParams.get("query")??"",status=url.searchParams.get("status")??"",blockId=url.searchParams.get("blockId")??"",from=url.searchParams.get("from")??"",to=url.searchParams.get("to")??"";
    if(query.length>200||(status&&!["new","processing","completed","archived"].includes(status))||(blockId&&!idPattern.test(blockId)))throw new HttpError(400,"FILTER","문의 검색 조건을 확인하세요.");
    for(const date of [from,to])if(date&&!Number.isFinite(Date.parse(date)))throw new HttpError(400,"FILTER_DATE","조회 날짜를 확인하세요.");
    if(from&&to&&Date.parse(from)>Date.parse(to))throw new HttpError(400,"FILTER_DATE","시작 날짜가 종료 날짜보다 늦습니다.");
    return {limit,offset,query,status,blockId,from:from?new Date(from).toISOString():undefined,to:to?new Date(to).toISOString():undefined};
  }
  private async backup(projectId:string,reason="manual",scope?:ExpansionScope):Promise<DataBackup> {
    const dataKey=scope?.dataKey??projectId;
    const file=await this.siteFile(projectId,dataKey),id=randomUUID();
    const folder=path.join(this.dataRoot,"backups",projectId);await mkdir(folder,{recursive:true});
    const destination=path.join(folder,id+".sqlite");
    const db=new Store(file);let counts:{submissions:number;pending:number;tables:number};
    try{counts=db.operations.siteCounts();db.snapshot(destination);}finally{db.close();}
    const entry:DataBackup={id,projectId,releaseId:this.store.operations.projectRelease(projectId),createdAt:new Date().toISOString(),bytes:(await stat(destination)).size,reason,submissions:counts.submissions,tables:counts.tables};
    this.store.operations.addBackup(entry,destination);this.store.operations.setState(`backup:scope:${id}`,{dataKey,environmentId:scope?.environmentId??null});this.store.audit("data.backup",projectId,"success");return entry;
  }
  private async restore(projectId:string,backupId:string,scope?:ExpansionScope):Promise<unknown> {
    if(this.restoringProjects.has(projectId)||(this.projectRequests.get(projectId)??0)>1)throw new HttpError(409,"OPERATIONS_BUSY","다른 운영 요청이 진행 중입니다. 요청이 끝난 뒤 복구하세요.");
    const lease=this.leases.acquire(`generation:${projectId}`,randomUUID(),"exclusive",300_000);
    this.restoringProjects.add(projectId);
    const dataKey=scope?.dataKey??projectId;let dataLease:ResourceLease|undefined,stoppedSites=0;
    const assertCurrent=():void=>{lease.assertCurrent();dataLease?.assertCurrent();};
    const heartbeat=setInterval(()=>{lease.renew();dataLease?.renew();},5000);heartbeat.unref();
    try{
      for(const [id,site]of this.sites)if(site.projectId===projectId&&(this.siteKeys.get(id)??projectId)===dataKey){await site.close();this.sites.delete(id);stoppedSites++;}
      const cached=this.canonicalStores.get(dataKey);if(cached){await cached.stopWorker();cached.store.close();this.canonicalStores.delete(dataKey);}
      // Other coordinators must release their serving/data handles before a file replacement.
      dataLease=this.leases.acquire(`site-data:${dataKey}`,randomUUID(),"exclusive",300_000);
      const result=record(await this.restoreData(projectId,backupId,scope,assertCurrent));return{...result,sitesStopped:Number(result.sitesStopped??0)+stoppedSites};
    }finally{try{assertCurrent();const current=new Store(await this.siteFile(projectId,dataKey));try{assertCurrent();current.pauseProjectWrites(false);}finally{current.close();}}finally{clearInterval(heartbeat);dataLease?.release();lease.release();this.restoringProjects.delete(projectId);}}
  }
  private async restoreData(projectId:string,backupId:string,scope?:ExpansionScope,assertCurrent:()=>void=()=>{}):Promise<unknown> {
    const dataKey=scope?.dataKey??projectId,backupScope=this.store.operations.state(`backup:scope:${backupId}`) as {dataKey?:string}|null;
    if((backupScope?.dataKey??projectId)!==dataKey)throw new HttpError(403,"BACKUP_SCOPE","다른 환경의 백업은 자동 복원할 수 없습니다.");
    if(this.buildingProjects.has(projectId))throw new HttpError(409,"GENERATION_ACTIVE","생성이 끝난 뒤 복원하세요.");
    const source=this.store.operations.backupFile(projectId,backupId);
    if(!source||!contained(path.join(this.dataRoot,"backups"),source))throw new HttpError(404,"BACKUP_NOT_FOUND","백업을 찾을 수 없습니다.");
    const resolved=await realpath(source);
    if(!contained(await realpath(path.join(this.dataRoot,"backups")),resolved))throw new HttpError(403,"PATH","백업 경로를 확인하세요.");
    const file=await this.siteFile(projectId,dataKey);
    assertCurrent();
    const paused=new Store(file);let authenticationCheckpoint:unknown;try{authenticationCheckpoint=this.beforeDataRestore(scope??{organizationId:"local",workspaceId:"local",projectId,dataKey},paused);paused.pauseProjectWrites(true);}finally{paused.close();}
    const recovery=await this.backup(projectId,"before-restore",scope);
    const running=[...this.sites].filter(([release,site])=>site.projectId===projectId&&(this.siteKeys.get(release)??projectId)===dataKey);
    for(const [id,site] of running){await site.close();this.sites.delete(id);}
    const cached=this.canonicalStores.get(dataKey);if(cached){await cached.stopWorker();cached.store.close();this.canonicalStores.delete(dataKey);}
    const temporary=file+".restore-"+randomUUID(),previous=file+".before-"+randomUUID();
    await inspectPortableDatabase(source,projectId);
    assertCurrent();
    const candidate=new DatabaseSync(source,{readOnly:true});
    try{candidate.prepare("VACUUM INTO ?").run(temporary);}finally{candidate.close();}
    const upgraded=new Store(temporary);try{if(String(upgraded.db.prepare("PRAGMA quick_check").get()?.quick_check)!=="ok")throw new HttpError(422,"BACKUP_INVALID","백업 무결성 검사에 실패했습니다.");}finally{upgraded.close();}
    assertCurrent();
    // Close every connection and checkpoint WAL before replacing the database file.
    const current=new Store(file);try{current.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");}finally{current.close();}
    await rename(file,previous);
    let reconciliation:ReconciliationReport|undefined;
    let candidateInstalled=false;
    try{
      await rename(temporary,file);
      candidateInstalled=true;
      assertCurrent();
      const restored=new Store(file),before=new DatabaseSync(previous,{readOnly:true});try{reconciliation=compareOperationalData(before,restored.db);persistReconciliation(restored.db,reconciliation,before);const active=this.activeRelease(projectId,dataKey);if(active)restored.activateRelease(active);restored.db.prepare("UPDATE platform_outbox SET status='failed',error_code='RESTORE_RECONCILIATION_REQUIRED' WHERE status IN('pending','sending')").run();this.afterDataRestore(scope??{organizationId:"local",workspaceId:"local",projectId,dataKey},restored,authenticationCheckpoint);restored.pauseProjectWrites(false);}finally{before.close();restored.close();}
    }catch(error){assertCurrent();if(candidateInstalled)await rename(file,file+".failed-restore-"+randomUUID());await rename(previous,file);throw error;}
    this.store.audit("data.restore",projectId,"success");this.store.operations.measure(projectId,"restore","success",0);
    return {restored:true,backupId,recoveryBackup:recovery,sitesStopped:running.length,reconciliation,reconciliationRequired:reconciliation?.status==="requires-review"};
  }
  async handle(req:IncomingMessage,res:ServerResponse,url:URL,visibleProjectIds?:Set<string>,scope?:ExpansionScope,actorId?:string):Promise<boolean> {
    const projectRoute=url.pathname.includes("/retention")?null:url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\//);
    const exportRoute=url.pathname.match(/^\/api\/exports\/([a-f0-9-]+)/);
    const projectId=projectRoute?.[1]??(exportRoute?this.store.exportRecord(exportRoute[1]!)?.project_id:undefined);
    const release=exportRoute?this.retention.reserveRelease(exportRoute[1]!):undefined;
    if(projectId)this.projectRequests.set(projectId,(this.projectRequests.get(projectId)??0)+1);
    const durable=exportRoute?this.leases.acquire(`artifact:${exportRoute[1]!}`,randomUUID(),"shared",300_000):undefined;
    try{return await this.handleRequest(req,res,url,visibleProjectIds,scope,actorId);}finally{
      durable?.release();
      release?.();
      if(projectId){const count=(this.projectRequests.get(projectId)??1)-1;if(count)this.projectRequests.set(projectId,count);else this.projectRequests.delete(projectId);}
    }
  }
  async withProjectRequest<T>(projectId:string,operation:()=>Promise<T>):Promise<T> {
    if(this.restoringProjects.has(projectId))throw new HttpError(409,"RESTORE_ACTIVE","운영 데이터를 복구 중입니다.");
    this.projectRequests.set(projectId,(this.projectRequests.get(projectId)??0)+1);
    try{return await operation();}finally{const count=(this.projectRequests.get(projectId)??1)-1;if(count)this.projectRequests.set(projectId,count);else this.projectRequests.delete(projectId);}
  }
  private async handleRequest(req:IncomingMessage,res:ServerResponse,url:URL,visibleProjectIds?:Set<string>,scope?:ExpansionScope,actorId?:string):Promise<boolean> {
    const transfer=url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/data-transfer$/);
    if(transfer){
      const projectId=transfer[1]!;
      if(req.method==="GET"){
        const entry=await this.backup(projectId,"portable-export",scope),file=this.store.operations.backupFile(projectId,entry.id)!;
        const lease=this.leases.acquire(`backup:${entry.id}`,randomUUID(),"shared",300_000);
        try{const manifest=await inspectPortableDatabase(file,projectId);if(manifest.bytes>16_000_000)throw new HttpError(413,"DATA_PACKAGE_SIZE","JSON 이전 패키지는 16MB 이내 DB를 지원합니다. 운영 백업 다운로드와 별도 이관 절차를 사용하세요.");reply(res,200,{manifest,databaseBase64:(await readFile(file)).toString("base64")});}finally{lease.release();}return true;
      }
      if(req.method==="POST"){
        const input=record(await body(req,24_000_000));
        if(input.confirm!==true||typeof input.databaseBase64!=="string"||input.databaseBase64.length>22_500_000||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.databaseBase64))throw new HttpError(400,"DATA_IMPORT","이전 범위 확인과 16MB 이내 SQLite 데이터가 필요합니다.");
        const metadata=record(input.manifest),data=Buffer.from(input.databaseBase64,"base64"),id=randomUUID(),folder=path.join(this.dataRoot,"backups",projectId);
        if(data.length>16_000_000||metadata.projectId!==projectId||metadata.sha256!==createHash("sha256").update(data).digest("hex"))throw new HttpError(422,"DATA_IMPORT_HASH","프로젝트 범위와 데이터 해시가 일치하지 않습니다.");
        await mkdir(folder,{recursive:true});if(!contained(await realpath(this.dataRoot),await realpath(folder)))throw new HttpError(403,"PATH","이전 파일 경로를 확인하세요.");
        const file=path.join(folder,id+".sqlite");await writeFile(file,data,{flag:"wx"});const manifest=await inspectPortableDatabase(file,projectId);
        const entry:DataBackup={id,projectId,releaseId:null,createdAt:new Date().toISOString(),bytes:manifest.bytes,reason:"portable-import",submissions:manifest.tables.submissions??0,tables:manifest.tables.table_data??0};
        this.store.operations.addBackup(entry,file);this.store.operations.setState(`backup:scope:${id}`,{dataKey:scope?.dataKey??projectId,environmentId:scope?.environmentId??null});
        reply(res,200,{...record(await this.restore(projectId,id,scope)),manifest,reconciliationRequired:true});return true;
      }
      throw new HttpError(405,"METHOD","이전 요청 방식을 확인하세요.");
    }
    if(await this.retention.handle(req,res,url))return true;
    if(await this.deployment.handle(req,res,url,scope))return true;
    if(url.pathname==="/api/exports"&&req.method==="POST"){
      this.rates.check("export",20);const raw=record(await body(req));const project=parseProject(raw.project);
      reply(res,202,{id:await this.enqueue(project,typeof raw.idempotencyKey==="string"?raw.idempotencyKey:"",scope,actorId)});return true;
    }
    const sub=url.pathname.match(/^\/api\/exports\/([a-f0-9-]+)\/submissions(?:\/([a-zA-Z0-9_-]+))?(\.csv)?$/);
    if(sub){
      const artifact=await this.artifact(sub[1]!);
      if(sub[2]&&req.method==="PATCH"){
        const raw=await body(req,20000);const changed=await this.withData(artifact.projectId,db=>db.operations.updateSubmission(sub[2]!,raw),scope);
        this.store.audit("submission.update",artifact.projectId,"success");reply(res,200,changed);return true;
      }
      if(req.method==="GET"){
        const filter=this.filter(url);
        if(sub[3]){
          const all=await this.withData(artifact.projectId,db=>db.operations.submissions({...filter,limit:100000,offset:0}),scope);
          const rows=[["id","form","createdAt","status","tags","assignee","note","values"],...all.items.map(item=>[item.id,item.block_id,item.created_at,item.status,item.tags.join(";"),item.assignee,item.note,JSON.stringify(item.values)])];
          res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":"attachment; filename=\"submissions.csv\"","Cache-Control":"no-store"});res.end("\ufeff"+rows.map(row=>row.map(csvCell).join(",")).join("\r\n"));return true;
        }
        const result=await this.withData(artifact.projectId,db=>db.operations.submissions(filter),scope);reply(res,200,url.searchParams.get("includeMeta")==="1"?result:result.items);return true;
      }
    }
    const projectRoute=url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/(data-backups|retention|releases|metrics)(?:\/([a-zA-Z0-9_-]+)\/(download|restore))?$/);
    if(projectRoute){
      const projectId=projectRoute[1]!,kind=projectRoute[2]!,backupId=projectRoute[3],action=projectRoute[4];
      if(!this.store.project(projectId))throw new HttpError(404,"PROJECT_NOT_FOUND","프로젝트를 찾을 수 없습니다.");
      if(kind==="retention"){
        return this.retention.handle(req,res,url);
      }
      if(kind==="metrics"&&req.method==="GET"){
        const canonical=scope?await this.scopeData(scope):await this.projectData(projectId),groups=new Map<string,{operation:string;status:string;count:number;duration:number;lastMeasuredAt:string}>();
        for(const metric of [...this.store.operations.metrics(projectId),...canonical.operations.metrics(projectId)]){
          const key=metric.operation+":"+metric.status,current=groups.get(key)??{operation:metric.operation,status:metric.status,count:0,duration:0,lastMeasuredAt:""};
          current.count+=metric.count;current.duration+=metric.avgDurationMs*metric.count;if(metric.lastMeasuredAt>current.lastMeasuredAt)current.lastMeasuredAt=metric.lastMeasuredAt;groups.set(key,current);
        }
        reply(res,200,[...groups.values()].map(metric=>({operation:metric.operation,status:metric.status,count:metric.count,avgDurationMs:Math.round(metric.duration/metric.count),lastMeasuredAt:metric.lastMeasuredAt})));return true;
      }
      if(kind==="releases"&&req.method==="GET"){
        const active=this.activeRelease(projectId,scope?.dataKey??projectId);
        const releases=this.store.db.prepare("SELECT e.id,e.project_id,e.status,e.created_at,e.error_code,e.directory,COALESCE(j.revision,0) AS revision,COALESCE(j.stage,e.status) AS stage FROM exports e LEFT JOIN generation_jobs j ON e.id=j.id WHERE e.project_id=? ORDER BY e.created_at DESC LIMIT 200").all(projectId).map(row=>({...row,active:row.id===active,running:this.sites.has(String(row.id)),url:this.sites.get(String(row.id))?.origin??null}));reply(res,200,releases);return true;
      }
      if(kind==="data-backups"){
        if(!backupId&&req.method==="GET"){reply(res,200,this.store.operations.backups(projectId).filter(entry=>((this.store.operations.state(`backup:scope:${entry.id}`) as {dataKey?:string}|null)?.dataKey??projectId)===(scope?.dataKey??projectId)));return true;}
        if(!backupId&&req.method==="POST"){reply(res,201,await this.backup(projectId,"manual",scope));return true;}
        if(backupId&&action==="download"&&req.method==="GET"){
          const file=this.store.operations.backupFile(projectId,backupId);
          if(!file||!contained(path.join(this.dataRoot,"backups"),file)||!contained(await realpath(path.join(this.dataRoot,"backups")),await realpath(file)))throw new HttpError(404,"BACKUP_NOT_FOUND","백업을 찾을 수 없습니다.");
          res.writeHead(200,{"Content-Type":"application/vnd.sqlite3","Content-Disposition":`attachment; filename="site-backup-${backupId}.sqlite"`,"Cache-Control":"no-store"});res.end(await readFile(file));return true;
        }
        if(backupId&&action==="restore"&&req.method==="POST"){
          if(record(await body(req,2000)).confirm!==true)throw new HttpError(400,"RESTORE_CONFIRM","복원 범위 확인이 필요합니다.");
          reply(res,200,await this.restore(projectId,backupId,scope));return true;
        }
      }
    }
    const job=url.pathname.match(/^\/api\/exports\/([a-f0-9-]+)(?:\/(cancel|stop|restart|download|retry|design-rollback))?$/);
    if(job){
      const id=job[1]!,operation=job[2];
      if(operation==="download"&&req.method==="GET"){const saved=await this.artifact(id);await sourceArchive(saved.directory,id,res);return true;}
      if(operation==="restart"&&req.method==="POST"){
        const artifact=await this.artifact(id);let site=this.sites.get(id);
        const savedScope=this.store.operations.state(`generation:scope:${id}`) as ExpansionScope|null;
        const dataKey=savedScope?.dataKey??artifact.projectId,active=this.activeRelease(artifact.projectId,dataKey);
        if(!site){if(this.sites.size>=20)throw new HttpError(429,"SITE_LIMIT","실행 중인 사이트를 먼저 종료하세요.");if(savedScope)this.authorizePublisher(savedScope,actorId,artifact.project);site=await this.launchSite(path.join(artifact.directory,"output"),artifact.project,{dataFile:await this.siteFile(artifact.projectId,dataKey),releaseId:id,readOnly:active!==id,secrets:savedScope?await this.runtimeSecrets(savedScope):{}},dataKey);this.sites.set(id,site);this.siteKeys.set(id,dataKey);}
        reply(res,200,{url:site.origin,active:active===id,readOnly:active!==id});return true;
      }
      if(operation==="stop"&&req.method==="POST"){const site=this.sites.get(id);if(site){await site.close();this.sites.delete(id);}reply(res,200,{stopped:true});return true;}
      if(operation==="cancel"&&req.method==="POST"){this.builds.get(id)?.abort();const saved=this.store.operations.job(id);if(!saved)throw new HttpError(404,"JOB_NOT_FOUND","작업을 찾을 수 없습니다.");reply(res,200,{status:saved.status,cancelRequested:this.builds.has(id)});return true;}
      if((operation==="retry"||operation==="design-rollback")&&req.method==="POST"){
        let project:Project;
        if(operation==="design-rollback"){
          const prior=await this.artifact(id),current=this.store.project(prior.projectId);
          if(!current)throw new HttpError(404,"PROJECT_NOT_FOUND","현재 프로젝트를 찾을 수 없습니다.");
          project={...prior.project,revision:current.revision+1,updatedAt:new Date().toISOString()};
        }else {const saved=this.store.operations.job(id);if(!saved?.retryable)throw new HttpError(409,"NOT_RETRYABLE","실패·취소 작업만 다시 시도할 수 있습니다.");project=parseProject(this.store.operations.jobProject(id));const current=this.store.project(project.id);if(current&&current.revision>=project.revision)project={...project,revision:current.revision+1,updatedAt:new Date().toISOString()};}
        reply(res,202,{id:await this.enqueue(project,randomUUID(),scope,actorId),preservedOperationalData:true});return true;
      }
      if(!operation&&req.method==="GET"){
        const saved=this.store.operations.job(id);if(!saved)throw new HttpError(404,"JOB_NOT_FOUND","생성 작업을 찾을 수 없습니다.");
        reply(res,200,{...saved,active:this.store.operations.projectRelease(saved.projectId)===id,running:this.sites.has(id),...(saved.result?{result:{...saved.result,url:this.sites.get(id)?.origin??saved.result.url}}:{})});return true;
      }
    }
    if(url.pathname==="/api/operations"&&req.method==="GET"){
      const summaries:SiteSummary[]=[];
      for(const project of this.store.projects().filter(project=>!visibleProjectIds||visibleProjectIds.has(project.id))){
        const active=this.store.operations.projectRelease(project.id),job=active?this.store.operations.job(active):null;
        try{
          const dataFile=await this.siteFile(project.id),db=new Store(dataFile);let counts;try{counts=db.operations.siteCounts();}finally{db.close();}
          summaries.push({projectId:project.id,name:project.name,activeReleaseId:active,revision:job?.revision??null,url:active?this.sites.get(active)?.origin??null:null,...counts,bytes:(await stat(dataFile)).size,latestBackup:this.store.operations.backups(project.id)[0]??null,measuredAt:new Date().toISOString(),error:null});
        }catch{summaries.push({projectId:project.id,name:project.name,activeReleaseId:active,revision:null,url:null,submissions:0,pending:0,tables:0,bytes:0,latestBackup:null,measuredAt:new Date().toISOString(),error:"운영 데이터를 확인하지 못했습니다."});}
      }
      const jobs=this.store.exports().filter(job=>!visibleProjectIds||visibleProjectIds.has(String(record(job).project_id)));
      reply(res,200,{stats:visibleProjectIds?{projects:summaries.length,exports:jobs.length,submissions:summaries.reduce((sum,site)=>sum+site.submissions,0)}:this.store.stats(),sites:summaries,jobs,running:[...this.sites].filter(([,site])=>!visibleProjectIds||visibleProjectIds.has(site.projectId)).map(([id,site])=>({id,url:site.origin,projectId:site.projectId,active:this.activeRelease(site.projectId,this.siteKeys.get(id))===id,readOnly:this.activeRelease(site.projectId,this.siteKeys.get(id))!==id})),audit:this.store.audits().filter(entry=>!visibleProjectIds||visibleProjectIds.has(String(record(entry).resource_id))),generationProvider:process.env.GENERATION_API_URL?"configured":"local-templates",measuredAt:new Date().toISOString()});return true;
    }
    if(url.pathname==="/api/telemetry"&&req.method==="POST"){
      const v=record(await body(req,2000));
      if(typeof v.projectId!=="string"||!this.store.project(v.projectId)||typeof v.operation!=="string"||!["project.start","site.first-run","quality.resolve","preview.mobile","form.submit","site.publish"].includes(v.operation)||typeof v.durationMs!=="number"||!Number.isFinite(v.durationMs)||v.durationMs<0||v.durationMs>86400000)throw new HttpError(400,"TELEMETRY","측정 입력을 확인하세요.");
      this.store.operations.measure(v.projectId,v.operation,v.status==="failed"?"failed":"success",v.durationMs);reply(res,201,{recorded:true});return true;
    }
    return false;
  }
  async close():Promise<void>{
    clearInterval(this.leaseHeartbeat);
    await this.retention.close();
    for(const abort of this.builds.values())abort.abort();await Promise.allSettled([...this.tasks]);
    await Promise.all([...this.canonicalStores.values()].map(async entry=>{await entry.stopWorker();entry.store.close();}));this.canonicalStores.clear();
    await Promise.all([...this.sites.values()].map(site=>site.close()));this.sites.clear();
  }
}

export async function directoryBytes(folder:string):Promise<number>{
  let bytes=0;for(const entry of await readdir(folder,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const file=path.join(folder,entry.name);bytes+=entry.isDirectory()?await directoryBytes(file):(await stat(file)).size;}return bytes;
}
