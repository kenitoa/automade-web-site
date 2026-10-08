import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { WORK_MIGRATION, WorkQueue, ResourceLeases } from "../server/workQueue";
import { StudioSessions } from "../server/studioSessions";
import { studioConfig } from "../server/studioConfig";
import { studioOperation } from "../server/studioObservability";
import { HttpError } from "../server/http";
const scope = (organizationId: string) => ({ organizationId, workspaceId: `${organizationId}-workspace`, projectId: `${organizationId}-project` });
test("studio traces use bounded route names and remove arbitrary path and query values",()=>{assert.equal(studioOperation("/api/projects/private-person@example.org/data-backups?token=private"),"/api/projects/:id/data-backups");assert.equal(studioOperation("/api/expansion/credentials/secret-value/rotate"),"/api/expansion/credentials/:id/rotate");});
function database(): DatabaseSync { const db = new DatabaseSync(":memory:"); db.exec(WORK_MIGRATION); return db; }
test("durable queue enforces idempotency, organization limits and fair claims", () => {
  const db = database(); let clock = 1000; const queue = new WorkQueue(db, "worker-a", 2, () => clock);
  try {
    const first = queue.enqueue("automation.run", scope("alpha"), { id: "run-a" }, "key-a"); clock++;
    assert.equal(queue.enqueue("automation.run", scope("alpha"), { id: "run-a" }, "key-a").id, first.id);
    assert.throws(() => queue.enqueue("automation.run", scope("alpha"), { id: "different" }, "key-a"), /내용/);
    queue.enqueue("automation.run", scope("alpha"), { id: "run-b" }, "key-b"); clock++;
    queue.enqueue("automation.run", scope("beta"), { id: "run-c" }, "key-c");
    const a = queue.claim()!, b = queue.claim()!; assert.equal(a.scope.organizationId, "alpha"); assert.equal(b.scope.organizationId, "beta"); assert.equal(queue.claim(), null);
    assert.equal(queue.complete(a, { completed: true }), true); assert.equal(queue.claim()?.scope.organizationId, "alpha");
    queue.limits("gamma", 1, 1); queue.enqueue("automation.run", scope("gamma"), {}, "one"); assert.throws(() => queue.enqueue("automation.run", scope("gamma"), {}, "two"), /한도/);
  } finally { db.close(); }
});
test("expired worker cannot renew, succeed or fail a newer lease", () => {
  const db = database(); let clock = 1000; const old = new WorkQueue(db, "old", 2, () => clock), current = new WorkQueue(db, "current", 2, () => clock);
  try {
    const job = old.enqueue("content.publish", scope("alpha"), {}, "publish"); const claim = old.claim(1000)!;
    clock += 1001; const next = current.claim(1000)!; assert.equal(next.id, job.id); assert.notEqual(next.leaseToken, claim.leaseToken);
    assert.equal(old.renew(claim), false); assert.equal(old.complete(claim, "late"), false); assert.equal(old.fail(claim, new Error("late")), false);
    assert.equal(current.complete(next, "latest"), true); assert.equal(old.get(job.id)?.result, "latest"); assert.equal(old.get(job.id)?.attempts, 2);
  } finally { db.close(); }
});
test("external-effect recovery remains unknown until operator verifies retry", () => {
  const db = database(); let clock = 1000; const queue = new WorkQueue(db, "worker", 2, () => clock);
  try {
    const item = queue.enqueue("delivery.send", scope("alpha"), {}, "send", undefined, { recovery: "manual" }); queue.claim(1000); clock += 1001;
    assert.equal(queue.claim(), null); assert.equal(queue.get(item.id)?.status, "unknown"); assert.throws(() => queue.retry(item.id), /공급자/);
    assert.equal(queue.retry(item.id, true).status, "waiting"); queue.cancel(item.id); assert.equal(queue.get(item.id)?.status, "cancelled");
  } finally { db.close(); }
});
test("cancelling a claimed external-effect job preserves unknown results while a verified completion remains succeeded",()=>{
  const db=database(),queue=new WorkQueue(db);try{const uncertain=queue.enqueue("workflow.run",scope("alpha"),{},"cancel-effect",undefined,{recovery:"manual"}),claim=queue.claim()!;queue.cancel(uncertain.id);queue.fail(claim,new HttpError(409,"WORK_CANCELLED","cancel requested"));assert.equal(queue.get(uncertain.id)?.status,"unknown");assert.throws(()=>queue.retry(uncertain.id),/공급자/);
    const known=queue.enqueue("workflow.run",scope("alpha"),{},"confirmed-effect",undefined,{recovery:"manual"}),completed=queue.claim()!;queue.cancel(known.id);queue.complete(completed,{committed:true});assert.equal(queue.get(known.id)?.status,"succeeded");assert.deepEqual(queue.get(known.id)?.result,{committed:true});
    const interrupted=queue.enqueue("workflow.run",scope("alpha"),{},"interrupted-effect",undefined,{recovery:"manual"});queue.claim();queue.cancel(interrupted.id);db.prepare("UPDATE work_items SET lease_until=? WHERE id=?").run(Date.now()-1,interrupted.id);assert.equal(queue.claim(),null);assert.equal(queue.get(interrupted.id)?.status,"unknown");
  }finally{db.close();}
});
test("queue worker start drains runnable jobs and stops without spinning when capacity is held", async () => {
  const db = database(), queue = new WorkQueue(db); const id = queue.enqueue("content.publish", scope("alpha"), {}, "publish").id;
  try {
    queue.start(async (_job, context) => { context.assertCurrent(); return { published: true }; });
    const until = Date.now() + 2500; while (queue.get(id)?.status !== "succeeded" && Date.now() < until) await new Promise<void>(resolve => setTimeout(resolve, 30));
    assert.equal(queue.get(id)?.status, "succeeded"); assert.equal(queue.metrics("alpha")[0]?.count, 1);
  } finally { await queue.close(); db.close(); }
});
test("persistent resource reservations block exclusive cleanup and fence expired holders", () => {
  const db = database(); let clock = 1000; const leases = new ResourceLeases(db, () => clock);
  try {
    const a = leases.acquire("artifact:one", "reader-a", "shared", 1000), b = leases.acquire("artifact:one", "reader-b", "shared", 1000);
    assert.throws(() => leases.acquire("artifact:one", "cleanup"), /다른 작업/); assert.deepEqual(leases.resources("artifact:"), ["artifact:one"]);
    clock += 1001; const newer = leases.acquire("artifact:one", "cleanup", "exclusive", 1000); a.release(); b.release(); assert.equal(leases.active("artifact:one"), true); assert.throws(a.assertCurrent, /만료/); newer.release(); assert.equal(leases.active("artifact:one"), false);
  } finally { db.close(); }
});
test("owner sessions survive service replacement while only hashed credentials are stored", () => {
  const db = database(); let clock = 1000;
  try { const session = new StudioSessions(db, () => clock).create(); assert.equal(new StudioSessions(db, () => clock).get(session.token)?.csrf, session.csrf); assert.notEqual(db.prepare("SELECT token_hash FROM studio_owner_sessions").get()?.token_hash, session.token); clock = session.expires; assert.equal(new StudioSessions(db, () => clock).get(session.token), null); }
  finally { db.close(); }
});
test("local binding and managed TLS configuration are explicit and validated", () => {
  assert.equal(studioConfig({}).mode, "local"); assert.throws(() => studioConfig({ APP_MODE: "local", STUDIO_HOST: "0.0.0.0" }), /loopback/); assert.throws(() => studioConfig({ APP_MODE: "managed", STUDIO_PUBLIC_ORIGIN: "http://example.test" }), /HTTPS/);
  assert.deepEqual(studioConfig({ APP_MODE: "managed", STUDIO_PUBLIC_ORIGIN: "https://studio.example.test", WORKER_CONCURRENCY: "4" }), { mode: "managed", host: "0.0.0.0", publicOrigin: "https://studio.example.test", concurrency: 4, workTimeoutMs: 180_000 });
});
