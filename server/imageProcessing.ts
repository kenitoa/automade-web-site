import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError } from './http';
import { record } from '../src/domain/validation';
import { parseWorkerUsage, type WorkerUsage } from './workerUsage';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export interface ImageVariantSpec { width: number; height: number; format: 'png' | 'webp' }
export interface DecodedImage {
  mime: ImageMime; width: number; height: number; frames: number; decodedPixels: number;
  decoder: string; metadataStripped: boolean; data?: Buffer;
}
export const IMAGE_MAX_BYTES = 8_000_000;
export const IMAGE_MAX_PIXELS = 40_000_000;
let running = 0;

function positive(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new HttpError(502, 'IMAGE_WORKER_CONTRACT', '이미지 작업 결과의 크기를 확인하세요.');
  return value;
}
function result(value: unknown, variant?: ImageVariantSpec): DecodedImage {
  const input = record(value);
  if (!['image/png','image/jpeg','image/webp','image/gif'].includes(String(input.mime)) || input.decoder !== 'sharp-0.35.5' || typeof input.metadataStripped !== 'boolean')
    throw new HttpError(502, 'IMAGE_WORKER_CONTRACT', '이미지 작업 결과를 확인하세요.');
  const width=positive(input.width,16000),height=positive(input.height,16000),frames=positive(input.frames,128),decodedPixels=positive(input.decodedPixels,IMAGE_MAX_PIXELS);
  if (width*height*frames !== decodedPixels) throw new HttpError(502,'IMAGE_WORKER_CONTRACT','이미지 픽셀 합계를 확인하세요.');
  const base:DecodedImage={mime:input.mime as ImageMime,width,height,frames,decodedPixels,decoder:input.decoder,metadataStripped:input.metadataStripped};
  if (variant) {
    if (typeof input.data !== 'string' || input.data.length > Math.ceil(IMAGE_MAX_BYTES/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data) || input.data.length%4 || input.mime!==`image/${variant.format}` || !input.metadataStripped || frames!==1 || width>variant.width || height>variant.height)
      throw new HttpError(502,'IMAGE_WORKER_CONTRACT','이미지 변형 결과를 확인하세요.');
    base.data=Buffer.from(input.data,'base64');
    if (!base.data.length || base.data.length>IMAGE_MAX_BYTES || base.data.toString('base64')!==input.data) throw new HttpError(502,'IMAGE_WORKER_CONTRACT','이미지 변형 바이트를 확인하세요.');
  } else if (input.data !== undefined || input.metadataStripped) throw new HttpError(502,'IMAGE_WORKER_CONTRACT','이미지 원본 검사 결과를 확인하세요.');
  return base;
}

/** A bounded child process owns native decoding. No paths, URLs, or database credentials enter it. */
export async function processImage(bytes: Buffer, mime: ImageMime, variant?: ImageVariantSpec, onUsage?: (usage: WorkerUsage)=>void): Promise<DecodedImage> {
  if (!bytes.length || bytes.length>IMAGE_MAX_BYTES) throw new HttpError(413,'IMAGE_LIMIT','이미지는 8MB 이하여야 합니다.');
  if (variant && (!Number.isSafeInteger(variant.width)||variant.width<1||variant.width>16000||!Number.isSafeInteger(variant.height)||variant.height<1||variant.height>16000||!['png','webp'].includes(variant.format))) throw new HttpError(400,'IMAGE_VARIANT','변형 크기와 PNG/WEBP 형식을 확인하세요.');
  if (running>=2) throw new HttpError(429,'IMAGE_WORKER_BUSY','이미지 검사가 진행 중입니다. 잠시 후 다시 시도하세요.');
  const compiled=new URL('./image-worker.mjs',import.meta.url),source=new URL('./imageWorker.ts',import.meta.url),bundled=existsSync(fileURLToPath(compiled));
  running++;
  try {
    return await new Promise<DecodedImage>((resolve,reject)=>{
      const environment:NodeJS.ProcessEnv={NODE_OPTIONS:''};for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','PATH'])if(process.env[key]!==undefined)environment[key]=process.env[key];
      const child=fork(fileURLToPath(bundled?compiled:source),[],{windowsHide:true,execArgv:bundled?['--max-old-space-size=256']:['--max-old-space-size=256','--import','tsx/esm'],stdio:['ignore','ignore','ignore','ipc'],env:environment});
      let settled=false;
      const finish=(error?:unknown,value?:DecodedImage):void=>{if(settled)return;settled=true;clearTimeout(timer);child.removeAllListeners();if(child.connected)child.disconnect();if(child.exitCode===null)child.kill();if(error)reject(error);else if(value)resolve(value);};
      const timer=setTimeout(()=>finish(new HttpError(504,'IMAGE_WORKER_TIMEOUT','이미지 검사 시간 제한을 초과했습니다.')),12_000);
      child.once('error',()=>finish(new HttpError(503,'IMAGE_WORKER_START','이미지 검사 작업을 시작하지 못했습니다.')));
      child.once('exit',()=>finish(new HttpError(502,'IMAGE_WORKER_EXIT','이미지 검사 작업이 결과 없이 종료되었습니다.')));
      child.once('message',(raw:unknown)=>{try{const message=record(raw);if(message.protocol!==1||!['result','error'].includes(String(message.type)))throw new HttpError(502,'IMAGE_WORKER_CONTRACT','이미지 worker 계약을 확인하세요.');const usage=parseWorkerUsage(message.usage);onUsage?.(usage);if(message.type==='error'){const codes=['IMAGE_TYPE','IMAGE_SIZE','IMAGE_DECODE','IMAGE_VARIANT','IMAGE_LIMIT','WORKER_PROTOCOL','WORKER_ENVELOPE'];if(typeof message.code!=='string'||!codes.includes(message.code))throw new HttpError(502,'IMAGE_WORKER_CONTRACT','이미지 검사 오류 계약을 확인하세요.');throw new HttpError(400,message.code,'이미지 원본을 해석하지 못했습니다. 형식과 크기를 확인하세요.');}finish(undefined,result(message.result,variant));}catch(error){finish(error);}});
      child.send({protocol:1,bytes:bytes.toString('base64'),mime,variant},error=>{if(error)finish(new HttpError(503,'IMAGE_WORKER_SEND','이미지 검사 요청을 전달하지 못했습니다.'));});
    });
  } finally { running--; }
}
