import {createHash} from "node:crypto";
import {HttpError} from "./http";
import {parseProject,record} from "../src/domain/validation";
import type {Project} from "../src/domain/types";
export interface ProjectChange {path:string;before:unknown;after:unknown}
export interface ProjectCommand {commandId:string;baseRevision:number;proposedRevision?:number;changes:ProjectChange[]}
export interface CommandAcknowledgement {commandId:string;revision:number;project:Project;ack:true;status:"applied";replayed:boolean}
const forbidden=new Set(["__proto__","prototype","constructor"]);
function plain(value:unknown,depth=0):void{
 if(depth>48)throw new HttpError(400,"COMMAND_DEPTH","변경 구조가 너무 깊습니다.");
 if(Array.isArray(value)){if(value.length>100000)throw new HttpError(413,"COMMAND_SIZE","변경 목록이 너무 큽니다.");for(const item of value)plain(item,depth+1);}
 else if(value!==null&&typeof value==="object")for(const [key,item]of Object.entries(value)){if(forbidden.has(key))throw new HttpError(400,"COMMAND_PATH","허용되지 않은 속성입니다.");plain(item,depth+1);}
 else if(typeof value==="number"&&!Number.isFinite(value))throw new HttpError(400,"COMMAND_VALUE","유효한 숫자를 입력하세요.");
}
function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(value!==null&&typeof value==="object")return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
 return value;
}
export const commandFingerprint=(command:ProjectCommand):string=>createHash("sha256").update(JSON.stringify(canonical(command))).digest("hex");
export function parseProjectCommand(input:unknown):ProjectCommand{
 const value=record(input);
 if(typeof value.commandId!=="string"||! /^[a-zA-Z0-9_-]{1,100}$/.test(value.commandId)||!Number.isSafeInteger(value.baseRevision)||Number(value.baseRevision)<0)throw new HttpError(400,"COMMAND_INPUT","명령 식별자와 저장 기준 버전이 필요합니다.");
 if(value.proposedRevision!==undefined&&(!Number.isSafeInteger(value.proposedRevision)||Number(value.proposedRevision)<Number(value.baseRevision)||Number(value.proposedRevision)>Number(value.baseRevision)+1000000))throw new HttpError(400,"COMMAND_REVISION","편집 버전을 확인하세요.");
 if(!Array.isArray(value.changes)||!value.changes.length||value.changes.length>1000)throw new HttpError(400,"COMMAND_CHANGES","변경은 1~1000개로 전달하세요.");
 const changes=value.changes.map((raw):ProjectChange=>{
  const item=record(raw);
  if(typeof item.path!=="string"||!item.path.startsWith("/")||item.path.length>1000||!Object.hasOwn(item,"before")||!Object.hasOwn(item,"after"))throw new HttpError(400,"COMMAND_PATH","변경 위치와 이전/이후 값을 확인하세요.");
  plain(item.before);plain(item.after);segments(item.path);return {path:item.path,before:item.before,after:item.after};
 });
 const command={commandId:value.commandId,baseRevision:Number(value.baseRevision),...(value.proposedRevision!==undefined?{proposedRevision:Number(value.proposedRevision)}:{}),changes};
 if(Buffer.byteLength(JSON.stringify(command))>16000000)throw new HttpError(413,"COMMAND_SIZE","큰 변경은 파일 업로드 또는 원본 가져오기를 사용하세요.");
 return command;
}
function segments(path:string):string[]{
 const parts=path.slice(1).split("/").map(part=>{try{return decodeURIComponent(part).replaceAll("~1","/").replaceAll("~0","~");}catch{throw new HttpError(400,"COMMAND_PATH","변경 위치를 확인하세요.");}});
 if(parts.length>32||parts.some(part=>!part||forbidden.has(part)||part.includes("\0"))||["id","schemaVersion","revision","updatedAt"].includes(parts[0]!))throw new HttpError(400,"COMMAND_PATH","원본 식별자나 버전은 직접 변경할 수 없습니다.");
 return parts;
}
function child(value:unknown,key:string):unknown{
 if(Array.isArray(value)){
  if(!key.startsWith("@"))throw new HttpError(400,"COMMAND_PATH","배열 항목은 안정 ID로 지정하세요.");
  return value.find(item=>item!==null&&typeof item==="object"&&(item as {id?:unknown}).id===key.slice(1));
 }
 if(value!==null&&typeof value==="object"&&Object.hasOwn(value,key))return (value as Record<string,unknown>)[key];
 return undefined;
}
export function applyProjectCommand(current:Project,command:ProjectCommand,now=new Date().toISOString()):Project{
 if(current.revision!==command.baseRevision)throw new HttpError(409,"REVISION_CONFLICT","서버 저장본이 변경되었습니다. 변경을 비교하세요.");
 const next:unknown=structuredClone(current);
 for(const change of command.changes){
  const parts=segments(change.path);let parent:unknown=next;
  for(const key of parts.slice(0,-1)){parent=child(parent,key);if(parent===undefined||parent===null)throw new HttpError(409,"COMMAND_TARGET","변경 대상이 삭제되거나 이동했습니다.");}
  const key=parts.at(-1)!;const previous=child(parent,key);
  if(JSON.stringify(canonical(previous??null))!==JSON.stringify(canonical(change.before)))throw new HttpError(409,"COMMAND_CONFLICT","같은 위치의 다른 변경을 비교하세요.");
  if(Array.isArray(parent)){
   if(!key.startsWith("@"))throw new HttpError(400,"COMMAND_PATH","배열 항목은 안정 ID로 지정하세요.");
   const index=parent.findIndex(item=>item!==null&&typeof item==="object"&&(item as {id?:unknown}).id===key.slice(1));
   if(index<0)throw new HttpError(409,"COMMAND_TARGET","변경 항목이 없습니다.");
   parent[index]=structuredClone(change.after);
  }else if(parent!==null&&typeof parent==="object")Object.defineProperty(parent,key,{value:structuredClone(change.after),enumerable:true,writable:true,configurable:true});
  else throw new HttpError(400,"COMMAND_PATH","변경 위치가 객체가 아닙니다.");
 }
 const candidate=record(next);candidate.revision=Math.max(current.revision+1,command.proposedRevision??0);candidate.updatedAt=now;
 const project=parseProject(candidate);
 if(project.id!==current.id)throw new HttpError(403,"COMMAND_PROJECT","명령의 원본 범위가 다릅니다.");
 return project;
}
