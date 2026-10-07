import { generate } from "../server/generator";
import { fromTemplate } from "../src/domain/templates";
import { parseProject } from "../src/domain/validation";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  checks: Array<{ command: string; status: string }> = [];
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run npm run verify:delivery");
const p = parseProject(
  fromTemplate("company", "독립 실행 검증", "웹사이트 제작 도구 검증"),
);
const artifact = await generate(p, {
  root: path.join(root, "exports/verified-delivery"),
  sourceRoot: root,
  id: randomUUID(),
});
function run(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli!, ...args], {
      cwd: artifact.source,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      checks.push({
        command: "npm " + args.join(" "),
        status: code === 0 ? "passed" : "failed",
      });
      if (code === 0) resolve();
      else reject(new Error("Generated source validation failed"));
    });
  });
}
await run(["ci", "--no-audit", "--no-fund"]);
for (const command of ["typecheck", "lint", "test", "build"])
  await run(["run", command]);
const doc = await readFile(
  path.join(artifact.source, "dist/index.html"),
  "utf8",
);
assert.match(doc, /site-config/);
const node = path.join(
  artifact.source,
  "runtime",
  process.platform === "win32" ? "node.exe" : "node",
);
const child = spawn(node, ["site-server.mjs", "--standalone"], {
  cwd: artifact.source,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.on("data", (data) => {
  stderr += data;
});
try {
  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error("Standalone readiness timeout")),
      15000,
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error("Standalone exited " + code + ": " + stderr));
    });
    child.stdout.on("data", (data) => {
      output += data;
      const found = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (found) {
        clearTimeout(timeout);
        resolve(found[0]);
      }
    });
  });
  assert.equal((await fetch(url + "/health")).status, 200);
  assert.match(await (await fetch(url)).text(), /site-config/);
  for (const page of p.pages.filter((page) => page.published)) {
    assert.equal((await fetch(url + page.path)).status, 200);
  }
  const form = p.blocks.find((block) => block.type === "form")!;
  assert.ok(form);
  const response = await fetch(url + "/api/forms/" + form.id, {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      values: {
        name: "Delivery test",
        email: "test@example.org",
        message: "Verified generated source",
      },
    }),
  });
  assert.equal(response.status, 201);
  assert.ok((await response.json()).data.id);
  checks.push({
    command: "bundled Node standalone + page routes + real form persistence",
    status: "passed",
  });
  await mkdir(path.join(root, ".data"), { recursive: true });
  await writeFile(
    path.join(root, ".data/delivery-verification.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        node: process.version,
        artifact: artifact.path,
        checks,
      },
      null,
      2,
    ),
  );
  console.log("DELIVERY_VERIFIED=" + artifact.path);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGTERM");
    await exited;
  }
}
