import { spawn, execFile } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { request } from "node:http";
import { createServer } from "node:net";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export async function startManagedStudio(): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "automade-managed-browser-"));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string")
    throw new Error("Test service port unavailable");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  let openssl = "openssl";
  if (process.platform === "win32") {
    const candidate = "C:/Program Files/Git/usr/bin/openssl.exe";
    try {
      await access(candidate);
      openssl = candidate;
    } catch {
      /* Use the system executable when Git's OpenSSL is absent. */
    }
  }
  const key = path.join(root, "test-key.pem"),
    certificate = path.join(root, "test-cert.pem");
  await promisify(execFile)(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { windowsHide: true, timeout: 10000 },
  );
  const proxy = createHttpsServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    (incoming, outgoing) => {
      const forwarded = request(
        {
          hostname: "127.0.0.1",
          port,
          path: incoming.url,
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode || 502, response.headers);
          response.pipe(outgoing);
        },
      );
      forwarded.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(forwarded);
    },
  );
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const publicAddress = proxy.address();
  if (!publicAddress || typeof publicAddress === "string")
    throw new Error("HTTPS test port unavailable");
  const origin = `https://127.0.0.1:${publicAddress.port}`;
  const child = spawn(
    process.execPath,
    [path.resolve("dist-service/server.mjs")],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        APP_MODE: "managed",
        STUDIO_HOST: "127.0.0.1",
        STUDIO_PUBLIC_ORIGIN: origin,
        STUDIO_ADMIN_EMAIL: "browser-admin@example.org",
        STUDIO_ADMIN_PASSWORD: "browser-administrator-test-2026",
        STUDIO_ALLOW_REGISTRATION: "false",
        STUDIO_MAIL_ENDPOINT: "",
        STUDIO_MAIL_ALLOWED_HOST: "",
        STUDIO_MAIL_SECRET_REF: "",
        DATA_DIR: path.join(root, "data"),
        EXPORT_DIR: path.join(root, "exports"),
        AUTOMADE_ROOT: process.cwd(),
        PORT: String(port),
        EXPANSION_SECRET_KEY: "c".repeat(64),
      },
    },
  );
  let diagnostic = "";
  child.stdout.on("data", (chunk) => {
    diagnostic += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    diagnostic += String(chunk);
  });
  const close = async () => {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    if (child.exitCode === null) child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const prefix = path.join(tmpdir(), "automade-managed-browser-");
    if (!path.resolve(root).startsWith(prefix))
      throw new Error("Unsafe test cleanup target");
    await rm(root, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null)
        throw new Error(`Managed test service failed: ${diagnostic}`);
      const ready = await new Promise<boolean>((resolve) => {
        const health = request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/health",
            headers: { Host: new URL(origin).host },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode === 200);
          },
        );
        health.on("error", () => resolve(false));
        health.end();
      });
      if (ready) return { origin, close };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Managed test service readiness failed: ${diagnostic}`);
  } catch (error) {
    await close();
    throw error;
  }
}
