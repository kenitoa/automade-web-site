export function safeSiteOperation(rawUrl: string): string {
  let pathname: string;
  try { pathname = new URL(rawUrl, "http://localhost").pathname; } catch { return "/invalid"; }
  if (pathname === "/health") return pathname;
  const business = pathname.match(/^\/api\/(forms|tables)\/[^/]+(\/history)?$/);
  if (business) return `/api/${business[1]}/:block${business[2] ?? ""}`;
  if (pathname.startsWith("/api/platform/")) {
    const parts = pathname.slice(14).split("/");
    const roots = ["session", "accounts", "login", "logout", "capabilities", "member-project", "password-reset", "invites", "access", "reviews", "connections", "outbox", "catalog", "orders", "booking", "bookings", "billing", "usage", "webhooks"];
    if (!roots.includes(parts[0] ?? "")) return "/api/platform/unknown";
    const fixed = new Set(["request", "confirm", "accept", "comments", "decision", "test", "pause", "data", "process", "retry", "cancel", "checkout", "refund", "reconcile", "resources", "slots", "connection", "subscription", "invoices", "webhooks", "revoke"]);
    return `/api/platform/${parts.map((part, index) => index === 0 || fixed.has(part) ? part : ":id").join("/")}`;
  }
  return pathname.startsWith("/api/") ? "/api/unknown" : "/static";
}
export function siteRequestLog(input: { rawUrl: string; requestId: string; projectId: string; method: string; durationMs: number; status: number; errorCode: string | null }): Record<string, string | number | null> {
  return { timestamp: new Date().toISOString(), level: input.status >= 500 ? "error" : input.status >= 400 ? "warn" : "info", service: "automade-site", environment: process.env.NODE_ENV ?? "development", requestId: input.requestId, projectId: input.projectId, operation: safeSiteOperation(input.rawUrl), method: input.method, durationMs: Math.max(0, Math.round(input.durationMs)), status: input.status, errorCode: input.errorCode };
}
export function siteBusinessMetric(rawUrl: string, method: string): "form.submit" | "table.save" | null {
  const operation = safeSiteOperation(rawUrl);
  return method === "POST" && operation === "/api/forms/:block" ? "form.submit" : method === "PUT" && operation === "/api/tables/:block" ? "table.save" : null;
}
