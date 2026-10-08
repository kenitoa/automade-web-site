import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {sourceIdentity} from './source-identity.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceId = createHash("sha256")
  .update(root.toLowerCase())
  .digest("hex")
  .slice(0, 16);
const marker = path.join(root, ".data/running.json");
const expectedBuild=sourceIdentity(root).hash;
const expectedVersion = (await readFile(path.join(root, "src/domain/version.ts"), "utf8")).match(/GENERATOR_VERSION = "([^"]+)"/)?.[1];
if(!expectedVersion)throw new Error("생성 서비스 버전 정보를 확인할 수 없습니다.");
async function healthy(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "127.0.0.1") return false;
    const h = await fetch(url + "/health", {
      signal: AbortSignal.timeout(2000),
    });
    const j = await h.json();
    if (
      j.data?.service !== "automade-studio" ||
      j.data?.workspaceId !== workspaceId ||
      j.data?.generatorVersion !== expectedVersion || j.data?.buildHash!==expectedBuild
    )
      return false;
    const html = await (
      await fetch(url, { signal: AbortSignal.timeout(2000) })
    ).text();
    return html.includes('id="root"');
  } catch {
    return false;
  }
}
function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("실행 실패: " + code)),
    );
  });
}
async function open(url) {
  console.log(
    "\nAutomade: " +
      url +
      "\n브라우저가 열리지 않으면 위 주소를 직접 입력하세요.\n",
  );
  try {
    if (process.platform === "win32")
      await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        'Start-Process -FilePath "' + url + '"',
      ]);
    else await run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
  } catch (error) {
    console.error("브라우저 실행 실패: " + error.message);
  }
}
try {
  let previous;
  try {
    previous = JSON.parse(await readFile(marker, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (previous?.url && (await healthy(previous.url))) {
    await open(previous.url);
  } else {
    if(previous?.url)console.log("기존 서버를 재사용할 수 없어 최신 버전을 실행합니다. 이전 실행 창이 남아 있다면 종료하세요.");
    const npmCli = path.join(
      path.dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    );
    console.log("편집기와 생성 서버를 빌드합니다.");
    await run(process.execPath, [npmCli, "run", "build"]);
    const preferredPort = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve("0"));
      probe.listen(5173, "127.0.0.1", () => probe.close(() => resolve("5173")));
    });
    const server = spawn(process.execPath, ["dist-service/server.mjs"], {
      cwd: root,
      env: { ...process.env, PORT: preferredPort, AUTOMADE_ROOT: root },
      stdio: ["inherit", "pipe", "inherit"],
      windowsHide: true,
    });
    let startup = "";
    let settled = false;
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        server.kill();
        reject(new Error("서버 준비 시간이 초과되었습니다."));
      }, 30000);
      server.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.once("exit", (code) => {
        if (!settled) {
          clearTimeout(timer);
          reject(new Error("서버 종료: " + code));
        }
      });
      server.stdout.on("data", (data) => {
        process.stdout.write(data);
        startup += data.toString();
        const found = startup.match(/AUTOMADE_URL=(http:\/\/127\.0\.0\.1:\d+)/);
        if (found && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
    });
    if (!(await healthy(url))) {
      server.kill();
      throw new Error("편집기 준비 확인에 실패했습니다.");
    }
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(
      marker,
      JSON.stringify({ url, pid: server.pid, workspaceId }),
    );
    await open(url);
    process.once("SIGINT", () => server.kill("SIGINT"));
    process.once("SIGTERM", () => server.kill("SIGTERM"));
    await new Promise((resolve) => server.once("exit", resolve));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
