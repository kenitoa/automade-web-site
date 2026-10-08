import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {processImage,type ImageMime} from '../server/imageProcessing';
import {beginWorkerUsage,parseWorkerUsage,type WorkerUsage} from '../server/workerUsage';
import {HttpError} from '../server/http';
import {Store} from '../server/store';
import {ExpansionService} from '../server/expansion/service';
import {createProject} from '../src/domain/catalog';
import {one} from '../server/platform/common';
const isCode=(code:string)=>(error:unknown)=>error instanceof HttpError&&error.code===code;
const original=()=>sharp({create:{width:16,height:12,channels:4,background:{r:40,g:100,b:180,alpha:1}}});

test('all four admitted image types are actually decoded and both successful and failed workers report CPU',async()=>{
  const types=['png','jpeg','webp','gif'] as const,usages:WorkerUsage[]=[];
  for(const format of types){const bytes=await original().toFormat(format).toBuffer(),decoded=await processImage(bytes,`image/${format}` as ImageMime,undefined,usage=>usages.push(usage));assert.equal(decoded.width,16);assert.equal(decoded.height,12);assert.equal(decoded.frames,1);assert.equal(decoded.decodedPixels,192);assert.equal(decoded.decoder,'sharp-0.35.5');assert.equal(decoded.metadataStripped,false);assert.equal(decoded.data,undefined);}
  const corrupt=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  await assert.rejects(processImage(corrupt,'image/png',undefined,usage=>usages.push(usage)),isCode('IMAGE_DECODE'));
  assert.equal(usages.length,5);assert.equal(new Set(usages.map(usage=>usage.operationId)).size,5);for(const usage of usages)assert.equal(parseWorkerUsage(usage).cpuMs,Math.ceil((usage.cpuUserMicros+usage.cpuSystemMicros)/1000));
});

test('resize preserves original bytes, removes metadata and decodes all animation frames before making a static derivative',async()=>{
  const jpeg=await original().jpeg().withExif({IFD0:{Artist:'private-fixture-author'}}).toBuffer(),copy=Buffer.from(jpeg),decoded=await processImage(jpeg,'image/jpeg',{width:8,height:8,format:'png'});
  assert.deepEqual(jpeg,copy);assert.equal(decoded.width,8);assert.equal(decoded.height,6);assert.equal(decoded.metadataStripped,true);const metadata=await sharp(decoded.data).metadata();assert.equal(metadata.exif,undefined);assert.equal(metadata.xmp,undefined);assert.equal(metadata.icc,undefined);
  const frames=Buffer.concat([Buffer.alloc(4*4*4,255),Buffer.alloc(4*4*4,128)]),animated=await sharp(frames,{raw:{width:4,height:8,channels:4,pageHeight:4}}).gif().toBuffer(),animation=await processImage(animated,'image/gif');assert.equal(animation.frames,2);assert.equal(animation.decodedPixels,32);const staticVariant=await processImage(animated,'image/gif',{width:2,height:2,format:'webp'});assert.equal(staticVariant.frames,1);assert.equal((await sharp(staticVariant.data).metadata()).pages,undefined);
  await assert.rejects(processImage(jpeg,'image/png'),isCode('IMAGE_TYPE'));await assert.rejects(processImage(jpeg,'image/jpeg',{width:17,height:12,format:'png'}),isCode('IMAGE_VARIANT'));
});

test('decoded pixel, frame and byte limits reject decompression-heavy input before acceptance',async()=>{
  const tooManyFrames=await sharp({create:{width:1,height:129,channels:4,background:'red',pageHeight:1}}).gif({keepDuplicateFrames:true}).toBuffer();await assert.rejects(processImage(tooManyFrames,'image/gif'),isCode('IMAGE_SIZE'));
  const huge=await sharp({create:{width:6400,height:6400,channels:3,background:'white'}}).png().toBuffer();await assert.rejects(processImage(huge,'image/png'),error=>error instanceof HttpError&&['IMAGE_SIZE','IMAGE_DECODE'].includes(error.code));
  await assert.rejects(processImage(Buffer.alloc(8_000_001),'image/png'),isCode('IMAGE_LIMIT'));
});

test('server variants are scoped, immutable, quarantined, idempotent and record failed actual CPU in the environment ledger',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'automade-image-')),store=new Store(path.join(root,'central.sqlite')),site=new Store(path.join(root,'site.sqlite')),service=new ExpansionService(store,{mode:'local',dataRoot:root,siteData:async()=>site,enqueueJob:async()=>{throw new Error('No jobs in image fixture');}});
  try{
    const project=createProject('Image processing');store.save(project);const scope=service.registerProject(project,'local',null,true),bytes=await original().png().toBuffer(),source=await service.blobs.upload(scope,{dataUrl:'data:image/png;base64,'+bytes.toString('base64'),alt:'Source image',license:'Fixture owned image',requestKey:'source'});
    assert.equal(source.inspection?.inspection.kind,'decoded-pixels');assert.equal(source.inspection?.inspection.decodedPixels,192);const afterUpload=service.usage.evidence(scope).actual.length;
    assert.equal((await service.blobs.upload(scope,{dataUrl:'data:image/png;base64,'+bytes.toString('base64'),alt:'Source image',license:'Fixture owned image',requestKey:'source'})).id,source.id);assert.equal(service.usage.evidence(scope).actual.length,afterUpload);
    const input={width:8,height:8,format:'webp',requestKey:'preview'},variant=await service.blobs.variant(scope,source.id,input),afterVariant=service.usage.evidence(scope).actual.length;
    assert.equal(variant.inspection?.sourceRef,source.id);assert.equal(variant.inspection?.state,'quarantined');assert.equal(variant.inspection?.visibility,'private');assert.equal(variant.inspection?.inspection.metadataStripped,true);assert.deepEqual((await service.blobs.read(scope.projectId,source.id)).data,bytes);assert.equal(variant.width,8);assert.equal(variant.height,6);
    assert.equal((await service.blobs.variant(scope,source.id,input)).id,variant.id);assert.equal(service.usage.evidence(scope).actual.length,afterVariant);assert.throws(()=>service.blobs.assertPublishable(scope.projectId,[variant.id]),isCode('ASSET_PUBLICATION_REQUIRED'));await assert.rejects(service.blobs.variant(scope,source.id,{...input,width:7}),isCode('ASSET_VARIANT_CONFLICT'));
    const other=createProject('Other scope');store.save(other);const otherScope=service.registerProject(other,'local',null,true);await assert.rejects(service.blobs.variant(otherScope,source.id,{...input,requestKey:'other'}),isCode('BLOB_NOT_FOUND'));
    const beforeParallel=service.usage.evidence(scope).actual.length,parallel=await Promise.allSettled([service.blobs.variant(scope,source.id,{...input,requestKey:'parallel'}),service.blobs.variant(scope,source.id,{...input,requestKey:'parallel'})]),completed=parallel.flatMap(result=>result.status==='fulfilled'?[result.value.id]:[]);assert.ok(completed.length>=1);assert.equal(new Set(completed).size,1);for(const rejected of parallel)if(rejected.status==='rejected')assert.ok(isCode('ASSET_VARIANT_RUNNING')(rejected.reason));assert.equal(service.usage.evidence(scope).actual.length,beforeParallel+1);
    const refs=Number(one(store.db,'SELECT COUNT(*) AS n FROM expansion_blob_refs')?.n);let checks=0;await assert.rejects(service.blobs.variant(scope,source.id,{...input,requestKey:'revoked-mid-operation'},()=>{if(++checks>1)throw new HttpError(403,'PERMISSION','Fixture revoked');}),isCode('PERMISSION'));assert.equal(Number(one(store.db,'SELECT COUNT(*) AS n FROM expansion_blob_refs')?.n),refs);
    const corrupt='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';await assert.rejects(service.blobs.upload(scope,{dataUrl:corrupt,alt:'Corrupt image',license:'Fixture',requestKey:'corrupt'}),isCode('IMAGE_DECODE'));assert.equal(Number(one(store.db,'SELECT COUNT(*) AS n FROM expansion_blob_refs')?.n),refs);
    const evidence=service.usage.evidence(scope);assert.ok(evidence.actual.length>afterVariant);assert.ok(evidence.actual.every(row=>row.metric==='cpu'&&row.unit==='milliseconds'));assert.equal(evidence.aggregate.find(row=>row.metric==='cpu')?.amount,evidence.actual.reduce((sum,row)=>sum+Number(row.amount),0));
  }finally{site.close();store.close();}
});

test('worker CPU DTO measures actual CPU, freezes a final sample and rejects malformed envelopes',()=>{
  const meter=beginWorkerUsage(),until=process.hrtime.bigint()+20_000_000n;while(process.hrtime.bigint()<until){Math.sqrt(Number(process.hrtime.bigint()%10000n));}const usage=meter.finish();assert.ok(usage.cpuMs>0);assert.deepEqual(meter.finish(),usage);
  for(const input of [{...usage,protocol:2},{...usage,cpuMs:usage.cpuMs+1},{...usage,cpuSystemMicros:-1},{...usage,elapsedMs:0.5},{...usage,operationId:'arbitrary'}])assert.throws(()=>parseWorkerUsage(input),isCode('WORKER_USAGE_CONTRACT'));
});
