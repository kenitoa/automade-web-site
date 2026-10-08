import {DatabaseSync} from 'node:sqlite';
import {existsSync,statfsSync} from 'node:fs';
import path from 'node:path';
import {sourceIdentity} from '../scripts/source-identity.mjs';
import type {Store} from './store';
import {activeKeyId} from './advancement/keyring';
declare const AUTOMADE_BUILD_HASH:string|undefined;
declare const AUTOMADE_BUILD_COMMIT:string|null|undefined;
export const API_PROTOCOL=1;
export function buildIdentity(root:string):{buildHash:string;buildCommit:string|null}{return {buildHash:typeof AUTOMADE_BUILD_HASH==='string'?AUTOMADE_BUILD_HASH:sourceIdentity(root).hash,buildCommit:typeof AUTOMADE_BUILD_COMMIT==='string'?AUTOMADE_BUILD_COMMIT:null};}
export function runtimeIdentity(root:string,store:Store,mode:string){
 const sqlite=String(store.db.prepare('SELECT sqlite_version() AS version').get()?.version??'unknown');
 return {buildHash:typeof AUTOMADE_BUILD_HASH==='string'?AUTOMADE_BUILD_HASH:sourceIdentity(root).hash,buildCommit:typeof AUTOMADE_BUILD_COMMIT==='string'?AUTOMADE_BUILD_COMMIT:null,node:process.versions.node,sqlite,openssl:process.versions.openssl,apiProtocol:API_PROTOCOL,migrations:store.db.prepare('SELECT version FROM migrations ORDER BY version').all().map(row=>Number(row.version)),mode,processId:process.pid};
}
export function readiness(root:string,dataRoot:string,store:Store,draining=false){
 const checks:{id:string;ok:boolean;code?:string}[]=[];
 try{checks.push({id:'database',ok:store.db.prepare('SELECT 1 AS ok').get()?.ok===1});}catch{checks.push({id:'database',ok:false,code:'DATABASE_UNAVAILABLE'});}
 try{const versions=store.db.prepare('SELECT version FROM migrations ORDER BY version').all().map(row=>Number(row.version));checks.push({id:'migrations',ok:versions.length===15&&versions.every((value,index)=>value===index+1),code:versions.length===15?undefined:'MIGRATION_REQUIRED'});}catch{checks.push({id:'migrations',ok:false,code:'MIGRATION_REQUIRED'});}
 try{activeKeyId();checks.push({id:'vault',ok:true});}catch{checks.push({id:'vault',ok:process.env.APP_MODE!=='managed',code:'VAULT_REQUIRED'});}
 const workers=['generation-worker.mjs','site-worker.mjs','expansion-worker.mjs','image-worker.mjs'];checks.push({id:'workers',ok:workers.every(name=>existsSync(path.join(root,'dist-service',name)))});
 try{const disk=statfsSync(dataRoot);checks.push({id:'disk',ok:disk.bavail*disk.bsize>64*1024*1024});}catch{checks.push({id:'disk',ok:false,code:'DISK_UNAVAILABLE'});}
 checks.push({id:'drain',ok:!draining});return {ready:checks.every(item=>item.ok),status:draining?'draining':checks.every(item=>item.ok)?'ready':'degraded',checks};
}
export function probeDatabase(file:string):boolean {const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('PRAGMA quick_check').get()?.quick_check==='ok';}finally{db.close();}}
