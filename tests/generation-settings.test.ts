import test from "node:test";
import assert from "node:assert/strict";
import {
  estimatedUsageText,
  parseGenerationSettings,
} from "../src/infrastructure/generationSettings";

const settings = {
  configured: true,
  host: "generation.example",
  usage: {
    used: 2,
    budget: 10,
    estimatedCostMinor: 250,
    spendLimitMinor: 1000,
    currency: "USD",
    costVerified: false,
  },
};

test("generation cost display uses currency minor units and never claims a verified bill", () => {
  const usd = estimatedUsageText(parseGenerationSettings(settings).usage);
  assert.match(usd, /2\.50/);
  assert.match(usd, /10\.00/);
  assert.match(usd, /실청구 미검증/);
  const krw = estimatedUsageText({ ...settings.usage, currency: "KRW" });
  assert.match(krw, /250/);
  assert.match(krw, /1,000/);
  assert.match(
    estimatedUsageText({ ...settings.usage, estimatedCostMinor: null }),
    /요청당 추정비용 미설정/,
  );
});

test("generation settings reject malformed or unsafe budgets", () => {
  assert.throws(() =>
    parseGenerationSettings({
      ...settings,
      usage: { ...settings.usage, estimatedCostMinor: -1 },
    }),
  );
  assert.throws(() =>
    parseGenerationSettings({
      ...settings,
      usage: { ...settings.usage, used: Infinity },
    }),
  );
  assert.throws(() =>
    parseGenerationSettings({
      ...settings,
      usage: { ...settings.usage, currency: "bad value" },
    }),
  );
  assert.throws(() => parseGenerationSettings({ configured: true }));
});
