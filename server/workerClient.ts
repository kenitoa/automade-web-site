import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Store } from "./store";
import { HttpError } from "./http";
import { record } from "../src/domain/validation";
import type { ExportResult, Project } from "../src/domain/types";
import type { RunningSite,SiteOptions } from "./siteServer";
import {operationContext} from "./operationContext";
import type { WorkItem } from "./workQueue";
import {parseWorkerUsage,type WorkerUsage} from "./workerUsage";
function workerMessage(input:unknown):Record<string,unknown>{const value=record(input);if(value.protocol!==undefined&&value.protocol!==1)throw new HttpError(409,'WORKER_PROTOCOL','Unsupported worker IPC protocol');return value;}
function workerEnvelope(){const context=operationContext.getStore();return {protocol:1,traceparent:context?`00-${context.traceId}-${context.spanId}-01`:undefined};}
export function executeInWorker(sourceRoot:string,studioFile:string,dataRoot:string,item:WorkItem,signal:AbortSignal,timeoutMs=180_000,onUsage?:(usage:WorkerUsage)=>void):Promise<unknown> {
  const store=new Store(studioFile);
  const lease=store.db.prepare("SELECT worker_id,lease_token FROM work_items WHERE id=? AND status='running' AND lease_until>?").get(item.id,Date.now());store.close();
  if(!lease)return Promise.reject(new HttpError(409,"WORK_LEASE_LOST","작업 실행 권한이 만료되었습니다."));
  return new Promise((resolve,reject)=>{
    const child=spawnWorker(sourceRoot,"expansion-worker.mjs");let settled=false;
    const finish=(error:unknown,result?:unknown):void=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener("abort",abort);if(error){child.kill();reject(error);}else resolve(result);};
    const abort=():void=>finish(new HttpError(409,"WORK_CANCELLED","작업을 취소했습니다."));
    const timer=setTimeout(()=>finish(new HttpError(504,"EXTERNAL_RESULT_UNKNOWN","worker 제한 시간을 초과했습니다. 외부 실행 상태를 확인하세요.")),timeoutMs);
    signal.addEventListener("abort",abort,{once:true});
    child.once("error",()=>finish(new HttpError(503,"WORK_START","worker를 실행하지 못했습니다.")));
    child.once("exit",()=>{if(!settled)finish(new HttpError(503,"EXTERNAL_RESULT_UNKNOWN","worker가 결과 확인 전에 종료되었습니다."));});
    child.on("message",(input:unknown)=>{try{const value=workerMessage(input);if((value.type==='result'||value.type==='error')&&value.usage!==undefined)onUsage?.(parseWorkerUsage(value.usage));if(value.type==="result")finish(null,value.result);else if(value.type==="error")finish(new HttpError(503,String(value.code??"WORK_FAILED"),String(value.message??"작업에 실패했습니다.")));}catch(error){finish(error);}});
    if(signal.aborted)abort();else child.send({protocol:1,traceparent:operationContext.getStore()?`00-${operationContext.getStore()!.traceId}-${operationContext.getStore()!.spanId}-01`:undefined,studioFile,dataRoot,jobId:item.id,workerId:lease.worker_id,leaseToken:lease.lease_token});
  });
}
export type IsolatedSite = Omit<RunningSite, "server">;
function spawnWorker(sourceRoot: string, entry: string, environment?: NodeJS.ProcessEnv): ChildProcess {
  const child = fork(path.join(sourceRoot, "dist-service", entry), [], { silent: true, windowsHide: true, execArgv: ["--max-old-space-size=512"], env: environment ?? process.env });
  let pending="";const decoder=new StringDecoder("utf8");
  child.stdout?.on("data", (chunk: Buffer) => {
    pending+=decoder.write(chunk);if(pending.length>1_000_000){pending="";return;}
    const lines=pending.split("\n");pending=lines.pop()??"";
    for (const line of lines) {
      try { const log = record(JSON.parse(line) as unknown); if (typeof log.operation !== "string" || !/^[a-zA-Z0-9_/:.-]{1,160}$/.test(log.operation)) continue; const safe: Record<string, unknown> = {}; for (const key of ["timestamp", "level", "service", "operation", "requestId", "projectId", "status", "durationMs", "errorCode"]) if (typeof log[key] === "string" || typeof log[key] === "number") safe[key] = log[key]; console.log(JSON.stringify(safe)); } catch { /* Non-JSON process diagnostics do not enter structured request logs. */ }
    }
  });
  child.stderr?.resume();
  return child;
}
export function generateInWorker(project: Project, options: { sourceRoot: string; exportRoot: string; dataFile: string; studioFile: string; id: string; leaseToken?: string; stage: (stage: string) => void; lifecycle: (event: string) => void; signal: AbortSignal; timeoutMs?: number;onUsage?:(usage:WorkerUsage)=>void }): Promise<Omit<ExportResult, "url">> {
  return new Promise((resolve, reject) => {
    const child = spawnWorker(options.sourceRoot, "generation-worker.mjs"); let settled = false;let stageTimer:ReturnType<typeof setTimeout>|undefined;
    const finish = (error?: unknown, result?: Omit<ExportResult, "url">): void => { if (settled) return; settled = true; clearTimeout(timer);if(stageTimer)clearTimeout(stageTimer); options.signal.removeEventListener("abort", abort); if (error) { child.kill(); reject(error); } else resolve(result!); };
    const abort = (): void => finish(new HttpError(409, "GENERATION_CANCELLED", "생성을 취소했습니다."));
    const timer = setTimeout(() => finish(new HttpError(504, "GENERATION_TIMEOUT", "생성 제한 시간을 초과했습니다.")), options.timeoutMs ?? 180_000);
    options.signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => finish(new HttpError(503, "GENERATION_WORKER", "생성 worker를 실행하지 못했습니다.")));
    child.once("exit", () => { if (!settled) finish(new HttpError(503, "GENERATION_WORKER_EXIT", "생성 worker가 결과를 반환하기 전에 종료되었습니다.")); });
    child.on("message", (input: unknown) => { try { const value = workerMessage(input);if((value.type==='result'||value.type==='error')&&value.usage!==undefined)options.onUsage?.(parseWorkerUsage(value.usage)); if (value.type === "stage" && typeof value.stage === "string"){if(stageTimer)clearTimeout(stageTimer);const index=["\uC18C\uC2A4 \uAD6C\uC131","\uC0AC\uC774\uD2B8 \uBE4C\uB4DC","\uAC80\uC99D\uACFC \uB370\uC774\uD130 \uBCF4\uC874","\uACB0\uACFC \uD655\uC815"].indexOf(value.stage);if(index>=0){stageTimer=setTimeout(()=>finish(new HttpError(504,"GENERATION_STAGE_TIMEOUT","Generation stage time budget exceeded")),Math.min([30000,180000,30000,15000][index]!,options.timeoutMs??180000));stageTimer.unref();}options.stage(value.stage);} else if (value.type === "lifecycle" && typeof value.event === "string") options.lifecycle(value.event); else if (value.type === "error") finish(new HttpError(500, String(value.code || "GENERATION_FAILED"), String(value.message || "생성에 실패했습니다."))); else if (value.type === "result") { const result = record(value.result); if (result.id !== options.id || typeof result.path !== "string" || typeof result.source !== "string" || typeof result.entry !== "string" || typeof result.durationMs !== "number" || !Array.isArray(result.issues)) throw new Error("worker result"); finish(undefined, result as unknown as Omit<ExportResult, "url">); } } catch (error) { finish(error); } });
    if (options.signal.aborted) abort(); else child.send({ ...workerEnvelope(),project, sourceRoot: options.sourceRoot, exportRoot: options.exportRoot, dataFile: options.dataFile, studioFile: options.studioFile, id: options.id, leaseToken: options.leaseToken });
  });
}
export function startSiteInWorker(sourceRoot: string, directory: string, project: Project, options: { dataFile: string; releaseId: string; readOnly?: boolean; secrets?: Record<string, string>;environmentBinding?:SiteOptions['environmentBinding'];leaseGuard?:{studioFile:string;tokens:{resource:string;token:string}[]} }): Promise<IsolatedSite> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, SITE_HOST: "127.0.0.1" };
    for (const key of ["SITE_PUBLIC_ORIGIN", "SITE_ACTIVE_RELEASE_ID", "SITE_DEPLOYMENT_SHA256", "STUDIO_ADMIN_EMAIL", "STUDIO_ADMIN_PASSWORD", "EXPANSION_SECRET_KEY","ARTIFACT_SIGNING_PRIVATE_KEY_FILE","ARTIFACT_SIGNER_ID","ARTIFACT_SIGNING_KEY_ID"]) delete environment[key];
    if (process.env.APP_MODE === "managed") for (const key of Object.keys(environment)) if (/^(AUTH|MAIL|CRM|DATA|PAYMENT|DEPLOY|TENANT|GENERATION|STUDIO_MAIL)_/.test(key) && key !== "DATA_DIR" || key === "PLATFORM_ADMIN_EMAIL" || key === "PLATFORM_ADMIN_PASSWORD") delete environment[key];
    Object.assign(environment, options.secrets ?? {});
    const child = spawnWorker(sourceRoot, "site-worker.mjs", environment); let ready = false;
    const timer = setTimeout(() => { child.kill(); reject(new HttpError(504, "SITE_WORKER_TIMEOUT", "사이트 실행 제한 시간을 초과했습니다.")); }, 15_000);
    child.once("error", () => { if (!ready) { clearTimeout(timer); reject(new HttpError(503, "SITE_WORKER", "사이트 worker를 실행하지 못했습니다.")); } });
    child.once("exit", () => { if (!ready) { clearTimeout(timer); reject(new HttpError(503, "SITE_WORKER_EXIT", "사이트 worker가 준비 전에 종료되었습니다.")); } });
    child.on("message", (input: unknown) => {
      let value:Record<string,unknown>;try{value=workerMessage(input);}catch(error){clearTimeout(timer);child.kill();reject(error);return;}
      if (ready) return;
      if (value.type === "error") { clearTimeout(timer); child.kill(); reject(new HttpError(503, "SITE_WORKER", "사이트 worker를 준비하지 못했습니다.")); return; }
      if (value.type !== "ready" || value.projectId !== project.id || typeof value.origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin)) return;
      clearTimeout(timer); ready = true;
      const store = new Store(options.dataFile); let closed = false;
      resolve({ origin: value.origin, projectId: project.id, store, get readOnly() { return options.readOnly === true || store.activeRelease() !== options.releaseId; }, pauseWrites: (paused: boolean) => { if (child.connected) child.send({ ...workerEnvelope(),type: "pause", paused }); }, close: async () => {
        if (closed) return; closed = true;
        await new Promise<void>(done => { if (child.exitCode !== null || !child.connected) { child.kill(); done(); return; } const timeout = setTimeout(() => { child.kill(); done(); }, 5000); child.once("exit", () => { clearTimeout(timeout); done(); }); child.send({ ...workerEnvelope(),type: "stop" }); }); store.close();
      } });
    });
    child.send({ ...workerEnvelope(),type: "start", directory, project, dataFile: options.dataFile, releaseId: options.releaseId, readOnly: options.readOnly,environmentBinding:options.environmentBinding,leaseGuard:options.leaseGuard });
  });
}
