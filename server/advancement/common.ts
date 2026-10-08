import { createHash } from "node:crypto";
import type { ExpansionScope } from "../../src/domain/expansion";
export function canonical(value: unknown): string { if (value === undefined) return "null"; if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"; return "{" + Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+":"+canonical(item)).join(",") + "}"; }
export const fingerprint = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export const scopeKey = (scope: ExpansionScope | undefined): string => scope ? scope.environmentId ?? scope.dataKey ?? scope.projectId : "studio";
