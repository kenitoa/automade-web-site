import type { Store } from "./store";
import { HttpError } from "./http";
import { record } from "../src/domain/validation";
import { transaction } from "./platform/common";

function optionalInteger(key:string,fallback:number|null):number|null {
  const raw=process.env[key];if(!raw)return fallback;
  const value=Number(raw);if(!Number.isSafeInteger(value)||value<0)throw new Error(`${key} must be a nonnegative integer`);return value;
}
export function validateGenerationBudget():void {
  const limit=optionalInteger("GENERATION_MONTHLY_LIMIT",1000)!,cost=optionalInteger("GENERATION_REQUEST_COST_MINOR",null);optionalInteger("GENERATION_SPEND_LIMIT_MINOR",null);
  if(cost!==null&&!Number.isSafeInteger(limit*cost))throw new Error("Estimated generation spending must remain a safe integer");
  if(process.env.GENERATION_CURRENCY&&!/^[A-Z]{3}$/.test(process.env.GENERATION_CURRENCY))throw new Error("GENERATION_CURRENCY must be a three-letter currency");
  if(process.env.GENERATION_SPEND_LIMIT_MINOR&&!process.env.GENERATION_REQUEST_COST_MINOR)throw new Error("A spend limit requires a configured per-request estimate");
}
export function generationSettings(store:Store):unknown {
  const month=new Date().toISOString().slice(0,7),usage=record(store.operations.state("aiUsage:"+month));
  const used=typeof usage.used==="number"?usage.used:0,cost=optionalInteger("GENERATION_REQUEST_COST_MINOR",null);
  return {configured:Boolean(process.env.GENERATION_API_URL),host:process.env.GENERATION_API_URL?new URL(process.env.GENERATION_API_URL).hostname:null,usage:{period:month,used,budget:optionalInteger("GENERATION_MONTHLY_LIMIT",1000),estimatedCostMinor:cost===null?null:used*cost,spendLimitMinor:optionalInteger("GENERATION_SPEND_LIMIT_MINOR",null),currency:process.env.GENERATION_CURRENCY??"KRW",costVerified:false},sentData:"Selected content and topology; operation-specific preview before apply"};
}
export function reserveGeneration(store:Store,organizationId?:string):void {
  if(!process.env.GENERATION_API_URL)return;
  transaction(store.db,()=>{
  const month=new Date().toISOString().slice(0,7),key="aiUsage:"+month,previous=record(store.operations.state(key));
  const used=typeof previous.used==="number"?previous.used:0,limit=optionalInteger("GENERATION_MONTHLY_LIMIT",1000)!;
  const cost=optionalInteger("GENERATION_REQUEST_COST_MINOR",null),spend=optionalInteger("GENERATION_SPEND_LIMIT_MINOR",null);
  if(used>=limit||(cost!==null&&spend!==null&&(used+1)*cost>spend))throw new HttpError(429,"GENERATION_BUDGET","설정한 생성 요청·예상 비용 한도에 도달했습니다. 연결 설정에서 한도를 확인하세요.");
  if(organizationId){
    const organizationKey=`aiUsageOrg:${organizationId}:${month}`,previousOrganization=record(store.operations.state(organizationKey)),organizationUsed=typeof previousOrganization.used==="number"?previousOrganization.used:0;
    const organizationLimit=store.db.prepare("SELECT amount FROM expansion_usage_limits WHERE organization_id=? AND metric='ai.requests' AND period=?").get(organizationId,month);
    if(!Number.isSafeInteger(organizationUsed+1)||organizationLimit&&organizationUsed+1>Number(organizationLimit.amount))throw new HttpError(429,"ORG_USAGE_LIMIT","조직의 AI 요청 한도에 도달했습니다.");
    store.operations.setState(organizationKey,{used:organizationUsed+1,updatedAt:new Date().toISOString()});
  }
  store.operations.setState(key,{used:used+1,updatedAt:new Date().toISOString()});
  });
}
