import {randomUUID} from 'node:crypto';
import {HttpError} from './http';
import {record} from '../src/domain/validation';
export interface WorkerUsage {
  protocol:1;
  operationId:string;
  cpuUserMicros:number;
  cpuSystemMicros:number;
  cpuMs:number;
  elapsedMs:number;
}
export function parseWorkerUsage(value:unknown):WorkerUsage {
  const input=record(value);
  if(input.protocol!==1||typeof input.operationId!=='string'||!/^worker-[a-f0-9-]{36}$/.test(input.operationId))throw new HttpError(502,'WORKER_USAGE_CONTRACT','worker 사용량 계약을 확인하세요.');
  for(const key of ['cpuUserMicros','cpuSystemMicros','cpuMs','elapsedMs'] as const)if(typeof input[key]!=='number'||!Number.isSafeInteger(input[key])||Number(input[key])<0)throw new HttpError(502,'WORKER_USAGE_CONTRACT','worker 사용량 단위를 확인하세요.');
  if(!Number.isSafeInteger(Number(input.cpuUserMicros)+Number(input.cpuSystemMicros))||Math.ceil((Number(input.cpuUserMicros)+Number(input.cpuSystemMicros))/1000)!==input.cpuMs)throw new HttpError(502,'WORKER_USAGE_CONTRACT','worker CPU 사용량 합계를 확인하세요.');
  return {protocol:1,operationId:input.operationId,cpuUserMicros:Number(input.cpuUserMicros),cpuSystemMicros:Number(input.cpuSystemMicros),cpuMs:Number(input.cpuMs),elapsedMs:Number(input.elapsedMs)};
}
/** CPU time measures the child process and its threads; elapsed time is a different quantity. */
export function beginWorkerUsage():{finish:()=>WorkerUsage} {
  const baseline=process.cpuUsage(),started=process.hrtime.bigint(),operationId='worker-'+randomUUID();let completed:WorkerUsage|undefined;
  return {finish:()=>{if(!completed){const cpu=process.cpuUsage(baseline);completed=parseWorkerUsage({protocol:1,operationId,cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,cpuMs:Math.ceil((cpu.user+cpu.system)/1000),elapsedMs:Number((process.hrtime.bigint()-started)/1000000n)});}return {...completed};}};
}
