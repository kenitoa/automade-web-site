import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createBlock, createProject } from "../src/domain/catalog";
import { generate, html, verifyAssets } from "../server/generator";
import { contained } from "../server/http";
import { startSite } from "../server/siteServer";
import { Store } from "../server/store";
test("containment rejects prefix siblings and absolute traversal", () => {
  const root = path.resolve("exports/site");
  assert.equal(contained(root, path.join(root, "dist/index.html")), true);
  assert.equal(contained(root, path.resolve("exports/site-other/file")), false);
  assert.equal(contained(root, path.resolve(root, "../other")), false);
});
test("asset signature validation rejects spoofed MIME", () => {
  const p = createProject();
  p.assets.push({
    id: "asset",
    name: "bad.png",
    mime: "image/png",
    data: "data:image/png;base64,PHNjcmlwdD4=",
    alt: "",
  });
  assert.throws(() => verifyAssets(p));
});
test("pre-rendered page and embedded configuration escape user text", () => {
  const p = createProject("<img src=x onerror=alert(1)>");
  const b = createBlock("hero", p, p.pages[0]!.id);
  b.props.title = "</script><img src=x onerror=alert(1)>";
  p.blocks.push(b);
  const doc = html(p);
  assert.ok(doc.includes("&lt;img"));
  const json = doc.match(
    /<script id="site-config" type="application\/json">(.*?)<\/script>/s,
  )![1]!;
  assert.equal(JSON.parse(json).project.blocks[0].props.title, b.props.title);
  assert.ok(!json.includes("</script>"));
});
test("generated artifact builds, standalone server persists data, and regeneration preserves it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automade-integration-"));
  const p = createProject("실행 검증");
  p.settings.description = "소개";
  const form = createBlock("form", p, p.pages[0]!.id),
    table = createBlock("table", p, p.pages[0]!.id);
  p.blocks.push(form, table);
  const output = await generate(p, {
    root,
    sourceRoot: process.cwd(),
    id: randomUUID(),
  });
  assert.ok(
    (await readFile(path.join(output.source, "dist/assets/site.js"))).length >
      10000,
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(output.source, "quality-report.json"), "utf8"),
    ).build,
    "passed",
  );
  const site = await startSite(output.source, p);
  try {
    const bad = await fetch(site.origin + "/api/forms/" + form.id, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: site.origin },
      body: JSON.stringify({ values: {}, idempotencyKey: "bad" }),
    });
    assert.equal(bad.status, 400);
    const values = {
      name: "테스트 사용자",
      email: "test@example.org",
      message: "문의 내용입니다",
    };
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: site.origin },
      body: JSON.stringify({ values, idempotencyKey: "same-key" }),
    };
    const first = await fetch(site.origin + "/api/forms/" + form.id, init);
    assert.equal(first.status, 201);
    const formId = (await first.json()).data.id;
    const second = await fetch(site.origin + "/api/forms/" + form.id, init);
    assert.equal((await second.json()).data.id, formId);
    assert.equal((await fetch(site.origin + "/.site-data.sqlite")).status, 403);
    assert.equal(
      (
        await fetch(site.origin + "/api/tables/" + table.id, {
          headers: { Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    const written = await fetch(site.origin + "/api/tables/" + table.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: site.origin },
      body: JSON.stringify({
        rows: [{ id: "row", values: ["사례", "완료"] }],
        expectedVersion: 0,
      }),
    });
    assert.equal(written.status, 200);
  } finally {
    await site.close();
  }
  const restarted = await startSite(output.source, p);
  try {
    const tableData = await (
      await fetch(restarted.origin + "/api/tables/" + table.id)
    ).json();
    assert.equal(tableData.data.rows[0].values[0], "사례");
    assert.equal(restarted.store.submissions().length, 1);
  } finally {
    await restarted.close();
  }
  const next = await generate(p, {
    root,
    sourceRoot: process.cwd(),
    id: randomUUID(),
    previousDirectory: output.path,
  });
  const db = new Store(path.join(next.source, ".site-data.sqlite"));
  try {
    assert.equal(db.submissions().length, 1);
    assert.equal(db.table(table.id, [], 2).rows[0]!.values[0], "사례");
  } finally {
    db.close();
  }
});
test("invalid projects cannot be promoted to usable artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automade-reject-"));
  const p = createProject();
  const form = createBlock("form", p, p.pages[0]!.id);
  form.props.dataSource = "none";
  p.blocks.push(form);
  await assert.rejects(
    generate(p, { root, sourceRoot: process.cwd(), id: randomUUID() }),
    /저장 대상/,
  );
});
test("static server rejects symbolic traversal and safe directories are served", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automade-static-"));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist/index.html"), "ready");
  const p = createProject();
  const site = await startSite(root, p);
  try {
    assert.equal((await fetch(site.origin)).status, 200);
    assert.equal((await fetch(site.origin + "/%2e%2e%5csecret")).status, 403);
  } finally {
    await site.close();
  }
});
