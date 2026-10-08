import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { randomUUID } from "node:crypto";
import { parseProject, record } from "../src/domain/validation";
import { fromTemplate, suggestTemplate, type TemplateId } from "../src/domain/templates";
import type { Project } from "../src/domain/types";
import { HttpError } from "./http";
import { minimizeProposalProject } from "../src/domain/proposals";
import { minimizeScopedProposal, type ProposalScope } from "../src/domain/scopedProposals";
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a! >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 100 && b! >= 64 && b! <= 127)
    );
  }
  return isIP(address) === 6 && /^[23]/.test(address);
}
export function validateGenerationConfig(): void {
  const endpoint = process.env.GENERATION_API_URL;
  if (!endpoint) {
    if (process.env.GENERATION_API_KEY || process.env.GENERATION_API_HOST)
      throw new Error(
        "GENERATION_API_URL is required with provider credentials",
      );
    return;
  }
  const u = new URL(endpoint);
  if (
    u.protocol !== "https:" ||
    u.hostname !== process.env.GENERATION_API_HOST ||
    u.username ||
    u.password ||
    u.hash ||
    [...u.searchParams.keys()].some(key => /(?:token|secret|password|api.?key|authorization)/i.test(key)) ||
    (u.port && u.port !== "443")
  )
    throw new Error(
      "GENERATION_API_URL requires HTTPS, port 443 and matching GENERATION_API_HOST",
    );
}
export async function generateFromBrief(
  prompt: string,
  name: string,
  options: { template?: TemplateId; mode?: "template" | "recommend"; brief?: Project["settings"]["brief"]; baseProject?: Project; operation?: string; targetBlockId?: string; proposalScope?: ProposalScope } = {},
): Promise<{ project: Project; source: string }> {
  const template = options.mode === "template" && options.template ? options.template : suggestTemplate(prompt);
  const base = options.baseProject ?? fromTemplate(template, name, prompt);
  if (options.brief) base.settings.brief = options.brief;
  if (!process.env.GENERATION_API_URL)
    return {
      project: base,
      source: "설명 기반 로컬 템플릿",
    };
  validateGenerationConfig();
  const url = new URL(process.env.GENERATION_API_URL);
  let dnsDeadline:ReturnType<typeof setTimeout>|undefined;
  const addresses = await Promise.race([lookup(url.hostname, { all: true }),new Promise<never>((_resolve,reject)=>{dnsDeadline=setTimeout(()=>reject(new HttpError(504,"GENERATION_EXTERNAL","생성 서비스의 주소 조회 제한 시간을 초과했습니다.")),5000);})]).finally(()=>clearTimeout(dnsDeadline));
  if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
    throw new HttpError(
      503,
      "GENERATION_CONFIG",
      "생성 API는 공개 네트워크 주소여야 합니다.",
    );
  const requestId = randomUUID();
  const sentProject = options.baseProject ? options.proposalScope ? minimizeScopedProposal(base,options.proposalScope) : minimizeProposalProject(base, options.targetBlockId) : structuredClone(base);
  const payload = JSON.stringify({
    prompt,
    name,
    schemaVersion: 2,
    template,
    mode: options.mode ?? "recommend",
    brief: options.brief,
    operation: options.operation ?? "draft",
    baseProject: sentProject,
    targetBlockId: options.targetBlockId,
    scope: options.proposalScope,
    constraints: { maxPages: 100, maxBlocks: 1000, noInventedClaims: true },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: { status: number; body: string };
    try {
      response = await new Promise((resolve, reject) => {
        const req = request(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
              "X-Request-ID": requestId,
              "Idempotency-Key": requestId,
              ...(process.env.GENERATION_API_KEY
                ? { Authorization: "Bearer " + process.env.GENERATION_API_KEY }
                : {}),
            },
            // Pin the previously validated addresses so DNS rebinding cannot reach local services.
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, addresses);
              else callback(null, addresses[0]!.address, addresses[0]!.family);
            },
          },
          (res) => {
            let size = 0;
            const chunks: Buffer[] = [];
            res.on("data", (data: Buffer) => {
              size += data.length;
              if (size > 32_000_000) {
                req.destroy(new Error("Response limit"));
                return;
              }
              chunks.push(data);
            });
            res.on("error", reject);
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 502,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        const deadline = setTimeout(
          () => req.destroy(new Error("Deadline exceeded")),
          20000,
        );
        req.once("close", () => clearTimeout(deadline));
        req.once("error", reject);
        req.end(payload);
      });
    } catch {
      throw new HttpError(
        502,
        "GENERATION_EXTERNAL",
        "생성 서비스 연결이 실패했거나 제한 시간을 초과했습니다.",
      );
    }
    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new HttpError(
        502,
        "GENERATION_EXTERNAL",
        "생성 서비스가 요청을 처리하지 못했습니다.",
      );
    try {
      const value = record(JSON.parse(response.body) as unknown);
      const project = parseProject(value.project ?? record(value.data).project);
      if (options.mode === "template" || options.baseProject) {
        if (JSON.stringify(project.pages.map(p => [p.id,p.path,p.home])) !== JSON.stringify(base.pages.map(p => [p.id,p.path,p.home])) || JSON.stringify(project.blocks.map(b => [b.id,b.type,b.pageId,b.parentId])) !== JSON.stringify(base.blocks.map(b => [b.id,b.type,b.pageId,b.parentId]))) throw new Error("Template structure changed");
        project.id = base.id;
        project.revision = base.revision;
      }
      return {
        project,
        source: "설정된 외부 생성 API",
      };
    } catch {
      throw new HttpError(
        502,
        "GENERATION_SCHEMA",
        "생성 서비스 응답이 프로젝트 형식과 일치하지 않습니다.",
      );
    }
  }
  throw new HttpError(
    502,
    "GENERATION_EXTERNAL",
    "생성 서비스 재시도 한도를 초과했습니다.",
  );
}
