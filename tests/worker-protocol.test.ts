import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import path from "node:path";
import { workerEnvelope } from "../server/workerProtocol";
import { parseWorkerUsage } from "../server/workerUsage";
import { record } from "../src/domain/validation";

test("worker envelopes retain omitted protocol 1 and reject every unknown version", () => {
  assert.deepEqual(workerEnvelope({ type: "start" }), { type: "start" });
  assert.equal(workerEnvelope({ protocol: 1 }).protocol, 1);
  for (const protocol of [2, 0, -1, null, "1", false, {}, 1.5])
    assert.throws(() => workerEnvelope({ protocol }), /지원하지 않는/);
  for (const input of [null, [], "message"])
    assert.throws(() => workerEnvelope(input), /메시지 형식/);
});

test("generation, site and expansion source workers reject future IPC before opening files or running work", async () => {
  for (const entry of [
    "generationWorker.ts",
    "siteWorker.ts",
    "expansionWorker.ts",
  ]) {
    const child = fork(path.join(process.cwd(), "server", entry), [], {
      silent: true,
      windowsHide: true,
      execArgv: ["--import", "tsx"],
    });
    child.stdout?.resume();
    child.stderr?.resume();
    try {
      const result = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Protocol rejection timed out: ${entry}`)),
            10000,
          );
          child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once("message", (input) => {
            clearTimeout(timeout);
            resolve(record(input));
          });
          child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(
              new Error(`Worker exited without a rejection: ${entry}, ${code}`),
            );
          });
          child.send({ protocol: 2 });
        },
      );
      assert.equal(result.protocol, 1);
      assert.equal(result.type, "error");
      assert.equal(result.code, "WORKER_PROTOCOL", entry);
      if (entry === "generationWorker.ts") {
        const usage = parseWorkerUsage(result.usage);
        assert.equal(
          usage.cpuMs,
          Math.ceil((usage.cpuUserMicros + usage.cpuSystemMicros) / 1000),
        );
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
        child.kill();
        await exited;
      }
    }
  }
});
