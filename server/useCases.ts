import type {ExpansionCapability} from '../src/domain/expansion';
export interface UseCaseContract {id:string;capability:ExpansionCapability;target:'project'|'environment'|'organization';transaction:'read'|'sqlite'|'saga';requiredInput:string[];errors:string[]}
const define=(id:string,capability:ExpansionCapability,target:UseCaseContract['target'],transaction:UseCaseContract['transaction'],requiredInput:string[]=[]):UseCaseContract=>({id,capability,target,transaction,requiredInput,errors:['INPUT_INVALID','PERMISSION','SCOPE_MISMATCH','REVISION_CONFLICT']});
export const USE_CASES={
 'project.read':define('project.read','project.read','project','read'),
 'project.command':define('project.command','project.edit','project','sqlite',['commandId','baseRevision','changes']),
 'project.publish':define('project.publish','project.publish','environment','saga',['requestKey']),
 'content.save':define('content.save','project.edit','project','sqlite',['commandId','expectedRevision','record']),
 'content.approve':define('content.approve','review.approve','project','sqlite',['commandId','expectedRevision']),
 'backup.restore':define('backup.restore','backup.restore','environment','saga',['backupId']),
 'environment.configure':define('environment.configure','project.publish','environment','sqlite',['baseRevision','approvalFingerprint']),
 'automation.run':define('automation.run','automation.manage','environment','saga',['requestKey']),
 'connection.use':define('connection.use','connection.use','environment','saga'),
 'secret.rotate':define('secret.rotate','secret.rotate','environment','sqlite'),
 'data.write':define('data.write','data.write','environment','sqlite'),
 'experiment.manage':define('experiment.manage','project.publish','environment','sqlite'),
 'experiment.track':define('experiment.track','project.read','environment','sqlite',['assignmentId','eventId']),
 'team.manage':define('team.manage','team.manage','organization','sqlite'),
} as const;
export type UseCaseId=keyof typeof USE_CASES;
export function runtimeUseCase(route:string,method:string):UseCaseContract|null {
 if(method==='GET'&&/^(overview|contracts|operations|collaboration|observability|alerts|experiments(?:\/[^/]+\/report)?|releases\/[^/]+\/preview|worker-policy|storage-migrations)$/.test(route))return USE_CASES['project.read'];
 if(method==='POST'&&/^experiments\/[^/]+\/(assignment|events)$/.test(route))return USE_CASES['experiment.track'];
 if(method==='POST'&&/^experiments(?:\/[^/]+\/stop)?$/.test(route))return USE_CASES['experiment.manage'];
 if(method==='POST'&&/^releases\/[^/]+\/(promote|reconcile)$/.test(route))return USE_CASES['project.publish'];
 if(method==='PUT'&&route==='worker-policy')return USE_CASES['team.manage'];
 if(method==='PUT'&&/^alerts\/[^/]+$/.test(route))return USE_CASES['team.manage'];
 if(method==='POST'&&/^storage-migrations(?:\/[^/]+\/(verify|cutover|rollback))?$/.test(route))return USE_CASES['backup.restore'];
 return null;
}
export const SYSTEM_CONTRACT={httpEnvelope:1,api:1,command:1,workerIpc:1,documentSchema:2,artifactReadable:[1,2],migrations:15,policyVersion:1,useCases:Object.values(USE_CASES)};
export function jobUseCase(kind:string):UseCaseContract {return kind.startsWith('workflow.')?USE_CASES['automation.run']:kind.startsWith('booking.')?USE_CASES['data.write']:kind.startsWith('connection.')?USE_CASES['connection.use']:USE_CASES['project.publish'];}
