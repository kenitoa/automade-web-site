import { record } from "../domain/validation";

export interface GenerationProviderSettings {
  configured: boolean;
  host: string | null;
  usage: {
    used: number;
    budget: number;
    estimatedCostMinor: number | null;
    spendLimitMinor: number | null;
    currency: string;
    costVerified: boolean;
  };
}

export function parseGenerationSettings(
  value: unknown,
): GenerationProviderSettings {
  const data = record(value),
    usage = record(data.usage);
  const nonnegative = (item: unknown): item is number =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  if (
    typeof data.configured !== "boolean" ||
    (data.host !== null && typeof data.host !== "string") ||
    !nonnegative(usage.used) ||
    !nonnegative(usage.budget) ||
    (usage.estimatedCostMinor !== null &&
      !nonnegative(usage.estimatedCostMinor)) ||
    (usage.spendLimitMinor !== null && !nonnegative(usage.spendLimitMinor)) ||
    typeof usage.currency !== "string" ||
    !/^[A-Z]{3}$/.test(usage.currency) ||
    typeof usage.costVerified !== "boolean"
  )
    throw new Error("생성 공급자 설정 응답을 확인하지 못했습니다.");
  return {
    configured: data.configured,
    host: data.host,
    usage: {
      used: usage.used,
      budget: usage.budget,
      estimatedCostMinor: usage.estimatedCostMinor,
      spendLimitMinor: usage.spendLimitMinor,
      currency: usage.currency,
      costVerified: usage.costVerified,
    },
  };
}

export function estimatedUsageText(
  usage: GenerationProviderSettings["usage"],
): string {
  const format = new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: usage.currency,
  });
  const fraction = format.resolvedOptions().maximumFractionDigits ?? 2;
  const amount = (minor: number) => format.format(minor / 10 ** fraction);
  return usage.estimatedCostMinor === null
    ? "요청당 추정비용 미설정 · 실청구 미검증"
    : `예상 비용 ${amount(usage.estimatedCostMinor)} / 한도 ${usage.spendLimitMinor === null ? "미설정" : amount(usage.spendLimitMinor)} (실청구 미검증)`;
}
