import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHmac, randomUUID } from "node:crypto";
import { createProject } from "../src/domain/catalog";
import { Store } from "../server/store";
import { createAccount } from "../server/platform/auth";
import { checkout, createOrder, saveProduct } from "../server/platform/business";
import { setConnectionSecretResolver } from "../server/platform/connections";
import { totp } from "../server/advancement/security";
import type { CreatorAccount, ExpansionWorkspace, Organization } from "../src/domain/expansion";
import type { ApiEnvelope, Project } from "../src/domain/types";

test("compiled managed Studio enforces creator CSRF, ownership, CAS, CMS approval and publication policy over HTTP", { timeout: 60000 }, async () => {
  const previousHosts = process.env.PLATFORM_ALLOWED_HOSTS; process.env.PLATFORM_ALLOWED_HOSTS = "provider.example.org";
  const root = await mkdtemp(path.join(tmpdir(), "automade-managed-http-"));
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve)); const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const publicOrigin = "https://studio.example.test", actual = `http://127.0.0.1:${port}`, child = spawn(process.execPath, [path.resolve("dist-service/server.mjs")], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, APP_MODE: "managed", STUDIO_HOST: "127.0.0.1", STUDIO_PUBLIC_ORIGIN: publicOrigin, STUDIO_ADMIN_EMAIL: "administrator@example.org", STUDIO_ADMIN_PASSWORD: "administrator-password-2026", STUDIO_ALLOW_REGISTRATION: "false", PLATFORM_ALLOWED_HOSTS: "provider.example.org", STUDIO_MAIL_ENDPOINT: "", STUDIO_MAIL_ALLOWED_HOST: "", STUDIO_MAIL_SECRET_REF: "", DATA_DIR: path.join(root, "data"), EXPORT_DIR: path.join(root, "exports"), AUTOMADE_ROOT: process.cwd(), PORT: String(port), EXPANSION_SECRET_KEY: "b".repeat(64) }, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = ""; child.stdout.on("data", chunk => { diagnostic += String(chunk); }); child.stderr.on("data", chunk => { diagnostic += String(chunk); });
  const transport = (route: string, method = "GET", headers: Record<string, string> = {}, value?: unknown): Promise<{ status: number; cookies: string[]; content: string }> => new Promise((resolve, reject) => {
    const request = httpRequest(actual + route, { method, headers: { Host: "studio.example.test", ...headers }, timeout: 10000 }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject); response.on("end", () => resolve({ status: response.statusCode ?? 0, cookies: response.headers["set-cookie"] ?? [], content: Buffer.concat(chunks).toString("utf8") }));
    }); request.on("error", reject); request.on("timeout", () => request.destroy(new Error("Managed HTTP request timed out"))); request.end(value === undefined ? undefined : JSON.stringify(value));
  });
  class Client {
    cookie = ""; csrf = ""; password = ""; recoveryCodes: string[] = [];
    async request<T>(route: string, method = "GET", value?: unknown, csrf = true, stepUpToken?: string): Promise<{ status: number; envelope: ApiEnvelope<T> }> {
      const response = await transport(route, method, { Origin: publicOrigin, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(csrf && this.csrf ? { "X-Creator-CSRF": this.csrf, "X-CSRF-Token": this.csrf } : {}), ...(stepUpToken ? { "X-Step-Up-Token": stepUpToken } : {}), ...(value === undefined ? {} : { "Content-Type": "application/json" }) }, value);
      const cookie = response.cookies[0]; if (cookie) this.cookie = cookie.split(";")[0]!;
      const envelope = JSON.parse(response.content) as ApiEnvelope<T>; return { status: response.status, envelope };
    }
    async session() { const result = await this.request<{ account: CreatorAccount | null; csrf: string; localOwner: boolean }>("/api/expansion/session"); assert.equal(result.status, 200); this.csrf = result.envelope.data!.csrf; return result.envelope.data!; }
    async login(email: string, password: string) { await this.session(); const result = await this.request<{ csrf: string; account: CreatorAccount }>("/api/expansion/login", "POST", { email, password }); assert.equal(result.status, 200); this.csrf = result.envelope.data!.csrf; this.password = password; return result.envelope.data!.account; }
    async enrollMfa() {
      const enrollment = await this.request<{ secret: string }>("/api/advancement/security/enrollment", "POST", { password: this.password });
      assert.equal(enrollment.status, 200, JSON.stringify(enrollment.envelope));
      const confirmed = await this.request<{ recoveryCodes: string[] }>("/api/advancement/security/enrollment/confirm", "POST", { code: totp(enrollment.envelope.data!.secret) });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.envelope));
      this.recoveryCodes = confirmed.envelope.data!.recoveryCodes;
    }
    async approved<T>(route: string, method: string, value: unknown, scope?: { projectId: string; environmentId?: string }) {
      const recoveryCode = this.recoveryCodes.shift(); assert.ok(recoveryCode, "MFA fixture recovery proof exhausted");
      const proof = await this.request<{ token: string }>("/api/advancement/security/step-up", "POST", { password: this.password, recoveryCode, method, path: new URL(route, publicOrigin).pathname, payload: value, ...scope });
      assert.equal(proof.status, 200, JSON.stringify(proof.envelope));
      return this.request<T>(route, method, value, true, proof.envelope.data!.token);
    }
  }
  try {
    let ready = false;
    for (let index = 0; index < 100; index++) { if (child.exitCode !== null) throw new Error("Managed service failed to start: " + diagnostic); try { const response = await transport("/health"); if (response.status === 200) { ready = true; break; } } catch { /* The child may not yet be listening. */ } await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.ok(ready, "Managed health check timed out: " + diagnostic);
    const anonymous = new Client(), local = await anonymous.request<{ role: string; csrf: string }>("/api/session"); assert.equal(local.status, 200); assert.equal(local.envelope.data!.role, "anonymous"); assert.equal((await anonymous.session()).localOwner, false);
    anonymous.cookie = "automade-session=forged-owner"; assert.equal((await anonymous.request("/api/projects")).status, 401);
    const admin = new Client(); await admin.session(); assert.equal((await admin.request("/api/expansion/login", "POST", { email: "administrator@example.org", password: "administrator-password-2026" }, false)).status, 403); await admin.login("administrator@example.org", "administrator-password-2026");
    await admin.enrollMfa();
    const orgA = (await admin.approved<Organization>("/api/expansion/organizations", "POST", { name: "Organization A" })).envelope.data!, orgB = (await admin.approved<Organization>("/api/expansion/organizations", "POST", { name: "Organization B" })).envelope.data!;
    const workspaceInput = { organizationId: orgA.id, name: "Workspace A", config: { requireApproval: true } };
    const deniedWorkspace = await admin.request("/api/expansion/workspaces", "POST", workspaceInput); assert.equal(deniedWorkspace.status, 403); assert.equal(deniedWorkspace.envelope.error!.code, "STEP_UP_REQUIRED");
    const wsA = (await admin.approved<ExpansionWorkspace>("/api/expansion/workspaces", "POST", workspaceInput)).envelope.data!, wsB = (await admin.approved<ExpansionWorkspace>("/api/expansion/workspaces", "POST", { organizationId: orgB.id, name: "Workspace B" })).envelope.data!;
    const projectA = createProject("Private A"), projectB = createProject("Private B"); projectA.collections = [{ id: "news", name: "News", path: "/news", records: [{ id: "one", slug: "one", title: "Original", body: "Editorial content", category: "", imageId: "", status: "published", fields: {}, publishedAt: "", contentRevision: 0 }] }];
    assert.equal((await admin.request(`/api/projects?workspaceId=${wsA.id}`, "PUT", { project: projectA })).status, 400);
    const registeredA = await admin.request<{ project: Project }>(`/api/projects?workspaceId=${wsA.id}`, "PUT", { project: projectA, baseRevision: -1 }); assert.equal(registeredA.status, 200); assert.equal(registeredA.envelope.data!.project.collections![0]!.records[0]!.status, "draft"); Object.assign(projectA, registeredA.envelope.data!.project);
    assert.equal((await admin.request(`/api/projects?workspaceId=${wsB.id}`, "PUT", { project: projectB, baseRevision: -1 })).status, 200);
    assert.equal((await admin.request(`/api/projects?workspaceId=${wsA.id}`, "PUT", { project: { ...projectA, revision: 1 }, baseRevision: -1 })).status, 409);
    assert.equal((await admin.request("/api/generate", "POST", { prompt: "Create a site", name: "Draft" })).status, 400);
    assert.equal((await admin.request("/api/platform/connections")).status, 400);
    const invite = await admin.approved<{ token: string }>("/api/expansion/invites", "POST", { organizationId: orgB.id, email: "team-b@example.org", role: "member", workspaceId: wsB.id, capabilities: ["project.read", "project.edit", "project.publish", "data.read", "data.write", "backup.restore"] }); assert.equal(invite.status, 201);
    const member = new Client(); await member.session(); assert.equal((await member.request("/api/expansion/accounts", "POST", { email: "team-b@example.org", password: "team-member-password-2026", displayName: "Team B" })).status, 403); const create = await member.request<CreatorAccount>("/api/expansion/accounts", "POST", { email: "team-b@example.org", password: "team-member-password-2026", displayName: "Team B", inviteToken: invite.envelope.data!.token }); assert.equal(create.status, 201); await member.login("team-b@example.org", "team-member-password-2026");
    assert.equal((await member.request(`/api/generate?workspaceId=${wsA.id}`, "POST", { prompt: "Create a site", name: "Draft" })).status, 403); assert.equal((await member.request(`/api/generate?workspaceId=${wsB.id}`, "POST", { prompt: "Create a site", name: "Draft" })).status, 403);
    const listed = await member.request<Project[]>("/api/projects"); assert.deepEqual(listed.envelope.data!.map(item => item.id), [projectB.id]); assert.equal((await member.request(`/api/projects/${projectA.id}`)).status, 403); assert.equal((await member.request(`/api/projects/${projectB.id}`)).status, 200);
    const mismatchedSave = await member.request(`/api/projects?projectId=${projectB.id}`, "PUT", { project: { ...projectA, revision: 1 }, baseRevision: 0 }); assert.equal(mismatchedSave.status, 403); assert.equal(mismatchedSave.envelope.error!.code, "SCOPE_MISMATCH");
    assert.equal((await member.request(`/api/save-project?projectId=${projectB.id}`, "POST", { ...projectA, revision: 1, baseRevision: 0 })).status, 403);
    assert.equal((await member.request(`/api/exports?projectId=${projectB.id}`, "POST", { project: projectA })).status, 403);
    assert.equal((await member.request(`/api/generate/proposal?projectId=${projectB.id}`, "POST", { project: projectA, instruction: "Cross scope", operation: "copy" })).status, 403);
    assert.equal((await member.request(`/api/generate/settings?projectId=${projectB.id}`)).status, 200);
    assert.equal((await member.request("/api/exports", "POST", { project: projectA, idempotencyKey: "forbidden" })).status, 403);
    assert.equal((await member.request(`/api/projects/${projectA.id}/data-backups`)).status, 403);
    for (const [name, value] of [["TENANT_PAY_KEY", "test-api-key"], ["TENANT_WEBHOOK_KEY", "test-webhook-key"]]) { const saved = await admin.approved("/api/expansion/secrets", "POST", { organizationId: orgA.id, workspaceId: wsA.id, name, value }); assert.equal(saved.status, 201); }
    const connectionInput = { name: "Actual configured contract", kind: "payment", endpoint: "https://provider.example.org/api", allowedHost: "provider.example.org", secretRef: "TENANT_PAY_KEY", webhookSecretRef: "TENANT_WEBHOOK_KEY" }, connectionRoute = `/api/platform/connections?projectId=${projectA.id}`;
    const deniedConnection = await admin.request(connectionRoute, "PUT", connectionInput); assert.equal(deniedConnection.status, 403); assert.equal(deniedConnection.envelope.error!.code, "STEP_UP_REQUIRED");
    const connection = await admin.approved<{ id: string }>(connectionRoute, "PUT", connectionInput, { projectId: projectA.id }); assert.equal(connection.status, 200, JSON.stringify(connection.envelope));
    const site = new Store(path.join(root, "data", "sites", projectA.id, "site.sqlite")); let orderId: string;
    try { setConnectionSecretResolver(site.db, reference => reference === "TENANT_PAY_KEY" ? "test-api-key" : reference === "TENANT_WEBHOOK_KEY" ? "test-webhook-key" : undefined, true); const buyer = await createAccount(site.db, { email: "visitor@example.org", password: "visitor-password-2026", displayName: "Visitor" }), product = saveProduct(site.db, projectA.id, { name: "Product", priceMinor: 1000, currency: "KRW", inventory: 2 }), order = createOrder(site.db, projectA.id, String(buyer.id), { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: "test-payment" }); orderId = String(order.id); await checkout(site.db, orderId, connection.envelope.data!.id, async () => ({ checkoutUrl: "https://provider.example.org/checkout", paymentId: "payment-http" })); } finally { site.close(); }
    const db = new Store(path.join(root, "data", "studio.sqlite")), exportId = randomUUID(); db.db.prepare("INSERT INTO exports VALUES(?,?,?,'ready',?,NULL)").run(exportId, projectA.id, path.join(root, "exports", exportId), new Date().toISOString()); db.close(); assert.equal((await member.request(`/api/exports/${exportId}/submissions.csv`)).status, 403);
    const stopHeaders = { "Content-Type": "application/json", Cookie: admin.cookie, Origin: publicOrigin, "X-Creator-CSRF": admin.csrf }, emptyStop = await transport(`/api/exports/${exportId}/stop`, "POST", stopHeaders); assert.equal(emptyStop.status, 200); assert.equal((JSON.parse(emptyStop.content) as ApiEnvelope<{ stopped: boolean }>).data!.stopped, true);
    const forbiddenEmptyStop = await transport(`/api/exports/${exportId}/stop`, "POST", { ...stopHeaders, Cookie: member.cookie, "X-Creator-CSRF": member.csrf }); assert.equal(forbiddenEmptyStop.status, 403); assert.equal((JSON.parse(forbiddenEmptyStop.content) as ApiEnvelope<unknown>).error!.code, "PERMISSION");
    const requiredEmptyBody = await transport(`/api/projects?projectId=${projectA.id}`, "PUT", stopHeaders); assert.equal(requiredEmptyBody.status, 400); assert.equal((JSON.parse(requiredEmptyBody.content) as ApiEnvelope<unknown>).error!.code, "INVALID_JSON");
    const callback = `/api/platform/webhooks/${connection.envelope.data!.id}?projectId=${projectA.id}`, event = { eventId: "paid-http", orderId, paymentId: "payment-http", amountMinor: 1000, currency: "KRW", status: "paid", sequence: 1 }, unsigned = await transport(callback, "POST", { "Content-Type": "application/json" }, event); assert.equal(unsigned.status, 401); assert.equal((JSON.parse(unsigned.content) as ApiEnvelope<unknown>).error!.code, "WEBHOOK_SIGNATURE");
    const timestamp = String(Date.now()), signature = createHmac("sha256", "test-webhook-key").update(`${timestamp}.${JSON.stringify(event)}`).digest("hex"), signed = await transport(callback, "POST", { "Content-Type": "application/json", "X-Webhook-Timestamp": timestamp, "X-Webhook-Signature": signature }, event); assert.equal(signed.status, 200); assert.equal((JSON.parse(signed.content) as ApiEnvelope<{ applied: boolean }>).data!.applied, true);
    const wrongScope = await transport(callback + `&environmentId=${projectB.id}-production`, "POST", { "Content-Type": "application/json", "X-Webhook-Timestamp": timestamp, "X-Webhook-Signature": signature }, event); assert.equal(wrongScope.status, 403); assert.equal((JSON.parse(wrongScope.content) as ApiEnvelope<unknown>).error!.code, "SCOPE_MISMATCH");
    const forged = structuredClone(projectA); forged.revision = 1; forged.collections![0]!.records[0]!.body = "Altered and falsely approved"; forged.collections![0]!.records[0]!.status = "published"; forged.collections![0]!.records[0]!.workflow = { state: "published", approvedRevision: 0 }; const saved = await admin.request<{ project: Project }>("/api/projects", "PUT", { project: forged, baseRevision: 0 }); assert.equal(saved.status, 200); assert.equal(saved.envelope.data!.project.collections![0]!.records[0]!.workflow!.state, "draft"); assert.equal(saved.envelope.data!.project.collections![0]!.records[0]!.status, "draft");
    const blocked = await admin.request("/api/exports", "POST", { project: saved.envelope.data!.project, idempotencyKey: "approval-required" }); assert.equal(blocked.status, 409); assert.equal(blocked.envelope.error!.code, "PUBLICATION_APPROVAL");
    assert.ok(!diagnostic.includes("administrator-password-2026")); assert.ok(!diagnostic.includes("team-member-password-2026"));
  } finally {
    if (child.exitCode === null) child.kill(); await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else { const timeout = setTimeout(resolve, 5000); child.once("exit", () => { clearTimeout(timeout); resolve(); }); } });
    assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), "automade-managed-http-"))); await rm(root, { recursive: true, force: true });
    if (previousHosts === undefined) delete process.env.PLATFORM_ALLOWED_HOSTS; else process.env.PLATFORM_ALLOWED_HOSTS = previousHosts;
  }
});
