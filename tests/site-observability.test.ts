import test from "node:test";
import assert from "node:assert/strict";
import { safeSiteOperation, siteBusinessMetric, siteRequestLog } from "../server/siteObservability";
test("site request diagnostics retain correlation and omit request values and query secrets", () => {
  const diagnostic = siteRequestLog({ rawUrl: "/api/forms/person@example.org?token=SECRET&email=PRIVATE", requestId: "request", projectId: "project", method: "POST", durationMs: 17.4, status: 400, errorCode: "VALIDATION" });
  assert.equal(diagnostic.operation, "/api/forms/:block"); assert.equal(diagnostic.requestId, "request"); assert.equal(diagnostic.durationMs, 17); assert.equal(diagnostic.level, "warn");
  assert.ok(!/SECRET|PRIVATE|person@example/.test(JSON.stringify(diagnostic)));
  assert.equal(safeSiteOperation("/api/platform/billing/webhooks/SECRET?token=PRIVATE"), "/api/platform/billing/webhooks/:id"); assert.equal(safeSiteOperation("/private/person@example.org"), "/static");
  assert.equal(siteBusinessMetric("/api/forms/form?token=SECRET", "POST"), "form.submit"); assert.equal(siteBusinessMetric("/api/tables/table", "PUT"), "table.save"); assert.equal(siteBusinessMetric("/api/tables/table/history", "GET"), null);
});
