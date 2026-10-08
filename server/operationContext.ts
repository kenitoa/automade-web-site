import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type {ExpansionScope} from '../src/domain/expansion';
export interface OperationContext {operationId:string;requestId:string;traceId:string;spanId:string;actorKey?:string;realm?:'creator'|'local-owner'|'service'|'system';scope?:ExpansionScope;baseRevision?:number;requestKey?:string;fingerprint?:string;policyVersion:number}
export const operationContext=new AsyncLocalStorage<OperationContext>();
export function newOperation(requestId:string=randomUUID()):OperationContext{return {operationId:requestId,requestId,traceId:randomUUID().replaceAll('-',''),spanId:randomUUID().replaceAll('-','').slice(0,16),policyVersion:1};}
export function bindOperation(scope:ExpansionScope|undefined,actorKey?:string,realm?:OperationContext['realm']):void{const context=operationContext.getStore();if(context){if(scope)context.scope=scope;if(actorKey)context.actorKey=actorKey;if(realm)context.realm=realm;}}
