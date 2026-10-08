import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BlobAsset, ExpansionScope } from "../../src/domain/expansion";
import { HttpError } from "../http";
import { audit, integer, many, now, one, text, transaction, type SqlRow } from "../platform/common";
import { fingerprint } from "../advancement/common";
import type { AssetInspection } from "../../src/domain/advancement";
import { processImage, type DecodedImage, type ImageVariantSpec } from "../imageProcessing";
import { UsageService } from "./usage";

export function imageMetadata(data: Buffer): { mime: BlobAsset["mime"]; width: number; height: number } {
  let mime: BlobAsset["mime"], width = 0, height = 0;
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.readUInt32BE(8) === 13 && data.toString("ascii", 12, 16) === "IHDR") { mime = "image/png"; width = data.readUInt32BE(16); height = data.readUInt32BE(20); }
  else if (data.length >= 14 && /^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) { mime = "image/gif"; width = data.readUInt16LE(6); height = data.readUInt16LE(8); }
  else if (data.length > 20 && data[0] === 255 && data[1] === 216 && data[data.length - 2] === 255 && data[data.length - 1] === 217) {
    mime = "image/jpeg"; let offset = 2;
    while (offset + 4 < data.length) {
      if (data[offset] !== 255) break; const marker = data[offset + 1]!, size = data.readUInt16BE(offset + 2);
      if (size < 2 || offset + size + 2 > data.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) { height = data.readUInt16BE(offset + 5); width = data.readUInt16BE(offset + 7); break; }
      offset += size + 2;
    }
  } else if (data.length >= 30 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" && data.readUInt32LE(4) + 8 === data.length) {
    mime = "image/webp"; const format = data.toString("ascii", 12, 16);
    if (format === "VP8X") { width = data.readUIntLE(24, 3) + 1; height = data.readUIntLE(27, 3) + 1; }
    else if (format === "VP8 " && data.subarray(23, 26).equals(Buffer.from([157,1,42]))) { width = data.readUInt16LE(26) & 16383; height = data.readUInt16LE(28) & 16383; }
    else if (format === "VP8L" && data[20] === 47) { width = 1 + ((data[21]! | data[22]! << 8) & 16383); height = 1 + ((data[22]! >> 6 | data[23]! << 2 | data[24]! << 10) & 16383); }
  } else throw new HttpError(400, "IMAGE_TYPE", "PNG, JPEG, GIF, WEBP 이미지 원본이 필요합니다.");
  if (width < 1 || height < 1 || width > 16000 || height > 16000 || width * height > 40_000_000) throw new HttpError(400, "IMAGE_SIZE", "이미지 크기 또는 헤더를 확인하세요.");
  return { mime, width, height };
}
export class BlobService {
  readonly root: string;
  readonly dataRoot: string;
  constructor(readonly db: DatabaseSync, dataRoot: string) { this.dataRoot = path.resolve(dataRoot); this.root = path.resolve(dataRoot, "blobs"); }
  inspection(id:string):AssetInspection|undefined {if(!one(this.db,"SELECT name FROM sqlite_master WHERE name='advancement_asset_states'"))return undefined;const row=one(this.db,"SELECT * FROM advancement_asset_states WHERE ref_id=?",id);return row?{state:String(row.state) as AssetInspection['state'],visibility:String(row.visibility) as AssetInspection['visibility'],revision:Number(row.revision),inspection:JSON.parse(String(row.inspection)),sourceRef:row.source_ref?String(row.source_ref):null,reason:String(row.reason)}:undefined;}
  private dto(row: SqlRow): BlobAsset { return { id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id), sha256: String(row.sha256), mime: String(row.mime) as BlobAsset["mime"], bytes: Number(row.bytes), width: Number(row.width), height: Number(row.height), alt: String(row.alt), source: String(row.source), license: String(row.license), createdAt: String(row.created_at), contentUrl: `/api/expansion/blobs/${String(row.id)}/content`,inspection:this.inspection(String(row.id)) }; }
  assertPublishable(projectId:string,ids:string[]):void {for(const id of ids){if(!one(this.db,"SELECT 1 FROM expansion_blob_refs WHERE id=? AND project_id=?",id,projectId))throw new HttpError(403,"BLOB_SCOPE","공개할 파일의 프로젝트 범위를 확인하세요.");const value=this.inspection(id);if(value&&(value.state!=='approved'||value.visibility!=='public'))throw new HttpError(409,"ASSET_PUBLICATION_REQUIRED","격리 중·검사 거절·비공개 자산은 발행할 수 없습니다. 원본 검토와 공개 승인을 완료하세요.");}}
  list(scope: ExpansionScope): BlobAsset[] { return many(this.db, "SELECT r.*,b.mime,b.bytes,b.width,b.height FROM expansion_blob_refs r JOIN expansion_blobs b ON b.sha256=r.sha256 WHERE r.organization_id=? AND r.project_id=? ORDER BY r.created_at DESC LIMIT 500", scope.organizationId, scope.projectId).map(row => this.dto(row)); }
  private async location(sha: string, create = false): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new HttpError(400, "BLOB_ID", "파일 식별자를 확인하세요.");
    if (create) { await mkdir(this.root, { recursive: true }); await mkdir(path.join(this.root, sha.slice(0, 2)), { recursive: true }); }
    const allowed = await realpath(this.dataRoot), base = await realpath(this.root), folder = await realpath(path.join(this.root, sha.slice(0, 2)));
    if (path.relative(allowed, base).startsWith("..") || path.isAbsolute(path.relative(allowed, base)) || path.relative(base, folder).startsWith("..") || path.isAbsolute(path.relative(base, folder))) throw new HttpError(403, "BLOB_PATH", "저장 경로가 허용 범위를 벗어났습니다.");
    return path.join(folder, sha);
  }
  async upload(scope: ExpansionScope, input: Record<string, unknown>, assertCurrent:()=>void=()=>{}): Promise<BlobAsset> {
    assertCurrent();
    const url = text(input.dataUrl, "이미지", 12_000_000), match = url.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2]!.length % 4 !== 0) throw new HttpError(400, "IMAGE_DATA", "올바른 이미지 원본이 필요합니다.");
    const bytes = Buffer.from(match[2]!, "base64"); if (bytes.length > 8_000_000 || bytes.length === 0) throw new HttpError(413, "IMAGE_LIMIT", "이미지는 8MB 이하여야 합니다.");
    const header = imageMetadata(bytes); if (header.mime !== match[1]) throw new HttpError(400, "IMAGE_TYPE", "이미지 MIME과 원본 형식이 다릅니다.");
    const sha=createHash('sha256').update(bytes).digest('hex'),sourceRef=input.sourceRef===undefined?null:text(input.sourceRef,'변형 원본',100),requestKey=this.requestKey(input,sourceRef),digest=fingerprint([scope,sha,text(input.alt,'대체 설명',2000),text(input.source??'','출처',2000,true),text(input.license,'사용 권한',1000),sourceRef]);
    const receipt=requestKey?one(this.db,'SELECT * FROM advancement_asset_upload_receipts WHERE project_id=? AND request_key=?',scope.projectId,requestKey):null;
    if(receipt){if(receipt.fingerprint!==digest)throw new HttpError(409,'ASSET_UPLOAD_CONFLICT','같은 업로드 키의 이미지 또는 사용 조건이 다릅니다.');assertCurrent();return(await this.read(scope.projectId,String(receipt.ref_id))).asset;}
    const metadata=await processImage(bytes,header.mime,undefined,usage=>new UsageService(this.db).observe(scope,usage.operationId,'cpu',usage.cpuMs));
    return this.storeImage(scope,input,bytes,metadata,assertCurrent);
  }
  private requestKey(input:Record<string,unknown>,sourceRef:string|null):string|null {return input.requestKey===undefined?sourceRef&&input.variantKey?`variant:${sourceRef}:${text(input.variantKey,'변형 키',80)}`:null:text(input.requestKey,'업로드 키',200);}
  private async storeImage(scope:ExpansionScope,input:Record<string,unknown>,bytes:Buffer,metadata:DecodedImage,assertCurrent:()=>void,afterCommit?:(id:string)=>void):Promise<BlobAsset> {
    const alt = text(input.alt, "대체 설명", 2000), source = text(input.source ?? "", "출처", 2000, true), license = text(input.license, "사용 권한", 1000), sha = createHash("sha256").update(bytes).digest("hex");
    assertCurrent();const file = await this.location(sha, true);
    try { const handle = await open(file, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; const actual = await realpath(file), allowed = await realpath(this.root); if (path.relative(allowed, actual).startsWith("..") || path.isAbsolute(path.relative(allowed, actual))) throw new HttpError(403, "BLOB_PATH", "파일 저장 경로를 확인하세요."); const existing = await readFile(actual); if (createHash("sha256").update(existing).digest("hex") !== sha) throw new HttpError(409, "BLOB_INTEGRITY", "기존 파일 무결성을 확인하세요."); }
    const id = randomUUID(), createdAt = now(),sourceRef=input.sourceRef===undefined?null:text(input.sourceRef,"변형 원본",100),requestKey=this.requestKey(input,sourceRef),digest=fingerprint([scope,sha,alt,source,license,sourceRef]);
    if(sourceRef){const parent=await this.read(scope.projectId,sourceRef);if(parent.asset.organizationId!==scope.organizationId||parent.asset.inspection?.state==='rejected'||metadata.width>parent.asset.width||metadata.height>parent.asset.height)throw new HttpError(400,"ASSET_VARIANT","같은 프로젝트의 검사 가능한 원본과 원본 이하의 변형 크기를 지정하세요.");}
    assertCurrent();const saved=transaction(this.db, () => {
      if(sourceRef){const parent=one(this.db,'SELECT r.organization_id,b.width,b.height,s.state FROM expansion_blob_refs r JOIN expansion_blobs b ON b.sha256=r.sha256 LEFT JOIN advancement_asset_states s ON s.ref_id=r.id WHERE r.id=? AND r.project_id=?',sourceRef,scope.projectId);if(!parent||parent.organization_id!==scope.organizationId||parent.state==='rejected'||metadata.width>Number(parent.width)||metadata.height>Number(parent.height))throw new HttpError(409,'ASSET_VARIANT','변형 원본의 권한 또는 검토 상태가 바뀌었습니다.');}
      const receipt=requestKey?one(this.db,"SELECT * FROM advancement_asset_upload_receipts WHERE project_id=? AND request_key=?",scope.projectId,requestKey):null;
      if(receipt){if(receipt.fingerprint!==digest)throw new HttpError(409,"ASSET_UPLOAD_CONFLICT","같은 업로드 키의 이미지 또는 사용 조건이 다릅니다.");afterCommit?.(String(receipt.ref_id));return String(receipt.ref_id);}
      this.db.prepare("INSERT INTO expansion_blobs VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(sha, metadata.mime, bytes.length, metadata.width, metadata.height, createdAt); this.db.prepare("INSERT INTO expansion_blob_refs VALUES(?,?,?,?,?,?,?,?)").run(id, sha, scope.organizationId, scope.projectId, alt, source, license, createdAt);
      const {data:_data,...inspection}=metadata;void _data;
      if(one(this.db,"SELECT name FROM sqlite_master WHERE name='advancement_asset_states'"))this.db.prepare("INSERT INTO advancement_asset_states VALUES(?,'quarantined','private',1,?,NULL,'공개 승인 대기',?,?,?)").run(id,JSON.stringify({kind:'decoded-pixels',malwareScan:'not-configured',...inspection}),sourceRef,createdAt,createdAt);
      if(requestKey)this.db.prepare("INSERT INTO advancement_asset_upload_receipts VALUES(?,?,?,?)").run(scope.projectId,requestKey,digest,id);afterCommit?.(id);audit(this.db, "asset.upload", id);return id;
    });
    return (await this.read(scope.projectId,saved)).asset;
  }
  async variant(scope:ExpansionScope,id:string,input:Record<string,unknown>,assertCurrent:()=>void=()=>{}):Promise<BlobAsset> {
    assertCurrent();
    const parent=await this.read(scope.projectId,id),spec:ImageVariantSpec={width:integer(input.width,'변형 너비',1,parent.asset.width),height:integer(input.height,'변형 높이',1,parent.asset.height),format:String(input.format) as ImageVariantSpec['format']};
    if(!['png','webp'].includes(spec.format)||parent.asset.organizationId!==scope.organizationId||parent.asset.inspection?.state==='rejected')throw new HttpError(400,'ASSET_VARIANT','검토 가능한 원본과 PNG/WEBP 형식을 지정하세요.');
    const requestKey=text(input.requestKey,'변형 요청 키',160),key='asset:resize:'+fingerprint([scope.organizationId,scope.projectId,requestKey]),digest=fingerprint([id,parent.asset.sha256,spec,'sharp-0.35.5']),claim=randomUUID();
    const prior=transaction(this.db,()=>{const row=one(this.db,'SELECT value FROM runtime_state WHERE key=?',key),value=row?JSON.parse(String(row.value)) as Record<string,unknown>:undefined;if(value){if(value.fingerprint!==digest)throw new HttpError(409,'ASSET_VARIANT_CONFLICT','같은 변형 요청 키의 원본 또는 설정이 다릅니다.');if(value.status==='complete'&&typeof value.refId==='string')return value.refId;if(value.status==='running'&&Number(value.leaseUntil)>Date.now())throw new HttpError(409,'ASSET_VARIANT_RUNNING','같은 변형 요청이 진행 중입니다.');}this.db.prepare('INSERT INTO runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify({fingerprint:digest,status:'running',claim,leaseUntil:Date.now()+30000}));return null;});
    if(prior){assertCurrent();return(await this.read(scope.projectId,prior)).asset;}
    try{
      const resized=await processImage(parent.data,parent.asset.mime,spec,usage=>new UsageService(this.db).observe(scope,usage.operationId,'cpu',usage.cpuMs));if(!resized.data)throw new HttpError(502,'IMAGE_WORKER_CONTRACT','변형 원본 바이트가 필요합니다.');
      const current=():void=>{assertCurrent();const row=one(this.db,'SELECT value FROM runtime_state WHERE key=?',key),state=row?JSON.parse(String(row.value)) as Record<string,unknown>:null;if(!state||state.claim!==claim||Number(state.leaseUntil)<=Date.now())throw new HttpError(409,'ASSET_VARIANT_LEASE','변형 작업 소유권이 바뀌었습니다.');};
      return await this.storeImage(scope,{alt:parent.asset.alt,source:parent.asset.source,license:parent.asset.license,sourceRef:id,requestKey:'resize:'+fingerprint([key,digest])},resized.data,resized,current,refId=>this.db.prepare('UPDATE runtime_state SET value=? WHERE key=?').run(JSON.stringify({fingerprint:digest,status:'complete',refId}),key));
    }catch(error){transaction(this.db,()=>{const row=one(this.db,'SELECT value FROM runtime_state WHERE key=?',key);if(row&&JSON.parse(String(row.value)).claim===claim)this.db.prepare('UPDATE runtime_state SET value=? WHERE key=?').run(JSON.stringify({fingerprint:digest,status:'failed'}),key);});throw error;}
  }
  async approve(scope:ExpansionScope,id:string,input:Record<string,unknown>,actor:string,assertCurrent:()=>void=()=>{}):Promise<BlobAsset> {if(!['approved','rejected'].includes(String(input.state))||!['public','private'].includes(String(input.visibility)))throw new HttpError(400,"ASSET_APPROVAL","승인 상태와 공개 범위를 선택하세요.");const asset=await this.read(scope.projectId,id),metadata=await processImage(asset.data,asset.asset.mime,undefined,usage=>new UsageService(this.db).observe(scope,usage.operationId,'cpu',usage.cpuMs));assertCurrent();transaction(this.db,()=>{const changed=this.db.prepare("UPDATE advancement_asset_states SET state=?,visibility=?,revision=revision+1,inspection=?,approved_by=?,reason=?,updated_at=? WHERE ref_id=? AND revision=?").run(String(input.state),input.state==='rejected'?'private':String(input.visibility),JSON.stringify({kind:'decoded-pixels',malwareScan:'not-configured',...metadata,metadataStripped:asset.asset.inspection?.inspection.metadataStripped??false}),actor,text(input.reason,"검토 사유",1000),now(),id,integer(input.baseRevision,"자산 revision",1));if(!changed.changes)throw new HttpError(409,"ASSET_APPROVAL_CONFLICT","자산 검토 상태가 바뀌었습니다.");audit(this.db,"asset.review",id,String(input.state));});return (await this.read(scope.projectId,id)).asset;}
  async read(projectId: string, id: string): Promise<{ asset: BlobAsset; data: Buffer }> {
    const row = one(this.db, "SELECT r.*,b.mime,b.bytes,b.width,b.height FROM expansion_blob_refs r JOIN expansion_blobs b ON b.sha256=r.sha256 WHERE r.id=? AND r.project_id=?", id, projectId);
    if (!row) throw new HttpError(404, "BLOB_NOT_FOUND", "파일을 찾을 수 없습니다.");
    const file = await this.location(String(row.sha256)), actual = await realpath(file), base = await realpath(this.root);
    if (path.relative(base, actual).startsWith("..") || path.isAbsolute(path.relative(base, actual)) || !(await stat(actual)).isFile()) throw new HttpError(403, "BLOB_PATH", "파일 경로를 확인하세요.");
    const data = await readFile(actual); if (data.length !== Number(row.bytes) || createHash("sha256").update(data).digest("hex") !== row.sha256) throw new HttpError(409, "BLOB_INTEGRITY", "파일 무결성 검증에 실패했습니다."); return { asset: this.dto(row), data };
  }
  remove(scope: ExpansionScope, id: string): void { const result = this.db.prepare("DELETE FROM expansion_blob_refs WHERE id=? AND project_id=? AND organization_id=?").run(id, scope.projectId, scope.organizationId); if (!result.changes) throw new HttpError(404, "BLOB_NOT_FOUND", "파일 참조를 찾을 수 없습니다."); audit(this.db, "asset.reference.remove", id); }
}
