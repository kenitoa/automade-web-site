import test from "node:test";
import assert from "node:assert/strict";
import { createServer, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/store";
import { ExpansionService } from "../server/expansion/service";
import { createProject, createBlock } from "../src/domain/catalog";
import type { CreatorIdentity, ExpansionScope } from "../src/domain/expansion";
import { parseProject } from "../src/domain/validation";
import { packageIntegrity } from "../src/domain/packages";
import { createAccount } from "../server/platform/auth";
import { cancelBooking, createBooking, saveResource } from "../server/platform/business";
import { enqueue, processOutbox, retryOutbox, saveConnection, setConnectionSecretResolver } from "../server/platform/connections";
import { BookingExpansion } from "../server/expansion/bookings";
import { hash, one } from "../server/platform/common";
import { fail, HttpError } from "../server/http";

async function fixture(mode: "local" | "managed" = "local") {
  const root = await mkdtemp(path.join(tmpdir(), "automade-expansion-")), store = new Store(":memory:"), site = new Store(":memory:"), jobs: Array<{ kind: string; scope: ExpansionScope; payload: unknown; actor?: string; options?: { notBefore?: number } }> = [];
  const service = new ExpansionService(store, { mode, dataRoot: root, siteData: async () => site, enqueueJob: async (kind, scope, payload, key, actor, options) => { jobs.push({ kind, scope, payload, actor, options }); return { id: key, status: "waiting" }; } });
  const owner = await service.auth.create({ email: "owner@example.org", password: "long-password-2026", displayName: "Owner" }), member = await service.auth.create({ email: "member@example.org", password: "long-password-2026", displayName: "Member" });
  const identity: CreatorIdentity = { id: owner.id, csrf: "", sessionId: "" }, other: CreatorIdentity = { id: member.id, csrf: "", sessionId: "" };
  const organization = service.organizations.createOrganization(identity, false, { name: "Org" }), workspace = service.organizations.createWorkspace(identity, false, { organizationId: organization.id, name: "Workspace" }), project = createProject("Actual document");
  store.save(project, -1); const scope = service.registerProject(project, workspace.id, identity);
  return { root, store, site, service, identity, other, scope, project, jobs, async close() { store.close(); site.close(); assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), "automade-expansion-"))); await rm(root, { recursive: true, force: true }); } };
}
test("creator identities and site visitors remain separate; scope relationships and per-workspace grants are enforced", async () => {
  const f = await fixture("managed"); try {
    const visitor = await createAccount(f.site.db, { email: "owner@example.org", password: "other-password-2026", displayName: "Visitor" }); assert.notEqual(visitor.id, f.identity.id);
    assert.equal(one(f.store.db, "SELECT id FROM platform_accounts WHERE id=?", String(visitor.id)), null);
    assert.throws(() => f.service.authorizeProject(f.other, f.project.id, "project.read"), /권한/);
    const invite = f.service.organizations.invite(f.identity, false, { organizationId: f.scope.organizationId, email: "member@example.org", workspaceId: f.scope.workspaceId, role: "member", capabilities: ["project.read", "project.edit"] }); f.service.organizations.accept(f.other, invite.token);
    assert.equal(f.service.authorizeProject(f.other, f.project.id, "project.edit").organizationId, f.scope.organizationId);
    const bookingUrl = new URL(`http://localhost/api/platform/booking/resources?projectId=${f.project.id}`); assert.throws(() => f.service.guardRequest({ method: "GET", headers: {} } as IncomingMessage, bookingUrl, { creator: f.other, localOwner: false }), error => error instanceof HttpError && error.code === "PERMISSION");
    const guardCookie = "a".repeat(64); f.store.db.prepare("INSERT INTO creator_sessions VALUES(?,?,?,?)").run(hash(guardCookie), f.other.id, "test-csrf", Date.now() + 60000); const bookingWrite = new IncomingMessage(new Socket()); bookingWrite.method = "PUT"; bookingWrite.headers = { cookie: "automade-creator=" + guardCookie, "x-creator-csrf": "test-csrf" }; assert.throws(() => f.service.guardRequest(bookingWrite, bookingUrl, { creator: f.other, localOwner: false, parsedBody: { name: "Resource", capacity: 1 } }), error => error instanceof HttpError && error.code === "PERMISSION"); bookingWrite.socket.destroy();
    assert.throws(() => f.service.authorizeProject(f.other, f.project.id, "billing.manage"), /권한/);
    assert.throws(() => f.service.access.resolve({ ...f.scope, organizationId: "local" }), /범위/);
    const environment = f.service.organizations.createEnvironment(f.identity, false, { siteId: f.scope.siteId, name: "Staging", kind: "staging" }); assert.notEqual(environment.dataKey, f.project.id);
    f.service.organizations.createEnvironment(f.identity, false, { siteId: f.scope.siteId, name: "Separate production", kind: "production" }); assert.equal(f.service.resolveProjectScope(f.project.id).dataKey, f.project.id); assert.equal(f.service.resolveProjectScope(f.project.id).environmentId, f.scope.environmentId);
    assert.throws(() => f.service.access.resolve({ ...f.scope, environmentId: environment.id }), /범위/);
    f.service.organizations.changeMember(f.identity, false, f.other.id, { organizationId: f.scope.organizationId }, true);
    assert.throws(() => f.service.authorizeJob(f.scope, f.other.id, "project.edit"), /권한/);
    assert.throws(() => f.service.authorizeJob(f.scope, undefined, "project.edit"), /활성/);
  } finally { await f.close(); }
});
test("organization invitations enforce email, expiry, one use and last-owner transfer", async () => {
  const f = await fixture(); try {
    const invite = f.service.organizations.invite(f.identity, false, { organizationId: f.scope.organizationId, email: "member@example.org", role: "member" }); assert.throws(() => f.service.organizations.accept(f.identity, invite.token), /초대/);
    f.service.organizations.accept(f.other, invite.token); assert.throws(() => f.service.organizations.accept(f.other, invite.token), /초대/);
    assert.throws(() => f.service.organizations.changeMember(f.identity, false, f.identity.id, { organizationId: f.scope.organizationId }, true), /마지막/);
    f.service.organizations.transfer(f.identity, false, f.scope.organizationId, f.other.id); assert.equal(f.service.access.role(f.other.id, f.scope.organizationId), "owner");
    assert.equal(f.service.access.role(f.identity.id, f.scope.organizationId), "admin");
  } finally { await f.close(); }
});

test("invited creator registration accepts the intended recipient atomically and cannot reuse an invite", async () => {
  const f = await fixture("managed"); try {
    const invitation = f.service.organizations.invite(f.identity, false, { organizationId: f.scope.organizationId, email: "invited@example.org", workspaceId: f.scope.workspaceId, role: "member", capabilities: ["project.read"] });
    await assert.rejects(f.service.auth.create({ email: "intruder@example.org", password: "invited-password-2026", displayName: "Intruder", inviteToken: invitation.token }), error => error instanceof HttpError && error.code === "INVITE");
    assert.equal(one(f.store.db, "SELECT id FROM creator_accounts WHERE email='intruder@example.org'"), null);
    const account = await f.service.auth.create({ email: "invited@example.org", password: "invited-password-2026", displayName: "Invited", inviteToken: invitation.token });
    assert.equal(f.service.authorizeProject({ id: account.id, csrf: "", sessionId: "" }, f.project.id, "project.read").workspaceId, f.scope.workspaceId);
    assert.equal(one(f.store.db, "SELECT status FROM expansion_invites WHERE token_hash=?", hash(invitation.token))?.status, "accepted");
    await assert.rejects(f.service.auth.create({ email: "second@example.org", password: "invited-password-2026", displayName: "Second", inviteToken: invitation.token }), error => error instanceof HttpError && error.code === "INVITE");
  } finally { await f.close(); }
});

test("central creator recovery delivers through its own outbox and scrubs sent or expired tokens", async () => {
  const saved = Object.fromEntries(["STUDIO_MAIL_ENDPOINT", "STUDIO_MAIL_ALLOWED_HOST", "STUDIO_MAIL_SECRET_REF", "AUTH_TEST_CREATOR_MAIL", "PLATFORM_ALLOWED_HOSTS"].map(key => [key, process.env[key]])), f = await fixture("managed");
  process.env.STUDIO_MAIL_ENDPOINT = "https://provider.example.org/mail"; process.env.STUDIO_MAIL_ALLOWED_HOST = "provider.example.org"; process.env.STUDIO_MAIL_SECRET_REF = "AUTH_TEST_CREATOR_MAIL"; process.env.AUTH_TEST_CREATOR_MAIL = "test-only"; process.env.PLATFORM_ALLOWED_HOSTS = "provider.example.org";
  const server = createServer(async (req, res) => { const address = server.address(), origin = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : ""; try { await f.service.handle(req, res, new URL(req.url!, origin), { requestId: "creator-recovery", localOwner: false, origin }); } catch (error) { fail(res, error, "creator-recovery"); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string"); const origin = `http://127.0.0.1:${address.port}`;
  try {
    await f.service.initialize(); const initial = await fetch(origin + "/api/expansion/session"), cookie = initial.headers.get("set-cookie")!.split(";")[0]!, session = (await initial.json()).data;
    const response = await fetch(origin + "/api/expansion/password-reset/request", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, "X-Creator-CSRF": session.csrf }, body: JSON.stringify({ email: "owner@example.org" }) }); assert.equal(response.status, 200); const requested = (await response.json()).data; assert.equal(requested.delivery, "pending"); assert.equal(requested.localRecoveryToken, undefined);
    const queued = one(f.store.db, "SELECT id,body FROM platform_outbox")!, reset = JSON.parse(String(queued.body)) as { token: string; type: string }; assert.equal(reset.type, "creator.password_reset"); assert.ok(reset.token);
    assert.equal(one(f.site.db, "SELECT id FROM platform_outbox"), null); let delivered = 0;
    await processOutbox(f.store.db, async (_connection, _method, payload) => { delivered++; assert.equal(((payload as Record<string, unknown>).payload as Record<string, unknown>).token, reset.token); return {}; });
    assert.equal(delivered, 1); assert.ok(!String(one(f.store.db, "SELECT body FROM platform_outbox WHERE id=?", String(queued.id))?.body).includes(reset.token));
    const expired = f.service.auth.requestReset("owner@example.org")!; const expiredId = enqueue(f.store.db, "creator-auth", "creator-auth-mail", "expired-central", { type: "creator.password_reset", token: expired }); f.store.db.prepare("UPDATE creator_reset_tokens SET expires_at=0 WHERE token_hash=?").run(hash(expired)); f.store.db.prepare("UPDATE platform_connections SET paused=1 WHERE id='creator-auth-mail'").run();
    await processOutbox(f.store.db, async () => { throw new Error("Expired creator reset must not be delivered"); }); assert.equal(one(f.store.db, "SELECT status FROM platform_outbox WHERE id=?", expiredId)?.status, "failed"); assert.ok(!String(one(f.store.db, "SELECT body FROM platform_outbox WHERE id=?", expiredId)?.body).includes(expired)); assert.throws(() => retryOutbox(f.store.db, "creator-auth", expiredId), error => error instanceof HttpError && error.code === "RESET_TOKEN_REMOVED");
  } finally { await f.service.close(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
test("creator HTTP sessions rotate HttpOnly cookies, require CSRF and expire reset tokens after one use", async () => {
  const f = await fixture(); const server = createServer(async (req, res) => { const address = server.address(); const origin = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : ""; try { await f.service.handle(req, res, new URL(req.url!, origin), { requestId: "test", localOwner: true, origin }); } catch (error) { fail(res, error, "test"); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string"); const origin = `http://127.0.0.1:${address.port}`;
  try {
    const initial = await fetch(origin + "/api/expansion/session"), guestCookie = initial.headers.get("set-cookie")!.split(";")[0]!, guest = (await initial.json()).data; assert.equal(guest.account, null); assert.match(initial.headers.get("set-cookie")!, /HttpOnly/);
    const missing = await fetch(origin + "/api/expansion/login", { method: "POST", headers: { "Content-Type": "application/json", Cookie: guestCookie }, body: JSON.stringify({ email: "owner@example.org", password: "long-password-2026" }) }); assert.equal(missing.status, 403);
    const logged = await fetch(origin + "/api/expansion/login", { method: "POST", headers: { "Content-Type": "application/json", Cookie: guestCookie, "X-Creator-CSRF": guest.csrf }, body: JSON.stringify({ email: "owner@example.org", password: "long-password-2026" }) }); assert.equal(logged.status, 200); const cookie = logged.headers.get("set-cookie")!.split(";")[0]!, session = (await logged.json()).data; assert.notEqual(cookie, guestCookie);
    const raw = f.service.auth.requestReset("owner@example.org")!; assert.ok(!JSON.stringify(one(f.store.db, "SELECT * FROM creator_reset_tokens")).includes(raw));
    await f.service.auth.reset({ token: raw, password: "new-password-2026" }); await assert.rejects(f.service.auth.reset({ token: raw, password: "new-password-2026" }), /만료/);
    const state = await fetch(origin + "/api/expansion/session", { headers: { Cookie: cookie } }); assert.equal((await state.json()).data.account, null); assert.ok(session.csrf);
    const expired = f.service.auth.requestReset("owner@example.org")!; f.store.db.prepare("UPDATE creator_reset_tokens SET expires_at=0").run(); await assert.rejects(f.service.auth.reset({ token: expired, password: "another-password-2026" }), /만료/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});
test("shared brand/component versions use CAS and retain history", async () => {
  const f = await fixture(); try {
    const brand = f.service.library.saveBrand(f.scope.organizationId, { name: "Brand", theme: f.project.theme }); const updated = f.service.library.saveBrand(f.scope.organizationId, { name: "Brand", theme: { ...f.project.theme, radius: 20 }, baseRevision: 1 }, brand.id); assert.equal(updated.revision, 2);
    assert.throws(() => f.service.library.saveBrand(f.scope.organizationId, { name: "Brand", theme: f.project.theme, baseRevision: 1 }, brand.id), /변경/);
    assert.equal(Number(one(f.store.db, "SELECT COUNT(*) AS n FROM expansion_brand_versions WHERE brand_id=?", brand.id)?.n), 2);
    const block = createBlock("text", f.project, f.project.pages[0]!.id); const item = f.service.library.saveItem(f.scope.organizationId, { kind: "component", name: "Headline", body: { id: "headline", name: "Headline", version: 1, blocks: [block] } }); assert.equal(item.kind, "component");
  } finally { await f.close(); }
});
test("blob storage validates bytes, deduplicates by hash, preserves scoped references and detects tampering", async () => {
  const f = await fixture(); try {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
    const a = await f.service.blobs.upload(f.scope, { dataUrl: png, alt: "Red dot", source: "", license: "Own image" }), b = await f.service.blobs.upload(f.scope, { dataUrl: png, alt: "Other label", license: "Own image" }); assert.equal(a.sha256, b.sha256); assert.notEqual(a.id, b.id); assert.equal(a.width, 1);
    assert.equal(Number(one(f.store.db, "SELECT COUNT(*) AS n FROM expansion_blobs")?.n), 1); const bytes = await f.service.blobs.read(f.project.id, a.id); assert.ok(bytes.data.length > 0); await assert.rejects(f.service.blobs.read("another-project", a.id), /찾을/);
    await assert.rejects(f.service.blobs.upload(f.scope, { dataUrl: "data:image/png;base64,PHNjcmlwdD4=", alt: "x", license: "Own" }), /원본/);
    const file = path.join(f.root, "blobs", a.sha256.slice(0, 2), a.sha256); assert.equal((await readFile(file)).length, a.bytes); await writeFile(file, "tamper"); await assert.rejects(f.service.blobs.read(f.project.id, a.id), /무결성/);
    f.service.blobs.remove(f.scope, a.id); assert.equal(f.service.blobs.list(f.scope).length, 1);
  } finally { await f.close(); }
});
test("scoped encrypted secrets and API keys cannot expose another tenant or keep revoked issuer rights", async () => {
  const before = process.env.EXPANSION_SECRET_KEY, beforeHosts = process.env.PLATFORM_ALLOWED_HOSTS; process.env.EXPANSION_SECRET_KEY = "a".repeat(64); process.env.PLATFORM_ALLOWED_HOSTS = "provider.example.org"; const f = await fixture("managed"); try {
    const secret = f.service.secrets.save(f.scope.organizationId, f.identity.id, { name: "TENANT_MAIL_KEY", workspaceId: f.scope.workspaceId, value: "secret-source-value" }); assert.ok(!JSON.stringify(secret).includes("secret-source-value")); assert.ok(!String(one(f.store.db, "SELECT ciphertext FROM expansion_secrets")?.ciphertext).includes("secret-source-value"));
    assert.equal(f.service.secrets.resolve(f.scope, "TENANT_MAIL_KEY"), "secret-source-value"); assert.equal(f.service.secrets.resolve({ ...f.scope, organizationId: "local" }, "TENANT_MAIL_KEY"), undefined);
    setConnectionSecretResolver(f.site.db, ref => f.service.secrets.resolve(f.scope, ref), true);
    assert.throws(() => saveConnection(f.site.db, f.project.id, { name: "bad", kind: "mail", endpoint: "https://provider.example.org/api", allowedHost: "provider.example.org", secretRef: "STUDIO_ADMIN_PASSWORD" }), error => error instanceof HttpError && error.code === "SECRET_REF_RESERVED");
    assert.throws(() => saveConnection(f.site.db, f.project.id, { name: "bad central key", kind: "mail", endpoint: "https://provider.example.org/api", allowedHost: "provider.example.org", secretRef: "AUTH_STUDIO_MAIL_KEY" }), error => error instanceof HttpError && error.code === "SECRET_REF_RESERVED");
    assert.equal(saveConnection(f.site.db, f.project.id, { name: "Actual scoped key", kind: "mail", endpoint: "https://provider.example.org/api", allowedHost: "provider.example.org", secretRef: "TENANT_MAIL_KEY" }).configured, true);
    const credential = f.service.credentials.issue(f.scope, f.identity, false, { name: "Public API", capabilities: ["project.read", "automation.manage"], expiresAt: new Date(Date.now() + 60000).toISOString() }); assert.ok(!String(one(f.store.db, "SELECT token_hash FROM expansion_credentials")?.token_hash).includes(credential.token));
    const req = { headers: { authorization: `Bearer ${credential.token}` } } as IncomingMessage; assert.equal(f.service.credentials.authenticate(req, "project.read").credential.scope.projectId, f.project.id); assert.throws(() => f.service.credentials.authenticate(req, "project.edit"), /範|범위/);
    const raw = JSON.stringify({ eventId: "event", trigger: "manual", payload: {} }), timestamp = String(Date.now()), signature = createHmac("sha256", credential.webhookSecret).update(`${timestamp}.${raw}`).digest("hex"); f.service.credentials.webhook(credential.id, timestamp, raw, signature); assert.throws(() => f.service.credentials.webhook(credential.id, timestamp, raw + " ", signature), /실패/);
    const event = f.service.credentials.claimEvent(credential.id, "event", {}); f.service.credentials.completeEvent(event.id); assert.equal(f.service.credentials.claimEvent(credential.id, "event", {}).completed, true); assert.throws(() => f.service.credentials.claimEvent(credential.id, "event", { changed: true }), /다릅니다/);
    f.store.db.prepare("DELETE FROM expansion_memberships WHERE organization_id=? AND account_id=?").run(f.scope.organizationId, f.identity.id); assert.throws(() => f.service.credentials.authenticate(req, "project.read"), /권한/);
  } finally { await f.close(); if (before === undefined) delete process.env.EXPANSION_SECRET_KEY; else process.env.EXPANSION_SECRET_KEY = before; if (beforeHosts === undefined) delete process.env.PLATFORM_ALLOWED_HOSTS; else process.env.PLATFORM_ALLOWED_HOSTS = beforeHosts; }
});

test("project asset validation binds blob hash, MIME, scope and current creator permission before saving", async () => {
  const f = await fixture("managed"); try {
    const uploaded = await f.service.blobs.upload(f.scope, { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", alt: "Image", license: "Own" }), project = parseProject({ ...f.project, assets: [{ id: "image", name: "Image", mime: uploaded.mime, data: "", alt: "Image", width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, blobRef: { id: uploaded.id, sha256: uploaded.sha256, projectId: f.project.id } }] });
    await f.service.validateProjectAssets(project, f.identity);await assert.rejects(f.service.resolveBlob(project.id,uploaded.id),error=>error instanceof HttpError&&error.code==='ASSET_PUBLICATION_REQUIRED');await f.service.blobs.approve(f.scope,uploaded.id,{baseRevision:uploaded.inspection!.revision,state:'approved',visibility:'public',reason:'원본·사용권·설명 검토'},f.identity.id); const inline = structuredClone(project); inline.assets[0]!.data = await f.service.resolveBlob(project.id, uploaded.id); await f.service.validateProjectAssets(inline, f.identity);
    const hashForgery = structuredClone(project); hashForgery.assets[0]!.blobRef!.sha256 = "0".repeat(64); await assert.rejects(f.service.validateProjectAssets(hashForgery, f.identity), error => error instanceof HttpError && error.code === "BLOB_REFERENCE");
    const wrongScope = structuredClone(project); wrongScope.assets[0]!.blobRef!.projectId = "another-project"; await assert.rejects(f.service.validateProjectAssets(wrongScope, f.identity), error => error instanceof HttpError && error.code === "BLOB_SCOPE");
    const wrongMime = structuredClone(project); wrongMime.assets[0]!.mime = "image/jpeg"; await assert.rejects(f.service.validateProjectAssets(wrongMime, f.identity), error => error instanceof HttpError && error.code === "BLOB_REFERENCE");
    const wrongInline = structuredClone(project); wrongInline.assets[0]!.data = "data:image/png;base64,YW5vdGhlcg=="; await assert.rejects(f.service.validateProjectAssets(wrongInline, f.identity), error => error instanceof HttpError && error.code === "BLOB_REFERENCE");
    await assert.rejects(f.service.validateProjectAssets(project, f.other), error => error instanceof HttpError && error.code === "PERMISSION");
    const invite = f.service.organizations.invite(f.identity, false, { organizationId: f.scope.organizationId, email: "member@example.org", workspaceId: f.scope.workspaceId, role: "member", capabilities: ["project.read"] }); f.service.organizations.accept(f.other, invite.token); await f.service.validateProjectAssets(project, f.other);
    const pending = f.service.validateProjectAssets(project, f.other); f.service.organizations.changeMember(f.identity, false, f.other.id, { organizationId: f.scope.organizationId }, true); await assert.rejects(pending, error => error instanceof HttpError && error.code === "PERMISSION");
  } finally { await f.close(); }
});
test("workflow execution checkpoints actual actions and retries without duplicate outbox delivery", async () => {
  const previousHosts = process.env.PLATFORM_ALLOWED_HOSTS; process.env.PLATFORM_ALLOWED_HOSTS = "provider.example.org"; const f = await fixture(); try {
    assert.throws(() => f.service.workflows.events(f.scope, "manual", undefined, "invalid"), error => error instanceof HttpError && error.code === "WORKFLOW_EVENT");
    f.site.submit("form", "submission-key", { email: "user@example.org" }); const submission = one(f.site.db, "SELECT id FROM submissions")!;
    const connection = saveConnection(f.site.db, f.project.id, { name: "Mail", kind: "mail", endpoint: "https://provider.example.org/mail", allowedHost: "provider.example.org", secretRef: "TEST_MAIL_KEY" });
    const workflow = f.service.workflows.save(f.scope, f.identity.id, { name: "Actual workflow", trigger: "manual", enabled: true, conditions: [], actions: [{ type: "submission.update", status: "processing", tags: ["triage"] }, { type: "connection.enqueue", connectionId: connection.id, template: { subject: "Submission {{submissionId}}" } }] });
    const ids = f.service.workflows.events(f.scope, "manual", { submissionId: submission.id }, "event-one", f.identity.id); assert.equal(f.service.workflows.events(f.scope, "manual", { submissionId: submission.id }, "event-one", f.identity.id)[0], ids[0]);
    let checks = 0; await assert.rejects(f.service.workflows.execute(f.scope, ids[0]!, async () => f.site, () => {}, () => { checks++; if (checks === 2) throw new HttpError(409, "LEASE_LOST", "lease lost"); }), /lease lost/);
    assert.equal(one(f.site.db, "SELECT status FROM submission_workflow")?.status, "processing"); assert.equal(one(f.store.db, "SELECT completed_actions FROM expansion_workflow_runs")?.completed_actions, 1);
    const done = await f.service.workflows.execute(f.scope, ids[0]!, async () => f.site, () => {}, () => {}); assert.equal(done.status, "completed"); assert.equal(done.completedActions, 2);
    await f.service.workflows.execute(f.scope, ids[0]!, async () => f.site, () => {}, () => {}); assert.equal(Number(one(f.site.db, "SELECT COUNT(*) AS n FROM platform_outbox")?.n), 1); assert.ok(workflow.id);
  } finally { await f.close(); if (previousHosts === undefined) delete process.env.PLATFORM_ALLOWED_HOSTS; else process.env.PLATFORM_ALLOWED_HOSTS = previousHosts; }
});
test("usage reservations serialize budgets and settle/release idempotently", async () => {
  const f = await fixture(); try {
    f.service.usage.limit(f.scope.organizationId, { metric: "ai.tokens", amount: 10 }); const reservation = f.service.usage.reserve(f.scope, "ai.tokens", 7, "task-one"); assert.equal(f.service.usage.reserve(f.scope, "ai.tokens", 7, "task-one").id, reservation.id); assert.throws(() => f.service.usage.reserve(f.scope, "ai.tokens", 4, "task-two"), /한도/);
    assert.throws(() => f.service.usage.reserve(f.scope, "ai.tokens", 8, "task-one"), /다릅니다/); assert.throws(() => f.service.usage.settle(f.scope, reservation.id, 8), /초과/);
    assert.equal(f.service.usage.settle(f.scope, reservation.id, 5).status, "committed"); assert.equal(f.service.usage.settle(f.scope, reservation.id, 5).committedAmount, 5); const second = f.service.usage.reserve(f.scope, "ai.tokens", 5, "task-two"); assert.equal(f.service.usage.settle(f.scope, second.id, 0, true).status, "released");
    f.service.usage.limit(f.scope.organizationId, { metric: "ai.requests", amount: 10 }); f.store.operations.setState(`aiUsageOrg:${f.scope.organizationId}:${new Date().toISOString().slice(0, 7)}`, { used: 3 }); assert.equal(f.service.usage.budget(f.scope.organizationId).find(item => item.metric === "ai.requests")?.used, 3);
  } finally { await f.close(); }
});
test("revision review rejects self approval and stale content; field comments and presence persist", async () => {
  const f = await fixture(); try {
    const review = f.service.reviews.submit(f.scope, f.identity.id, 0); assert.throws(() => f.service.reviews.decide(f.scope, f.identity.id, review.id, "approved"), /자신/); assert.equal(f.service.reviews.decide(f.scope, f.other.id, review.id, "approved").status, "approved");
    const another = f.service.reviews.submit(f.scope, f.identity.id, 0); f.store.save({ ...f.project, revision: 1, name: "Changed" }, 0); assert.throws(() => f.service.reviews.decide(f.scope, f.other.id, another.id, "approved"), /변경/);
    const comment = f.service.reviews.comment(f.scope, f.other.id, { revision: 1, targetPath: "settings.description", body: "Please revise" }); f.service.reviews.resolveComment(f.scope, comment.id, true); assert.equal(f.service.reviews.comments(f.scope)[0]!.resolved, true);
    f.service.reviews.heartbeat(f.scope, f.identity.id, { revision: 1, targetPath: "theme.brandColor" }); assert.equal(f.service.reviews.presence(f.scope)[0]!.accountId, f.identity.id);
  } finally { await f.close(); }
});
test("CMS validation invalidates approval and cursor; scheduled publishing checks exact content revision", async () => {
  const f = await fixture(); try {
    const invitation = f.service.organizations.invite(f.identity, false, { organizationId: f.scope.organizationId, email: "member@example.org", workspaceId: f.scope.workspaceId, role: "member", capabilities: ["project.read", "review.approve"] }); f.service.organizations.accept(f.other, invitation.token);
    const initial = parseProject({ ...f.project, revision: 1, collections: [{ id: "news", name: "News", path: "/news", schema: [{ id: "rank", label: "Rank", type: "number", required: true, public: true }], records: [{ id: "record-one", slug: "one", title: "One", body: "Actual content", category: "", imageId: "", fields: {}, values: { rank: 1 }, status: "draft", publishedAt: "", contentRevision: 0, workflow: { state: "draft" } }, { id: "record-two", slug: "two", title: "Two", body: "Actual second", category: "", imageId: "", fields: {}, values: { rank: 2 }, status: "draft", publishedAt: "" }] }] }); f.store.save(initial, 0);
    const page = f.service.content.query(f.scope, "news", new URLSearchParams({ limit: "1", sort: "rank" })); assert.equal(page.records[0]!.id, "record-one"); assert.ok(page.nextCursor);
    const review = f.service.reviews.content(f.scope, f.identity.id, { baseRevision: 1, collectionId: "news", recordId: "record-one", state: "review" }); assert.throws(() => f.service.reviews.content(f.scope, f.identity.id, { baseRevision: review.project.revision, collectionId: "news", recordId: "record-one", state: "approved" }), /다른/);
    const approved = f.service.reviews.content(f.scope, f.other.id, { baseRevision: review.project.revision, collectionId: "news", recordId: "record-one", state: "approved" }); const scheduledAt = new Date(Date.now() + 60000).toISOString();
    const scheduled = f.service.reviews.content(f.scope, f.identity.id, { baseRevision: approved.project.revision, collectionId: "news", recordId: "record-one", state: "scheduled", publishAt: scheduledAt }); assert.ok(scheduled.scheduledAt);
    assert.throws(() => f.service.content.query(f.scope, "news", new URLSearchParams({ cursor: page.nextCursor!, sort: "rank" })), /변경/);
    assert.throws(() => f.service.reviews.publishScheduled(f.scope, { collectionId: "news", recordId: "record-one", contentRevision: 0, publishAt: scheduledAt }), /아직/);
    const edited = f.service.content.upsert(f.scope, "news", { baseRevision: scheduled.project.revision, record: { ...scheduled.project.collections![0]!.records[0]!, title: "New content" } }); assert.equal(edited.record.workflow!.state, "draft"); assert.equal(edited.record.contentRevision, 1);
    assert.throws(() => f.service.reviews.publishScheduled(f.scope, { collectionId: "news", recordId: "record-one", contentRevision: 0, publishAt: scheduledAt }), /변경/);
  } finally { await f.close(); }
});
test("declarative package preview applies reviewed IDs, upgrades preserved overrides and detaches on removal", async () => {
  const f = await fixture(); try {
    const raw = { id: "example.headline", name: "Headline", version: "1.0.0", protocol: 1 as const, definitions: [{ id: "hero", name: "Hero", description: "Declarative", template: "text" as const, defaults: { title: "Initial" } }] }, manifest = { ...raw, integrity: await packageIntegrity(raw) };
    const preview = await f.service.packs.preview(f.scope, f.identity.id, { manifest, mode: "install", baseRevision: 0 }); const project = await f.service.packs.apply(f.scope, f.identity.id, preview.approvalFingerprint); assert.equal(project.blocks[0]!.id, preview.project.blocks[0]!.id); assert.equal(project.blocks[0]!.props.title, "Initial"); assert.equal(f.service.packs.list(f.scope).length, 1);
    const modified = structuredClone(project); modified.blocks[0]!.props.title = "Local override"; modified.revision++; f.store.save(modified, project.revision);
    const upgradeRaw = { ...raw, version: "1.1.0", definitions: [{ ...raw.definitions[0]!, defaults: { title: "Updated" } }] }, upgrade = { ...upgradeRaw, integrity: await packageIntegrity(upgradeRaw) }; const update = await f.service.packs.preview(f.scope, f.identity.id, { manifest: upgrade, mode: "upgrade", baseRevision: modified.revision }); const upgraded = await f.service.packs.apply(f.scope, f.identity.id, update.approvalFingerprint); assert.equal(upgraded.blocks[0]!.props.title, "Local override");
    const remove = await f.service.packs.preview(f.scope, f.identity.id, { manifest: upgrade, mode: "remove", baseRevision: upgraded.revision }); const detached = await f.service.packs.apply(f.scope, f.identity.id, remove.approvalFingerprint); assert.equal(detached.blocks[0]!.type, "text"); assert.equal(detached.blocks[0]!.id, project.blocks[0]!.id); assert.equal(detached.blocks[0]!.props.title, "Local override");
  } finally { await f.close(); }
});

test("scheduled CMS publication rechecks the approving creator's current permission", async () => {
  const f = await fixture("managed"); try {
    const invitation = f.service.organizations.invite(f.identity, false, { organizationId: f.scope.organizationId, email: "member@example.org", workspaceId: f.scope.workspaceId, role: "member", capabilities: ["project.read", "review.approve"] }); f.service.organizations.accept(f.other, invitation.token);
    f.store.save(parseProject({ ...f.project, revision: 1, collections: [{ id: "news", name: "News", path: "/news", records: [{ id: "one", slug: "one", title: "Approved copy", body: "Content", category: "", imageId: "", status: "draft", fields: {}, publishedAt: "", contentRevision: 0, workflow: { state: "draft" } }] }] }), 0);
    const reviewed = f.service.reviews.content(f.scope, f.identity.id, { collectionId: "news", recordId: "one", state: "review", baseRevision: 1 }), approved = f.service.reviews.content(f.scope, f.other.id, { collectionId: "news", recordId: "one", state: "approved", baseRevision: reviewed.project.revision }), publishAt = new Date(Date.now() + 100).toISOString(); f.service.reviews.content(f.scope, f.identity.id, { collectionId: "news", recordId: "one", state: "scheduled", baseRevision: approved.project.revision, publishAt });
    f.service.organizations.changeMember(f.identity, false, f.other.id, { organizationId: f.scope.organizationId }, true); await new Promise(resolve => setTimeout(resolve, 120));
    await assert.rejects(f.service.executeJob("content.publish", f.scope, { collectionId: "news", recordId: "one", contentRevision: 0, publishAt }, f.identity.id), error => error instanceof HttpError && error.code === "PERMISSION"); assert.equal(f.store.project(f.project.id)!.collections![0]!.records[0]!.workflow!.state, "scheduled"); assert.equal(f.jobs.length, 0);
  } finally { await f.close(); }
});
test("booking recurrence is idempotent, holidays block capacity and waitlist offers cannot oversell", async () => {
  const f = await fixture(); try {
    const user = await createAccount(f.site.db, { email: "visitor@example.org", password: "visitor-password-2026", displayName: "Visitor" }), second = await createAccount(f.site.db, { email: "visitor2@example.org", password: "visitor-password-2026", displayName: "Visitor2" }), resource = saveResource(f.site.db, f.project.id, { name: "Resource", capacity: 1 }), expansion = new BookingExpansion(f.site.db);
    const tomorrow = new Date(Date.now() + 86400_000), day = tomorrow.toISOString().slice(0, 10), rule = expansion.saveRule(f.project.id, { resourceId: resource.id, name: "Daily", startDate: day, endDate: day, weekdays: [tomorrow.getUTCDay()], startTime: "12:00", durationMinutes: 30, capacity: 1 }); assert.equal(expansion.materialize(f.project.id, String(rule.id)).created, 1); assert.equal(expansion.materialize(f.project.id, String(rule.id)).created, 0);
    const slotId = String(one(f.site.db, "SELECT id FROM platform_slots")!.id), booked = createBooking(f.site.db, f.project.id, String(user.id), { slotId, quantity: 1, idempotencyKey: "initial-booking" }), waiting = expansion.join(f.project.id, String(second.id), { slotId, quantity: 1 }); assert.equal(expansion.offer(f.project.id).offered, 0); cancelBooking(f.site.db, String(booked.id)); assert.equal(expansion.offer(f.project.id).offered, 1);
    assert.throws(() => createBooking(f.site.db, f.project.id, String(user.id), { slotId, quantity: 1, idempotencyKey: "compete-offer" }), /정원/); const accepted = expansion.accept(f.project.id, String(second.id), String(waiting.id)); assert.equal(accepted.status, "confirmed"); assert.equal(expansion.accept(f.project.id, String(second.id), String(waiting.id)).id, accepted.id);
    assert.throws(() => expansion.saveHoliday(f.project.id, { resourceId: resource.id, date: day, reason: "Closed" }), /확정/); cancelBooking(f.site.db, String(accepted.id));const review=expansion.previewChange(f.project.id,{kind:'holiday',targetId:resource.id,input:{date:day,reason:'Closed'}});expansion.applyChange(f.project.id,review.id,review.approvalFingerprint); assert.throws(() => createBooking(f.site.db, f.project.id, String(user.id), { slotId, idempotencyKey: "holiday" }), /휴일/);
    assert.equal(f.site.db.prepare("SELECT COUNT(*) AS n FROM runtime_state WHERE key LIKE 'workflow:event:%'").get()!.n, 2);
  } finally { await f.close(); }
});
