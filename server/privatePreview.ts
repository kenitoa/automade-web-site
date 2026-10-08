import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import type {CreatorIdentity,ExpansionScope} from '../src/domain/expansion';
import type {Store} from './store';
import type {ExpansionService} from './expansion/service';
import type {OperationsService} from './operationsService';
import {body,contained,HttpError,reply} from './http';
import {record} from '../src/domain/validation';
import {integer,text} from './platform/common';
import {html} from '../src/runtime/document';
import {parseLocalizedPath} from '../src/domain/localization';
import {publicProject} from '../src/domain/publication';
import {findContent} from '../src/domain/content';
import {bindOperation} from './operationContext';
interface PreviewGrant {scope:ExpansionScope;releaseId:string;session:string;expiresAt:number}
export class PrivatePreview {
 constructor(readonly store:Store,readonly expansion:ExpansionService,readonly operations:OperationsService){}
 async handle(req:IncomingMessage,res:ServerResponse,url:URL,ctx:{creator:CreatorIdentity|null;localOwner:boolean;sessionKey:string}):Promise<boolean>{
  const gateway=url.pathname.match(/^\/preview\/([a-f0-9]{64})(\/.*)?$/),revoke=url.pathname.match(/^\/api\/advancement\/runtime\/previews\/([a-f0-9]{64})$/),issue=url.pathname==='/api/advancement/runtime/previews'&&req.method==='POST';if(!gateway&&!issue&&!revoke)return false;
  if(!ctx.creator&&!ctx.localOwner)throw new HttpError(401,'PREVIEW_AUTHENTICATION','미리보기를 발급한 계정으로 로그인하세요.');
  if(revoke){if(req.method!=='DELETE')throw new HttpError(405,'PREVIEW_METHOD','삭제 요청을 사용하세요.');const value=this.store.operations.state('system:preview:'+revoke[1]);if(!value)throw new HttpError(404,'PREVIEW_NOT_FOUND','미리보기 링크가 없습니다.');const grant=value as PreviewGrant;if(grant.session!==ctx.sessionKey)throw new HttpError(403,'PREVIEW_OWNER','발급한 세션에서 삭제하세요.');this.expansion.access.authorize(ctx.creator,grant.scope,'project.read',ctx.localOwner);bindOperation(grant.scope,ctx.creator?.id??'local-owner',ctx.creator?'creator':'local-owner');this.store.operations.setState('system:preview:'+revoke[1],null);reply(res,200,{revoked:true});return true;}
  if(issue){const input=record(await body(req,10000)),scope=this.expansion.access.resolve({projectId:text(input.projectId,'사이트 ID',100),environmentId:text(input.environmentId,'환경 ID',100)});this.expansion.access.authorize(ctx.creator,scope,'project.read',ctx.localOwner);await this.operations.previewArtifact(text(input.releaseId,'결과 ID',100),scope);const token=randomBytes(32).toString('hex'),key=createHash('sha256').update(token).digest('hex'),expiresAt=Date.now()+integer(input.ttlMinutes??30,'만료 시간',1,120)*60000;this.store.operations.setState('system:preview:'+key,{scope,releaseId:input.releaseId,session:ctx.sessionKey,expiresAt});bindOperation(scope,ctx.creator?.id??'local-owner',ctx.creator?'creator':'local-owner');reply(res,201,{id:key,url:'/preview/'+token+'/',expiresAt:new Date(expiresAt).toISOString(),mode:'static-review',authenticated:true});return true;}
  if(req.method!=='GET'&&req.method!=='HEAD')throw new HttpError(405,'PREVIEW_READ_ONLY','미리보기에서는 조회만 가능합니다.');
  const key=createHash('sha256').update(gateway![1]!).digest('hex'),value=this.store.operations.state('system:preview:'+key);if(!value||typeof value!=='object')throw new HttpError(404,'PREVIEW_NOT_FOUND','미리보기 링크가 없습니다.');const grant=value as PreviewGrant;if(grant.session!==ctx.sessionKey||grant.expiresAt<=Date.now())throw new HttpError(403,'PREVIEW_EXPIRED','미리보기가 만료되었거나 발급한 세션이 아닙니다.');this.expansion.access.authorize(ctx.creator,grant.scope,'project.read',ctx.localOwner);
  const artifact=await this.operations.previewArtifact(grant.releaseId,grant.scope),relative=gateway![2]??'/',prefix='/preview/'+gateway![1];res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self' 'unsafe-inline'; img-src data: 'self'; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox");
  if(relative.startsWith('/assets/')){const mime:Record<string,string>={'.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'},name=relative.slice('/assets/'.length),extension=path.extname(name).toLowerCase();if(!mime[extension]||extension==='.css'&&name!=='site.css'||!/^[a-zA-Z0-9._/-]{1,300}$/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..'))throw new HttpError(404,'PREVIEW_ASSET','검수 이미지 또는 스타일을 찾을 수 없습니다.');const base=await realpath(path.join(artifact.directory,'output/dist/assets')),file=path.resolve(base,name);if(!contained(base,file)||!contained(base,await realpath(file))||(await lstat(file)).isSymbolicLink())throw new HttpError(403,'PREVIEW_ASSET_PATH','검수 자산의 경로를 확인하세요.');const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extension],'X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);return true;}
  const project=publicProject(artifact.project),localized=parseLocalizedPath(project,relative),page=project.pages.find(page=>page.published&&page.access!=='members'&&page.path===localized.path),content=findContent(project,localized.path);if(!page&&!content)throw new HttpError(404,'PREVIEW_PAGE','공개된 페이지를 찾을 수 없습니다.');
  let document=html(project,page?.id,content?localized.path:undefined,localized.language).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<meta name="robots"[^>]*>/,'<meta name="robots" content="noindex,nofollow">').replace(/\b(href|src)="\/(?!\/)([^"<>]*)"/g,(_,attribute:string,target:string)=>`${attribute}="${prefix}/${target}"`).replace(/<form\b[^>]*>/gi,'<form aria-disabled="true">').replace(/<(input|button|select|textarea)\b/gi,'<$1 disabled');
  document=document.replace('<body style="margin:0">','<body style="margin:0"><p role="note" style="padding:12px;background:#fff3cd;color:#222">로그인한 세션의 읽기 전용 검토 화면입니다. 입력과 실행 동작은 사용할 수 없습니다.</p>');
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(req.method==='HEAD'?undefined:document);return true;
 }
}
