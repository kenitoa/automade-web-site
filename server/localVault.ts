import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { contained } from "./http";
export async function initializeVaultKey(dataRoot:string,mode:"local"|"managed"):Promise<void> {
  if(process.env.EXPANSION_SECRET_KEY){if(!/^[a-fA-F0-9]{64}$/.test(process.env.EXPANSION_SECRET_KEY))throw new Error("EXPANSION_SECRET_KEY must contain 64 hexadecimal characters");return;}
  if(mode!=="local")return;
  const folder=path.join(dataRoot,"keys");await mkdir(folder,{recursive:true});
  if(!contained(await realpath(dataRoot),await realpath(folder)))throw new Error("Local vault key path must remain in DATA_DIR");
  const file=path.join(folder,"expansion.key");
  let key:string;
  try{key=(await readFile(file,"utf8")).trim();}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;key=randomBytes(32).toString("hex");try{await writeFile(file,key+"\n",{flag:"wx",mode:0o600});}catch(cause){if((cause as NodeJS.ErrnoException).code!=="EEXIST")throw cause;key=(await readFile(file,"utf8")).trim();}}
  if(!contained(await realpath(dataRoot),await realpath(file))||!/^[a-f0-9]{64}$/.test(key))throw new Error("Local vault key is invalid; preserve existing key and investigate");
  process.env.EXPANSION_SECRET_KEY=key;
}
