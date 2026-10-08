import {createHash} from 'node:crypto';
import {readdirSync,readFileSync,lstatSync,existsSync} from 'node:fs';
import path from 'node:path';
export function sourceIdentity(root){
 const hash=createHash('sha256'),files=[];
 const visit=(relative)=>{const absolute=path.join(root,relative),info=lstatSync(absolute);if(info.isSymbolicLink())throw new Error('Build input must not be a symbolic link: '+relative);if(info.isDirectory()){for(const name of readdirSync(absolute).sort())visit(path.join(relative,name));}else if(info.isFile())files.push(relative.replaceAll('\\','/'));};
 for(const name of ['src','server','scripts','public','infrastructure','package.json','package-lock.json','tsconfig.json','vite.config.ts','eslint.config.js'])if(existsSync(path.join(root,name)))visit(name);
 for(const name of files.sort()){hash.update(name+'\0');hash.update(readFileSync(path.join(root,name)));hash.update('\0');}
 return {hash:hash.digest('hex'),files:files.length};
}
