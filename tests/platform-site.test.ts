import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBlock, createProject } from "../src/domain/catalog";
import { html } from "../src/runtime/document";
import { Store } from "../server/store";
import { startSite } from "../server/siteServer";
test("persistent release lease rejects old artifact after activation and restart while health remains available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automade-lease-")), dataFile = path.join(root, "canonical.sqlite"), project = createProject("Lease");
  const form = createBlock("form", project, project.pages[0]!.id); project.blocks.push(form); await mkdir(path.join(root, "dist")); await writeFile(path.join(root, "dist/index.html"), html(project));
  const initial = new Store(dataFile); initial.activateRelease("old-release"); initial.close();
  const site = await startSite(root, project, 0, { dataFile, releaseId: "old-release" });
  const submit = () => fetch(`${site.origin}/api/forms/${form.id}`, { method: "POST", headers: { Origin: site.origin, "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: "one", values: { name: "Reader", email: "reader@example.org", message: "Preserved" } }) });
  try {
    assert.equal((await submit()).status, 201);
    const next = new Store(dataFile); next.activateRelease("new-release"); next.close();
    assert.equal((await submit()).status, 409); assert.equal(site.readOnly, true);
    const health = (await (await fetch(`${site.origin}/health`)).json()).data as { revision: number; releaseId: string; status: string };
    assert.equal(health.releaseId, "old-release"); assert.equal(health.revision, project.revision); assert.equal(health.status, "ok");
    assert.equal(site.store.submissions().length, 1);
  } finally { await site.close(); }
  const restarted = await startSite(root, project, 0, { dataFile, releaseId: "old-release" });
  try { assert.equal(restarted.readOnly, true); assert.equal((await fetch(`${restarted.origin}/api/forms/${form.id}`, { method: "POST", headers: { Origin: restarted.origin, "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: "two", values: {} }) })).status, 409); assert.equal(restarted.store.submissions().length, 1); }
  finally { await restarted.close(); }
});
test("member content never appears in public shell/API and becomes readable only after account login", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automade-members-")), project = createProject("Membership");
  const page = { ...project.pages[0]!, id: "members", path: "/members", title: "Members", home: false, access: "members" as const }; project.pages.push(page);
  const text = createBlock("text", project, page.id); text.props.body = "SECRET-MEMBER-CONTENT"; project.blocks.push(text);
  const table = createBlock("table", project, page.id); table.props.rows = [{ id: "private-row", values: ["SECRET-MEMBER-TABLE", "ready"] }]; project.blocks.push(table);
  await mkdir(path.join(root, "dist/members"), { recursive: true }); await writeFile(path.join(root, "dist/index.html"), html(project)); await writeFile(path.join(root, "dist/members/index.html"), html(project, page.id));
  const site = await startSite(root, project); let cookie = "", csrf = "";
  async function request(route: string, method = "GET", input?: unknown) {
    const response = await fetch(`${site.origin}/api/platform/${route}`, { method, headers: { Origin: site.origin, Cookie: cookie, "Content-Type": "application/json", "X-Platform-CSRF": csrf }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const envelope = await response.json() as { data: { csrf?: string } | null };
    if (envelope.data?.csrf) csrf = envelope.data.csrf;
    return { response, envelope };
  }
  try {
    const shell = await (await fetch(`${site.origin}/members`)).text(); assert.ok(!shell.includes("SECRET-MEMBER"));
    assert.equal((await fetch(`${site.origin}/api/tables/${table.id}`)).status, 404);
    assert.equal((await request("member-project")).response.status, 401);
    await request("session"); await request("accounts", "POST", { email: "member@example.org", password: "long-membership-password", displayName: "Member" }); await request("login", "POST", { email: "member@example.org", password: "long-membership-password" });
    assert.ok(JSON.stringify((await request("member-project")).envelope.data).includes("SECRET-MEMBER-CONTENT"));
    const rows = await fetch(`${site.origin}/api/tables/${table.id}`, { headers: { Cookie: cookie } }); assert.equal(rows.status, 200); assert.ok((await rows.text()).includes("SECRET-MEMBER-TABLE"));
  } finally { await site.close(); }
});
test("public binding fails before listen unless HTTPS origin and admin account setup are explicit", async () => {
  const previous = { host: process.env.SITE_HOST, origin: process.env.SITE_PUBLIC_ORIGIN, email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD };
  process.env.SITE_HOST = "0.0.0.0"; delete process.env.SITE_PUBLIC_ORIGIN; delete process.env.PLATFORM_ADMIN_EMAIL; delete process.env.PLATFORM_ADMIN_PASSWORD;
  try { await assert.rejects(startSite(os.tmpdir(), createProject()), /requires HTTPS/); }
  finally { for (const [name, value] of [["SITE_HOST", previous.host], ["SITE_PUBLIC_ORIGIN", previous.origin], ["PLATFORM_ADMIN_EMAIL", previous.email], ["PLATFORM_ADMIN_PASSWORD", previous.password]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});
test("localized aliases redirect to the same language without exposing protected page content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automade-alias-")), project = createProject("Localized");
  project.settings.language = "ko"; project.settings.languages = ["ko", "en"];
  project.pages.push({ ...project.pages[0]!, id: "private", path: "/members", aliases: ["/old-members"], title: "Private", home: false, access: "members" });
  await mkdir(path.join(root, "dist")); await writeFile(path.join(root, "dist/index.html"), html(project));
  const site = await startSite(root, project);
  try {
    const localized = await fetch(`${site.origin}/en/old-members?ref=test`, { redirect: "manual" }); assert.equal(localized.status, 308); assert.equal(localized.headers.get("location"), "/en/members?ref=test"); assert.ok(!(await localized.text()).includes("Private"));
    const original = await fetch(`${site.origin}/old-members`, { redirect: "manual" }); assert.equal(original.headers.get("location"), "/members");
  } finally { await site.close(); }
});
