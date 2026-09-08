"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createService, sourceSnapshot, validateReview, parseCodexReview, routePlan, acpxMessage, errorClass, processRun, validateChecks, testEvidencePassed, cleanEnv } = require("./app-builder-review");
const PASS = { verdict: "APPROVE", acceptance: "PASS", summary: "All acceptance criteria verified.", findings: [] };
const HOLD = { verdict: "HOLD", acceptance: "FAIL", summary: "Wrong result.", findings: [{ severity: "IMPORTANT", location: "app.js:1", evidence: "add(1, 1) returns 3", correction: "Return a + b" }] };
const success = (review = PASS) => ({ outcome: "reviewed", exit_code: 0, duration_ms: 100, review });
function fixture(t, settings = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "app-builder-review-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const project = path.join(temp, "project"), root = path.join(temp, "host");
  fs.mkdirSync(path.join(project, ".app-builder"), { recursive: true });
  fs.writeFileSync(path.join(project, ".app-builder", "run-state.md"), "Status: REVIEW\nCurrent slice: S1\nOrchestrator model: anthropic/claude-opus-4-8\nVerification mode: STANDARD\n");
  fs.writeFileSync(path.join(project, "app.js"), "module.exports = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(project, "APP_SPEC.md"), "Add two numbers without mutation.\n");
  fs.writeFileSync(path.join(project, "app.test.js"), "const t = require('node:test'), a = require('node:assert/strict'); t('addition', () => a.equal(require('./app')(1, 1), 2));\n");
  let clock = Date.now();
  const calls = [], delays = [];
  const service = createService({ root, now: () => clock, delay: async (ms) => { delays.push(ms); clock += ms; },
    invokeRoute: async (route, ...rest) => { calls.push(route); return settings.review ? settings.review(route, ...rest) : success(); }, ...settings.options });
  return { project, root, service, calls, delays, advance: (ms) => { clock += ms; },
    change: (content = "module.exports = (a, b) => a + b; // revised\n") => fs.writeFileSync(path.join(project, "app.js"), content),
    stateText: () => fs.readFileSync(path.join(project, ".app-builder", "run-state.md"), "utf8") };
}
test("real tests + separate Codex result authorize final DONE, unchanged metadata does not stale approval", async (t) => {
  const f = fixture(t);
  f.service.request(f.project, { final: true });
  const info = await f.service.run(f.project);
  assert.equal(info.approved, true); assert.deepEqual(f.calls, ["codex"]);
  f.service.complete(f.project); assert.match(f.stateText(), /^Status: DONE/m);
  assert.equal(f.service.inspect(f.project).approved, true);
});
test("GPT fallback structurally skips Codex, Fable really runs before weak fallback", async (t) => {
  const f = fixture(t, { review: (route) => route === "fable" ? { outcome: "unavailable", exit_code: 1, error: "offline" } : success() });
  f.service.request(f.project, { backend: "openai/gpt-5.6-sol" });
  const info = await f.service.run(f.project);
  assert.equal(info.approved, true); assert.equal(info.route, "same-family");
  assert.deepEqual(f.calls, ["fable", "same-family"]);
  assert.equal(JSON.parse(fs.readFileSync(info.review_file)).weaker, true);
});
test("structural decline falls directly to Fable without retry", async (t) => {
  const f = fixture(t, { review: (route) => route === "codex" ? { outcome: "unavailable", error: "nested-codex-declined" } : success() });
  f.service.request(f.project); await f.service.run(f.project);
  assert.deepEqual(f.calls, ["codex", "fable"]); assert.equal(f.delays.length, 0);
});
test("401 retries exactly once after 30 seconds, then falls back", async (t) => {
  const f = fixture(t, { review: (route) => route === "codex" ? { outcome: "unavailable", error: "auth-401" } : success() });
  f.service.request(f.project); await f.service.run(f.project);
  assert.deepEqual(f.calls, ["codex", "codex", "fable"]); assert.deepEqual(f.delays, [30000]);
});
test("a real HOLD cannot be erased by falling back to another reviewer", async (t) => {
  const f = fixture(t, { review: () => success(HOLD) });
  f.service.request(f.project, { backend: "gpt-5.6-sol" });
  const info = await f.service.run(f.project);
  assert.deepEqual(f.calls, ["fable"]); assert.equal(info.status, "changes_requested"); assert.equal(info.allow_continue, true);
  assert.throws(() => f.service.complete(f.project), /DONE refused/);
  assert.match(f.stateText(), /^Status: REPAIRING/m);
  assert.match(fs.readFileSync(path.join(f.project, ".app-builder", "continue-request.json"), "utf8"), /repair findings only/);
});
test("DEEP adds Fable after Codex and never skips it after Codex PASS", async (t) => {
  const f = fixture(t, { review: (route) => route === "codex" ? success() : { outcome: "unavailable", error: "offline" } });
  f.service.request(f.project, { mode: "DEEP" });
  assert.equal((await f.service.run(f.project)).approved, false);
  assert.deepEqual(f.calls, ["codex", "fable"]);
});
test("all routes unavailable -> needs-attention, two bounded hourly retries", async (t) => {
  const f = fixture(t, { review: () => ({ outcome: "unavailable", error: "offline" }) });
  f.service.request(f.project); await f.service.run(f.project);
  assert.equal(f.service.inspect(f.project).status, "needs_attention");
  const first = f.service.load(f.project).request_id;
  assert.equal(f.service.request(f.project).request_id, first);
  for (let i = 0; i < 2; i++) { f.advance(3600001); assert.equal(f.service.inspect(f.project).retry_due, true); f.service.request(f.project); await f.service.run(f.project); }
  f.advance(3600001); assert.equal(f.service.inspect(f.project).retry_due, false);
  assert.equal(f.calls.length, 9); assert.equal(f.service.load(f.project).provider_retries, 2);
});
test("failed real test returns to repair without spending a model review call", async (t) => {
  const f = fixture(t); f.change("module.exports = () => 3;\n"); f.service.request(f.project);
  const info = await f.service.run(f.project);
  assert.equal(info.status, "changes_requested"); assert.equal(f.calls.length, 0);
  f.change(); f.service.request(f.project); assert.equal((await f.service.run(f.project)).approved, true);
});
test("repair counters persist across new source hashes and stop at three repairs per slice", async (t) => {
  const f = fixture(t, { review: () => success(HOLD) });
  for (let i = 0; i < 4; i++) { f.change(`module.exports = (a,b) => a+b; // ${i}\n`); f.service.request(f.project); await f.service.run(f.project); }
  const state = f.service.load(f.project); assert.equal(state.status, "needs_attention"); assert.equal(state.repairs_total, 3); assert.equal(state.retry_after, undefined);
  assert.match(state.reason, /budget exhausted/);
});
test("approval is invalid after source change, model PASS text cannot repair it", async (t) => {
  const f = fixture(t); f.service.request(f.project, { final: true }); await f.service.run(f.project); f.change();
  fs.writeFileSync(path.join(f.project, ".app-builder", "run-state.md"), "Status: DONE\nCodex review: APPROVE (0/0/0)\n");
  assert.equal(f.service.inspect(f.project).approved, false); assert.throws(() => f.service.complete(f.project), /DONE refused/);
});
test("source mutation during review makes its result stale", async (t) => {
  let f; f = fixture(t, { review: () => { f.change(); return success(); } });
  f.service.request(f.project); assert.equal((await f.service.run(f.project)).approved, false);
});
test("tampered signature, check contract, and request identity cannot approve", async (t) => {
  const f = fixture(t); f.service.request(f.project); await f.service.run(f.project);
  const file = path.join(f.service.location(f.project), "approval.json"), original = fs.readFileSync(file, "utf8");
  const receipt = JSON.parse(original); receipt.payload.request_id = "forged"; fs.writeFileSync(file, JSON.stringify(receipt)); assert.equal(f.service.inspect(f.project).approved, false);
  fs.writeFileSync(file, original);
  const contractFile = path.join(f.service.location(f.project), "checks.json"), contract = JSON.parse(fs.readFileSync(contractFile));
  contract.checks = [{ type: "node-script", path: "app.js" }]; fs.writeFileSync(contractFile, JSON.stringify(contract)); assert.equal(f.service.inspect(f.project).approved, false);
});
test("final completion requires a final request with freshly executed checks/review", async (t) => {
  const f = fixture(t); f.service.request(f.project); await f.service.run(f.project);
  assert.throws(() => f.service.complete(f.project), /not final/);
  f.service.request(f.project, { final: true }); await f.service.run(f.project); f.service.complete(f.project); assert.equal(f.calls.length, 2);
});
test("dead runner lock is recovered, a live process lock is respected", async (t) => {
  const f = fixture(t); f.service.request(f.project);
  fs.writeFileSync(path.join(f.root, "runner.lock"), JSON.stringify({ pid: process.pid }));
  assert.equal((await f.service.run(f.project)).status, "queued"); assert.equal(f.calls.length, 0);
  fs.writeFileSync(path.join(f.root, "runner.lock"), JSON.stringify({ pid: 2147483647 }));
  assert.equal((await f.service.run(f.project)).approved, true);
});
test("partial/empty lock after crash recovers, a fresh mid-write lock waits", async (t) => {
  const f = fixture(t); f.service.request(f.project);
  const lock = path.join(f.root, "runner.lock"); fs.writeFileSync(lock, '{"pid":');
  assert.equal((await f.service.run(f.project)).status, "queued");
  fs.utimesSync(lock, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  assert.equal((await f.service.run(f.project)).approved, true);
  assert.ok(fs.readdirSync(f.root).some((name) => name.startsWith("runner.lock.abandoned-")));
});
test("a reused Windows PID cannot keep an old lock or running request alive", async (t) => {
  const f = fixture(t, { options: { processIdentity: () => "new-process-start" } });
  f.service.request(f.project);
  fs.writeFileSync(path.join(f.root, "runner.lock"), JSON.stringify({ pid: process.pid, process_identity: "old-process-start", started_at: Date.now() }));
  assert.equal(f.service.runnerBusy(), false);
  assert.equal((await f.service.run(f.project)).approved, true);
});
test("legacy live-PID lock expires after the bounded runner deadline", async (t) => {
  const f = fixture(t); f.service.request(f.project);
  fs.writeFileSync(path.join(f.root, "runner.lock"), JSON.stringify({ pid: process.pid, started_at: Date.now() - 37 * 60000 }));
  assert.equal(f.service.runnerBusy(), false);
  assert.equal((await f.service.run(f.project)).approved, true);
});
test("OS mutex serializes processes and is released automatically when its owner dies", async (t) => {
  const f = fixture(t); f.service.request(f.project);
  const child = spawn(process.execPath, ["-e", "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(process.argv[1]); d.exec('BEGIN EXCLUSIVE'); console.log('ready'); setInterval(()=>{},1000);", path.join(f.root, "runner.sqlite")], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
    assert.equal(f.service.runnerBusy(), true);
    assert.equal((await f.service.run(f.project)).status, "queued");
  } finally { child.kill(); await closed; }
  assert.equal(f.service.runnerBusy(), false);
  assert.equal((await f.service.run(f.project)).approved, true);
});
test("native Codex P1 comments become actionable HOLD, never provider failure", () => {
  const review = parseCodexReview("Review comment:\n\n- [P1] Recover malformed runner lock files — C:\\project\\runner.js:425-429\n  A partial JSON lock blocks all subsequent runs.\n\n- [P2] Preserve repair context — src/repair.js:20\n  Resuming a different source loses changes.\n");
  assert.equal(review.verdict, "HOLD"); assert.equal(review.findings.length, 2);
  assert.equal(review.findings[0].severity, "BLOCKER"); assert.match(review.findings[0].location, /runner.js:425-429/);
});
test("unreadable completed review cannot fall through to weaker approval", async (t) => {
  const f = fixture(t, { review: () => ({ outcome: "invalid", error: "Malformed final output" }) });
  f.service.request(f.project); const result = await f.service.run(f.project);
  assert.equal(result.approved, false); assert.deepEqual(f.calls, ["codex"]);
});
test("zero/all-skipped tests or a success banner alone do not pass checks", () => {
  const result = { exit_code: 0, timed_out: false, stdout: "success", stderr: "" };
  assert.equal(testEvidencePassed({ type: "npm", test: true }, result), false);
  assert.equal(testEvidencePassed({ type: "node-test" }, { ...result, stdout: "# tests 1\n# pass 0\n# fail 0\n# skipped 1\n# cancelled 0" }), false);
});
test("unchanged request is idempotent; unsupported/build-only contracts fail closed", (t) => {
  const f = fixture(t); const request = f.service.request(f.project); assert.equal(f.service.request(f.project).request_id, request.request_id);
  assert.throws(() => validateChecks([{ type: "shell", command: "echo ok" }]));
  assert.throws(() => validateChecks([{ type: "npm", script: "build", test: false }]));
  assert.throws(() => validateChecks([{ type: "node-test", paths: ["../outside.test.js"] }]));
});
test("source snapshot excludes host state but rejects secrets and external links", (t) => {
  const f = fixture(t); const before = sourceSnapshot(f.project).source_hash;
  fs.writeFileSync(path.join(f.project, ".app-builder", "log.md"), "log-only"); assert.equal(sourceSnapshot(f.project).source_hash, before);
  fs.writeFileSync(path.join(f.project, ".env"), "secret"); assert.throws(() => sourceSnapshot(f.project), /Private runtime file/);
});
test("explicit audited legacy baseline expires on state or source change", (t) => {
  const f = fixture(t);
  assert.equal(f.service.legacyReviewed(f.project), false);
  f.service.recordLegacy(f.project, "Audited historical reviewer report, maintenance migration only");
  assert.equal(f.service.legacyReviewed(f.project), true);
  fs.appendFileSync(path.join(f.project, ".app-builder", "run-state.md"), "New slice: S2\n");
  assert.equal(f.service.legacyReviewed(f.project), false);
  assert.equal(f.service.inspect(f.project).approved, false);
});
test("only visible ACP messages enter result parser; contradictory approval is rejected", () => {
  const lines = [ { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "HIDDEN" } } },
    { params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(PASS) } } } } ];
  assert.equal(acpxMessage(lines.map(JSON.stringify).join("\n")), JSON.stringify(PASS));
  assert.throws(() => validateReview({ ...HOLD, verdict: "APPROVE" }));
  assert.equal(errorClass({ stdout: '{"status":"declined"}', stderr: "", timed_out: false }), "nested-codex-declined");
  assert.deepEqual(routePlan("openai-codex/gpt-5.6-sol", "DEEP", "claude"), ["fable", "same-family"]);
});
test("process timeout stops its owned child and returns finite evidence", async () => {
  const result = await processRun(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 150 });
  assert.equal(result.timed_out, true); assert.equal(result.exit_code, null); assert.ok(result.duration_ms < 10000);
});
