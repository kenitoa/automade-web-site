import { build } from "esbuild";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import { inspectProject, parseProject } from "../src/domain/validation";
import type { ExportResult, Project } from "../src/domain/types";
import { contained, HttpError } from "./http";
import { Store } from "./store";
export const GENERATOR_VERSION = "1.0.0";
export { html } from "../src/runtime/document";
import { html } from "../src/runtime/document";
export function verifyAssets(project: Project): void {
  let total = 0;
  for (const asset of project.assets) {
    const buffer = Buffer.from(
      asset.data.slice(asset.data.indexOf(",") + 1),
      "base64",
    );
    total += buffer.length;
    if (buffer.length > 5_000_000 || total > 20_000_000)
      throw new HttpError(
        413,
        "ASSET_SIZE",
        "이미지 한 개는 5MB, 전체는 20MB를 초과할 수 없습니다.",
      );
    const png = buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const gif = ["GIF87a", "GIF89a"].includes(
      buffer.subarray(0, 6).toString("ascii"),
    );
    const webp =
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
    if (!(
      (asset.mime === "image/png" && png) ||
      (asset.mime === "image/jpeg" && jpeg) ||
      (asset.mime === "image/gif" && gif) ||
      (asset.mime === "image/webp" && webp)
    ))
      throw new HttpError(
        400,
        "ASSET_MIME",
        "이미지 내용과 MIME 형식이 일치하지 않습니다.",
      );
  }
}
export async function generate(
  projectInput: unknown,
  options: {
    root: string;
    sourceRoot: string;
    id: string;
    previousDirectory?: string | null;
    stage?: (value: string) => void;
    signal?: AbortSignal;
  },
): Promise<Omit<ExportResult, "url">> {
  const started = Date.now();
  const project = parseProject(projectInput);
  verifyAssets(project);
  const issues = inspectProject(project);
  if (issues.some((x) => x.severity === "error"))
    throw new HttpError(
      422,
      "QUALITY",
      issues
        .filter((x) => x.severity === "error")
        .map((x) => x.message)
        .join(" "),
    );
  if (!/^[a-f0-9-]{36}$/.test(options.id))
    throw new Error("Invalid artifact ID");
  const staging = path.join(options.root, `.${options.id}.staging`),
    directory = path.join(options.root, options.id);
  if (!contained(options.root, staging) || !contained(options.root, directory))
    throw new Error("Invalid export root");
  const output = path.join(staging, "output");
  await mkdir(path.join(output, "dist/assets"), { recursive: true });
  const checkpoint = (stage: string) => {
    options.signal?.throwIfAborted();
    options.stage?.(stage);
  };
  checkpoint("소스 구성");
  const names = [
    "src/runtime/SiteApp.tsx",
    "src/runtime/client.tsx",
    "src/runtime/document.tsx",
    "src/runtime/site.css",
    "src/runtime/locale.ts",
    "src/domain/types.ts",
    "src/domain/catalog.ts",
    "src/domain/validation.ts",
    "src/domain/publication.ts",
  ];
  for (const name of names) {
    const destination = path.join(output, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(
      destination,
      await readFile(path.join(options.sourceRoot, name)),
    );
  }
  const packageJson = JSON.parse(
    await readFile(path.join(options.sourceRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  packageJson.name = "generated-website";
  packageJson.scripts = {
    start: "node site-server.mjs --standalone --open",
    dev: "node site-server.mjs --standalone --open",
    build: "node build.mjs",
    typecheck: "tsc --noEmit",
    lint: "eslint src",
    test: "node --test tests/*.test.mjs",
  };
  await writeFile(
    path.join(output, "package.json"),
    JSON.stringify(packageJson, null, 2),
  );
  const lock = JSON.parse(
    await readFile(path.join(options.sourceRoot, "package-lock.json"), "utf8"),
  ) as { name: string; packages: Record<string, { name?: string }> };
  lock.name = "generated-website";
  lock.packages[""]!.name = "generated-website";
  await writeFile(
    path.join(output, "package-lock.json"),
    JSON.stringify(lock, null, 2),
  );
  for (const config of ["eslint.config.mjs"])
    await writeFile(
      path.join(output, config),
      await readFile(path.join(options.sourceRoot, config)),
    );
  await writeFile(
    path.join(output, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          noUncheckedIndexedAccess: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src/**/*.ts", "src/**/*.tsx"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(output, "project.interface.json"),
    JSON.stringify(
      {
        generatorVersion: GENERATOR_VERSION,
        savedAt: new Date().toISOString(),
        project,
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(output, "index.html"), html(project));
  await mkdir(path.join(output, "pages"), { recursive: true });
  await writeFile(path.join(output, "pages/index.html"), html(project));
  await writeFile(
    path.join(output, "build.mjs"),
    "import {build} from 'esbuild';\nimport {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';\nimport {randomUUID} from 'node:crypto';\nimport path from 'node:path';\nconst temporary=path.resolve('.dist-build-'+randomUUID());\nawait mkdir(path.join(temporary,'assets'),{recursive:true});\ntry{\nawait build({entryPoints:['src/runtime/client.tsx'],outfile:path.join(temporary,'assets/site.js'),bundle:true,minify:true,format:'esm',target:'es2022',jsx:'automatic'});\nawait build({entryPoints:['src/runtime/document.tsx'],outfile:'.build-render.mjs',bundle:true,platform:'node',packages:'external',format:'esm',jsx:'automatic'});\nconst {html,parseProject,inspectProject}=await import('./.build-render.mjs?'+Date.now());\nconst raw=JSON.parse(await readFile('project.interface.json','utf8'));\nconst project=parseProject(raw.project??raw);\nif(inspectProject(project).some(i=>i.severity==='error'))throw new Error('Project quality check failed');\nfor(const page of project.pages.filter(p=>p.published)){const folder=path.join(temporary,page.home?'':page.path.slice(1));await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'index.html'),html(project,page.id));}\ntry{await rename('dist','.dist-backup-'+randomUUID());}catch(error){if(error.code!=='ENOENT')throw error;}\nawait rename(temporary,'dist');\n}finally{await rm('.build-render.mjs',{force:true});}\n",
  );
  checkpoint("사이트 빌드");
  await build({
    entryPoints: [path.join(output, "src/runtime/client.tsx")],
    outfile: path.join(output, "dist/assets/site.js"),
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    nodePaths: [path.join(options.sourceRoot, "node_modules")],
    logLevel: "silent",
  });
  await writeFile(path.join(output, "dist/index.html"), html(project));
  for (const page of project.pages.filter((p) => p.published && !p.home)) {
    const relative = page.path.replace(/^\//, "").replace(/\/$/, "");
    const folder = path.join(output, "dist", relative);
    if (!contained(path.join(output, "dist"), folder))
      throw new Error("Invalid page path");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "index.html"), html(project, page.id));
    const sourceFolder = path.join(output, "pages", relative);
    await mkdir(sourceFolder, { recursive: true });
    await writeFile(
      path.join(sourceFolder, "index.html"),
      html(project, page.id),
    );
  }
  await writeFile(
    path.join(output, "site-server.mjs"),
    await readFile(
      path.join(options.sourceRoot, "dist-service/site-server.mjs"),
    ),
  );
  checkpoint("검증과 데이터 보존");
  if (
    options.previousDirectory &&
    contained(options.root, options.previousDirectory)
  ) {
    const previousFile = path.join(
      options.previousDirectory,
      "output/.site-data.sqlite",
    );
    try {
      await stat(previousFile);
      const previous = new Store(previousFile);
      try {
        previous.snapshot(path.join(output, ".site-data.sqlite"));
      } finally {
        previous.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const info = {
    generatorVersion: GENERATOR_VERSION,
    projectId: project.id,
    revision: project.revision,
    issues,
    build: "passed",
    sourceType: "React + TypeScript",
    data: "Local SQLite",
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(output, "quality-report.json"),
    JSON.stringify(info, null, 2),
  );
  await writeFile(
    path.join(output, "README.md"),
    `# ${project.name}\n\n상위 start-site.cmd를 실행하면 빌드된 사이트와 로컬 데이터 API가 열립니다. 생성한 컴퓨터의 Node.js 실행파일을 포함하며 npm 설치 없이 실행합니다. 다른 OS에서는 해당 OS의 Node.js 22.16 이상을 설치하고 npm start를 실행하세요.\n\n## 개발\n\nnpm ci\nnpm run typecheck\nnpm run lint\nnpm test\nnpm run build\n\n## 배포\n\ndist는 정적 결과물입니다. 폼과 편집 가능한 표는 site-server.mjs와 project.interface.json을 함께 실행해야 동작합니다. 서버는 기본적으로 127.0.0.1에만 바인딩됩니다. 공개 배포에는 인증·인가, TLS 프록시와 접근 정책을 먼저 적용하세요.\n\n## 데이터\n\n문의·표 데이터는 .site-data.sqlite에 저장됩니다. 사이트 실행을 종료한 뒤 백업하거나 SQLite 온라인 백업을 사용하세요. 파일을 초기화하지 마세요.\n\n## 결과\n\nquality-report.json에 자동 검사 결과가 있습니다. 실제 기기와 외부 배포 검증은 별도입니다.\n`,
  );
  await mkdir(path.join(output, "tests"), { recursive: true });
  await writeFile(
    path.join(output, "tests/artifact.test.mjs"),
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\ntest('artifact has validated project and compiled site',()=>{const p=JSON.parse(readFileSync('project.interface.json','utf8'));assert.equal(p.project.schemaVersion,2);assert.ok(p.project.pages.length);assert.match(readFileSync('dist/index.html','utf8'),/site-config/);assert.ok(readFileSync('dist/assets/site.js').length);});\n`,
  );
  await mkdir(path.join(output, "runtime"), { recursive: true });
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  await copyFile(process.execPath, path.join(output, "runtime", nodeName));
  try {
    await copyFile(
      path.join(path.dirname(process.execPath), "LICENSE"),
      path.join(output, "runtime/LICENSE"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await copyFile(
      path.join(options.sourceRoot, "licenses/node-LICENSE.txt"),
      path.join(output, "runtime/LICENSE.txt"),
    );
  }
  const launcher = `@echo off\r\nsetlocal\r\ncd /d "%~dp0output"\r\n"runtime\\node.exe" site-server.mjs --standalone --open\r\nif errorlevel 1 pause\r\n`;
  await writeFile(path.join(staging, "start-site.cmd"), launcher);
  await writeFile(
    path.join(staging, "start-site.sh"),
    '#!/bin/sh\ncd "$(dirname "$0")/output" || exit 1\nexec "./runtime/node" site-server.mjs --standalone --open\n',
  );
  checkpoint("결과 확정");
  await rename(staging, directory);
  return {
    id: options.id,
    path: directory,
    entry: path.join(directory, "start-site.cmd"),
    source: path.join(directory, "output"),
    issues,
    durationMs: Date.now() - started,
  };
}
