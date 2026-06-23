import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 2_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function safeFileName(value) {
  const fallback = "interface-project";
  const safe = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return safe || fallback;
}

function createUniqueDirectory(basePath) {
  if (!fs.existsSync(basePath)) {
    fs.mkdirSync(basePath, { recursive: true });
    return basePath;
  }

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  const nextPath = `${basePath}-${stamp}`;
  fs.mkdirSync(nextPath, { recursive: true });
  return nextPath;
}

function writeStaticSiteFiles(folderPath, siteFiles) {
  const requiredFiles = ["index.html", "styles.css", "script.js"];

  for (const fileName of requiredFiles) {
    if (typeof siteFiles?.[fileName] !== "string") {
      throw new Error(`Missing generated site file: ${fileName}`);
    }
  }

  for (const [fileName, content] of Object.entries(siteFiles)) {
    const safeName = path.basename(fileName);
    fs.writeFileSync(path.join(folderPath, safeName), content, "utf8");
  }
}

function writeFileMap(rootPath, files) {
  if (!files || typeof files !== "object") {
    throw new Error("Missing generated React project files.");
  }

  for (const [relativePath, content] of Object.entries(files)) {
    if (typeof content !== "string") {
      throw new Error(`Invalid generated file content: ${relativePath}`);
    }

    const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
    const targetPath = path.resolve(rootPath, normalized);
    const resolvedRoot = path.resolve(rootPath);

    if (!targetPath.startsWith(resolvedRoot)) {
      throw new Error(`Refusing to write outside export folder: ${relativePath}`);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
  }
}

function getRandomPort() {
  return Math.floor(10_000 + Math.random() * 40_000);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function createRandomLaunchPort() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const port = getRandomPort();

    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error("Could not find an available random port for the saved site.");
}

function createLauncherCmd(port) {
  return `@echo off
setlocal

cd /d "%~dp0output"

if not exist "package.json" (
  echo output folder is missing package.json.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing site dependencies...
  call npm install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo Starting generated site on port ${port}...
call npm run dev -- --port ${port} --open

if errorlevel 1 (
  echo Failed to start generated site.
  pause
  exit /b 1
)
`;
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "desktop-project-save",
      configureServer(server) {
        server.middlewares.use("/api/save-project", async (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
            return;
          }

          try {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body);
            const project = payload.project;
            const exportSpec = payload.exportSpec ?? null;
            const siteFiles = payload.siteFiles;
            const reactProjectFiles = payload.reactProjectFiles;
            const desktopPath = path.join(os.homedir(), "Desktop");
            const folderName = `${safeFileName(project?.name)}-react-app`;
            const folderPath = createUniqueDirectory(path.join(desktopPath, folderName));
            const outputPath = path.join(folderPath, "output");
            const launchPort = await createRandomLaunchPort();

            fs.mkdirSync(outputPath, { recursive: true });
            writeFileMap(outputPath, reactProjectFiles);
            const staticFolderPath = path.join(outputPath, "static-site");
            fs.mkdirSync(staticFolderPath, { recursive: true });
            writeStaticSiteFiles(staticFolderPath, siteFiles);
            fs.writeFileSync(
              path.join(outputPath, "project.interface.json"),
              JSON.stringify({ savedAt: new Date().toISOString(), launchPort, project, exportSpec }, null, 2),
              "utf8",
            );
            fs.writeFileSync(path.join(folderPath, "start-site.cmd"), createLauncherCmd(launchPort), "utf8");

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                ok: true,
                path: folderPath,
                entry: path.join(folderPath, "start-site.cmd"),
                output: outputPath,
                launchPort,
                files: [
                  "start-site.cmd",
                  "output/package.json",
                  "output/index.html",
                  "output/vite.config.js",
                  "output/src/main.jsx",
                  "output/src/App.jsx",
                  "output/src/projectData.js",
                  "output/src/styles.css",
                  "output/static-site/index.html",
                  "output/static-site/styles.css",
                  "output/static-site/script.js",
                  "output/project.interface.json",
                ],
              }),
            );
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, error: error.message }));
          }
        });
      },
    },
  ],
  cacheDir: ".vite-cache",
  server: {
    host: "127.0.0.1",
    fs: {
      strict: true,
      allow: [process.cwd()],
    },
  },
});
