import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store';
import {OperationsService} from '../server/operationsService';
import {ExpansionService} from '../server/expansion/service';
import {createProject} from '../src/domain/catalog';

test('storage quota deduplicates artifact alias directories while observation isolates the selected environment',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'automade-storage-usage-')),dataRoot=path.join(root,'data'),exportRoot=path.join(root,'exports');await mkdir(dataRoot);await mkdir(exportRoot);const store=new Store(path.join(dataRoot,'central.sqlite')),site=new Store(':memory:'),operations=new OperationsService(store,process.cwd(),exportRoot,dataRoot),expansion=new ExpansionService(store,{mode:'local',dataRoot,siteData:async()=>site,enqueueJob:async()=>{throw new Error('No fixture worker');}});
 try{const project=createProject('Storage scope');store.save(project);const scope=expansion.registerProject(project,'local',null,true),environment=expansion.organizations.createEnvironment(null,true,{siteId:scope.siteId,name:'Other environment',kind:'staging'}),other=expansion.resolveEnvironmentScope(environment.id);operations.scopeData=async()=>site;let observed=-1;operations.observeStorageUsage=(actual,bytes)=>{assert.equal(actual.environmentId,scope.environmentId);observed=bytes;};
  const file=async(folder:string,bytes:number)=>{await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'bytes.bin'),Buffer.alloc(bytes));};await file(path.join(dataRoot,'sites',scope.dataKey!),11);await file(path.join(dataRoot,'sites',other.dataKey!),13);await file(path.join(dataRoot,'backups',project.id),7);
  for(const [id,bytes,owned] of [['release-a',17,scope],['release-b',19,other]] as const){const folder=path.join(exportRoot,id);await file(folder,bytes);store.db.prepare("INSERT INTO exports VALUES(?,?,?,'ready','fixture',NULL)").run(id,project.id,folder);store.operations.setState('generation:scope:'+id,owned);}store.db.prepare("INSERT INTO exports VALUES('alias-a',?,?,'ready','fixture',NULL)").run(project.id,path.join(exportRoot,'release-a'));store.operations.setState('generation:scope:alias-a',scope);
  for(const [id,bytes,owned] of [['backup-a',23,scope],['backup-b',29,other]] as const){await file(path.join(dataRoot,'backup-sets',id),bytes);store.db.prepare('INSERT INTO advancement_backup_sets VALUES(?,?,?,?)').run(id,JSON.stringify(owned),'{}','fixture');}
  for(const [id,bytes,owned] of [['migration-a',31,scope],['migration-b',37,other]] as const){await file(path.join(dataRoot,'storage-migrations',id),bytes);store.db.prepare("INSERT INTO system_storage_migrations VALUES(?,?,'verified','{}',0,0)").run(id,JSON.stringify(owned));}
  for(const [id,bytes,owned] of [['legacy-a',8,scope],['legacy-b',10,other]] as const){const legacy=path.join(dataRoot,'backups',project.id,id+'.sqlite');await writeFile(legacy,Buffer.alloc(bytes));store.operations.addBackup({id,projectId:project.id,releaseId:null,createdAt:'fixture',bytes,reason:'fixture',submissions:0,tables:0},legacy);store.operations.setState('backup:scope:'+id,{dataKey:owned.dataKey,environmentId:owned.environmentId});}
  assert.equal(await operations.measureStorage(project.id,scope),205);assert.equal(observed,90);assert.equal(site.db.prepare("SELECT value FROM platform_usage WHERE metric='storageBytes'").get()?.value,205);
 }finally{await operations.close();site.close();store.close();}
});
