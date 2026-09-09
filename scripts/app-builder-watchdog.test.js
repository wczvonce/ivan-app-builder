// Testy detekcie pre app-builder-watchdog.js (watchdog + continuator).
// Spúšťa watchdog v --dry-run/--status (a pri continuatore aj naostro) proti syntetickým
// dátam v temp adresári (env WATCHDOG_* prepíše cesty), takže produkčný stav, gateway,
// OpenClaw CLI ani Telegram sa nedotknú: CLI nahrádza STAVOVÝ fake skript (cron add zapíše job
// do cron-list.json, rm ho zmaže), Telegram súborový sink, SQLite gateway = throwaway DB.
//
// Použitie: node app-builder-watchdog.test.js   (WATCHDOG_TEST_KEEP_TMP=1 ponechá temp)

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const WATCHDOG = path.join(__dirname, "app-builder-watchdog.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-test-"));
const FAKE_CLI = path.join(TMP, "fake-openclaw-cli.js");

// Falošné OpenClaw CLI (stavové): zapíše argv do <root>/cli-calls.jsonl; `cron add` upsertne job
// podľa declaration-key do <root>/cron-list.json (nový: enabled:true + nextRunAtMs; existujúci:
// aktualizuje payload, enabled NECHÁ — presne ako gateway) a vypíše {created, updated, job};
// `cron rm` job zmaže (FAKE_CLI_FAIL_RM=1 → exit 1); `cron list --all --json` vypíše register.
// FAKE_CLI_PREFIX vypíše riadok pred JSON (CLI to občas robí). FAKE_CLI_FAIL=1 → všetko zlyhá.
fs.writeFileSync(
  FAKE_CLI,
  `
const fs = require("fs"); const path = require("path");
const root = process.env.FAKE_CLI_ROOT; const argv = process.argv.slice(2);
fs.appendFileSync(path.join(root, "cli-calls.jsonl"), JSON.stringify(argv) + "\\n");
if (process.env.FAKE_CLI_FAIL === "1") { process.stderr.write("gateway unreachable"); process.exit(1); }
const f = path.join(root, "cron-list.json");
const load = () => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return { jobs: [] }; } };
const save = (d) => fs.writeFileSync(f, JSON.stringify(d));
const out = (o) => { if (process.env.FAKE_CLI_PREFIX) console.log(process.env.FAKE_CLI_PREFIX); console.log(JSON.stringify(o)); };
if (argv[0] === "cron" && argv[1] === "add") {
  const n = fs.readFileSync(path.join(root, "cli-calls.jsonl"), "utf8").split("\\n").filter((l) => l.includes('"add"')).length;
  const key = argv[argv.indexOf("--declaration-key") + 1];
  const d = load(); const existing = d.jobs.find((j) => j.declarationKey === key);
  const payload = { kind: "agentTurn", message: argv[argv.indexOf("--message") + 1] };
  if (existing) { existing.payload = payload; existing.state = existing.state || {}; save(d); out({ created: false, updated: true, job: existing }); }
  else { const job = { id: "job-" + n, name: argv[argv.indexOf("--name") + 1], declarationKey: key, enabled: true, status: "idle", sessionTarget: argv[argv.indexOf("--session") + 1], schedule: { kind: "at" }, payload, state: { nextRunAtMs: Date.now() + 5000 } }; d.jobs.push(job); save(d); out({ created: true, job }); }
} else if (argv[0] === "cron" && argv[1] === "list") {
  out(load());
} else if (argv[0] === "cron" && argv[1] === "rm") {
  if (process.env.FAKE_CLI_FAIL_RM === "1") { process.stderr.write("rm failed"); process.exit(1); }
  const d = load(); d.jobs = d.jobs.filter((j) => j.id !== argv[2]); save(d); out({ ok: true, removed: true });
} else { out({}); }
`
);

let pass = 0;
let fail = 0;

function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? "\n        " + String(extra).slice(0, 700) : ""}`);
  }
}

function fresh(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  return dir;
}

function projectDir(root, project) {
  return path.join(root, "projects", project);
}

function backdate(file, ageMinutes) {
  const when = new Date(Date.now() - ageMinutes * 60_000);
  fs.utimesSync(file, when, when);
}

function writeRunState(root, project, body, ageMinutes) {
  const dir = path.join(root, "projects", project, ".app-builder");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "run-state.md");
  fs.writeFileSync(file, body);
  backdate(file, ageMinutes);
}

function writeSfRunState(root, project, obj, ageMinutes) {
  const dir = path.join(root, "projects", project, ".solution-factory");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "run-state.json");
  fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  backdate(file, ageMinutes);
}

function writeAb(root, project, name, content) {
  const dir = path.join(root, "projects", project, ".app-builder");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

function writeSessions(root, entries) {
  fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify(entries, null, 2));
}

function writeJobs(root, jobs) {
  fs.writeFileSync(path.join(root, "cron-list.json"), JSON.stringify({ jobs, total: jobs.length, hasMore: false }));
}

function readJobs(root) {
  const f = path.join(root, "cron-list.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).jobs : [];
}

// Simuluje koniec jobu na gateway: "ok" = jednorazový job sa po úspechu zmaže; "error" = ostane vypnutý.
function finishJob(root, id, status, lastError) {
  const jobs = readJobs(root);
  if (status === "ok") writeJobs(root, jobs.filter((j) => j.id !== id));
  else writeJobs(root, jobs.map((j) => (j.id === id ? Object.assign(j, { enabled: false, status: "disabled", state: { lastRunStatus: "error", lastError: lastError || "chyba" } }) : j)));
}

function writeState(root, obj) {
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(obj, null, 2));
}

function readState(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
}

function cliCalls(root) {
  const f = path.join(root, "cli-calls.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function cronAdds(root) {
  return cliCalls(root).filter((a) => a[0] === "cron" && a[1] === "add");
}

function sink(root) {
  const f = path.join(root, "telegram.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).text);
}

function wdLog(root) {
  const f = path.join(root, "watchdog.log");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
}

function abFiles(root, project) {
  const dir = path.join(projectDir(root, project), ".app-builder");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function historyFiles(root, project) {
  const dir = path.join(projectDir(root, project), ".app-builder", "history");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

// Minimálny git repo bez spúšťania gitu: .git/HEAD + ref.
function writeGitHead(root, project, sha) {
  const git = path.join(projectDir(root, project), ".git");
  fs.mkdirSync(path.join(git, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(git, "refs", "heads", "main"), sha + "\n");
}

// Throwaway SQLite "gateway DB" s audit_events/task_runs.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_) {}
function writeDb(root, rows, runningTasks) {
  if (!DatabaseSync) return false;
  const file = path.join(root, "openclaw.sqlite");
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const db = new DatabaseSync(file);
  // Stĺpce zodpovedajú produkčnej gateway DB (vrátane tool_name — bez neho by dotazy
  // filtrujúce podľa nástroja v testoch ticho padli a kontrola by sa nikdy nespustila).
  db.exec("CREATE TABLE audit_events (sequence INTEGER PRIMARY KEY, occurred_at INTEGER, kind TEXT, action TEXT, status TEXT, session_key TEXT, run_id TEXT, tool_name TEXT)");
  db.exec("CREATE TABLE task_runs (task_id TEXT, agent_id TEXT, owner_key TEXT, child_session_key TEXT, status TEXT)");
  const ins = db.prepare("INSERT INTO audit_events (occurred_at, kind, action, status, session_key, run_id, tool_name) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) ins.run(Date.now() - r.minAgo * 60_000, r.kind, r.action, r.status, r.key || "agent:app-builder:main", "r1", r.tool || null);
  const it = db.prepare("INSERT INTO task_runs VALUES (?, ?, ?, ?, ?)");
  for (const t of runningTasks || []) it.run("t1", "app-builder", "agent:app-builder:main", null, t);
  db.close();
  return true;
}
const IDLE_DB = [{ minAgo: 40, kind: "agent_run", action: "agent.run.finished", status: "succeeded" }];

// Log line v tvare, aký produkuje OpenClaw (subsystem model-fallback/decision).
function fallbackLine(decision, extra, minutesAgo) {
  const iso = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return JSON.stringify({
    0: '{"subsystem":"model-fallback/decision"}',
    1: Object.assign({ event: "model_fallback_decision", decision }, extra),
    2: "model fallback decision",
    time: iso,
    _meta: { date: iso },
  });
}

// Bežný dokončený turn CLI backendu — reťazcový message, nie štruktúrovaná udalosť.
function turnLine(minutesAgo, failed = false) {
  const iso = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return JSON.stringify({
    0: '{"subsystem":"agent/cli-backend"}',
    1: failed
      ? "claude live session turn failed: provider=claude-cli model=claude-sonnet-5 durationMs=600011 error=FailoverError"
      : "claude live session turn: provider=claude-cli model=claude-sonnet-5 durationMs=68443 rawLines=92 outBytes=279",
    time: iso,
    _meta: { date: iso },
  });
}

function writeLog(root, lines, dayOffset = 0) {
  const day = new Date(Date.now() - dayOffset * 86_400_000).toISOString().slice(0, 10);
  const file = path.join(root, "logs", `openclaw-${day}.log`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  if (dayOffset) backdate(file, dayOffset * 24 * 60);
}

// Spustí watchdog izolovane. `extra` prepíše env (napr. WATCHDOG_DISABLE_CONTINUE=1 pre
// pôvodnú alarm-sémantiku). Bez --dry-run posiela "Telegram" do súboru a "CLI" do fake skriptu.
function run(root, args, extra = {}) {
  const env = Object.assign(
    {},
    process.env,
    {
      WATCHDOG_TEST: "1", // bez neho sa testovacie háky (sink, skip gateway, now) ignorujú
      WATCHDOG_TEST_LEGACY_REVIEW: "1", // old gate fixtures; host gate has its own integration cases below
      WATCHDOG_PROJECT_ROOTS: path.join(root, "projects"),
      WATCHDOG_OPENCLAW_LOG_DIR: path.join(root, "logs"),
      WATCHDOG_STATE_FILE: path.join(root, "state.json"),
      WATCHDOG_LOG_FILE: path.join(root, "watchdog.log"),
      WATCHDOG_SKIP_GATEWAY: "1",
      WATCHDOG_CONFIG_FILE: path.join(root, "openclaw.json"), // neexistuje → nič z produkčného configu
      WATCHDOG_PAUSE_FILE: path.join(root, "global.PAUSE"),
      WATCHDOG_SESSIONS_FILE: path.join(root, "sessions.json"),
      WATCHDOG_SQLITE_FILE: path.join(root, "openclaw.sqlite"),
      WATCHDOG_OPENCLAW_CLI: FAKE_CLI,
      WATCHDOG_TELEGRAM_SINK: path.join(root, "telegram.jsonl"),
      WATCHDOG_BOT_TOKEN: "test-token",
      WATCHDOG_CHAT_ID: "1",
      FAKE_CLI_ROOT: root,
    },
    extra
  );
  return execFileSync(process.execPath, [WATCHDOG].concat(args), { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runStatus(root, extra = {}) {
  let out;
  try {
    out = run(root, ["--status"], extra);
  } catch (e) {
    return { error: String(e.stdout || "") + String(e.stderr || "") };
  }
  return JSON.parse(out);
}

const LEGACY = { WATCHDOG_DISABLE_CONTINUE: "1" }; // pôvodná sémantika: aktívny stall = alarm

const CHAIN_EXHAUSTED = {
  requestedProvider: "anthropic",
  requestedModel: "claude-opus-4-8",
  candidateProvider: "openai",
  candidateModel: "gpt-5.4",
  attempt: 3,
  total: 3,
  errorPreview: "You've hit your session limit · resets 10:10pm (Europe/Bratislava)",
};
const MID_CHAIN_FAIL = {
  requestedProvider: "anthropic",
  requestedModel: "claude-opus-4-8",
  candidateProvider: "anthropic",
  candidateModel: "claude-opus-4-8",
  attempt: 1,
  total: 3,
  nextCandidateProvider: "openai",
  nextCandidateModel: "gpt-5.5",
  errorPreview: "You've hit your session limit · resets 3:50pm (Europe/Bratislava)",
};
const SUCCEEDED = {
  requestedProvider: "anthropic",
  requestedModel: "claude-opus-4-8",
  candidateProvider: "openai",
  candidateModel: "gpt-5.5",
  attempt: 2,
  total: 3,
};

const ACTIVE = "# Run state\n- Status: IMPLEMENTING\n- Next action: slice 2\n";

console.log("\n1) Fallback zabral (Claude limit → GPT uspel) — žiadny alarm");
{
  const root = fresh("fallback-ok");
  writeLog(root, [fallbackLine("candidate_failed", MID_CHAIN_FAIL, 20), fallbackLine("candidate_succeeded", SUCCEEDED, 19)]);
  const status = runStatus(root);
  check("outage = false", status.outage.outage === false, JSON.stringify(status.outage));
  const out = run(root, ["--dry-run"]);
  check("nič by neposlal", !out.includes("poslal by som"), out);
}

console.log("\n2) Celý reťazec vyčerpaný — alarm o výpadku modelov");
{
  const root = fresh("chain-dead");
  writeLog(root, [
    fallbackLine("candidate_succeeded", SUCCEEDED, 90),
    fallbackLine("candidate_failed", MID_CHAIN_FAIL, 12),
    fallbackLine("candidate_failed", CHAIN_EXHAUSTED, 11),
  ]);
  const status = runStatus(root);
  check("outage = true", status.outage.outage === true, JSON.stringify(status.outage));
  const out = run(root, ["--dry-run"]);
  check("poslal by alarm", out.includes("poslal by som model-outage"), out);
  check("obsahuje čas resetu", out.includes("10:10pm"), out);
}

console.log("\n3) Reťazec ožil po výpadku — správa o zotavení, keď bol alarm v stave");
{
  const root = fresh("recovered");
  writeLog(root, [fallbackLine("candidate_failed", CHAIN_EXHAUSTED, 60), fallbackLine("candidate_succeeded", SUCCEEDED, 5)]);
  writeState(root, { alerts: { "model-outage": { fingerprint: "x", sentAt: Date.now() - 3_600_000 } } });
  const out = run(root, ["--dry-run"]);
  check("poslal by zotavenie", out.includes("poslal by som model-recovered"), out);
}

console.log("\n3b) Polnoc: nový prázdny log NIE JE zotavenie — výpadok si pamätá stav a starší log");
{
  const root = fresh("midnight");
  writeLog(root, [fallbackLine("candidate_failed", CHAIN_EXHAUSTED, 30)], 1); // včerajší log s výpadkom
  writeLog(root, ['{"0":"{\\"subsystem\\":\\"gateway\\"}","1":"loading configuration…"}']); // dnešný bez rozhodnutí
  writeState(root, { alerts: { "model-outage": { fingerprint: "x", sentAt: Date.now() - 3_600_000 } }, modelOutage: { lastExhaustedAt: Date.now() - 30 * 60_000, lastSuccessAt: 0 } });
  const status = runStatus(root);
  check("outage stále true (dva logy + pamäť)", status.outage.outage === true, JSON.stringify(status.outage));
  const out = run(root, ["--dry-run"]);
  check("žiadne falošné ✅", !out.includes("model-recovered"), out);
  const root2 = fresh("midnight-memory-only");
  writeLog(root2, ['{"0":"x","1":"nič"}']);
  writeState(root2, { alerts: { "model-outage": { fingerprint: "x", sentAt: Date.now() - 3_600_000 } }, modelOutage: { lastExhaustedAt: Date.now() - 30 * 60_000, lastSuccessAt: 0 } });
  check("iba pamäť stavu: outage true", runStatus(root2).outage.outage === true, "");
  writeLog(root2, [turnLine(2)]);
  check("úspešný turn v novom logu = zotavenie", runStatus(root2).outage.outage === false, "");
}

console.log("\n4) Zaseknutý beh (Status: IMPLEMENTING, 60 min bez zmeny)");
{
  const root = fresh("stalled");
  writeRunState(root, "appka-test", "# Run state\n- Status: IMPLEMENTING\n- Next action: dokončiť slice 2\n", 60);
  const legacy = run(root, ["--dry-run"], LEGACY);
  check("bez continuatora: alarm", legacy.includes("poslal by som stalled:appka-test"), legacy);
  check("bez continuatora: uvádza continue príkaz", legacy.includes("continue "), legacy);
  const out = run(root, ["--dry-run"]);
  check("s continuatorom: spustil by continue", out.includes("spustil by som continue appka-test"), out);
  check("s continuatorom: žiadny 🛑 alarm", !out.includes("poslal by som stalled:appka-test"), out);
}

console.log("\n5) Beh v poriadku alebo uzavretý — žiadny alarm ani continue");
{
  const root = fresh("quiet");
  writeRunState(root, "svieza", "# Run state\n- Status: IMPLEMENTING\n- Next action: slice 1\n", 10);
  writeRunState(root, "hotova", "# Run state\n- Status: DONE\n- Next action: none\n", 600);
  writeRunState(root, "stary-format-hotovy", "# run-state\n- discovery status: CONFIRMED\n- repair rounds (slice): 0\n", 900);
  writeLog(root, [fallbackLine("candidate_succeeded", SUCCEEDED, 5)]);
  const out = run(root, ["--dry-run"]);
  check("svieži beh nehlási", !out.includes("stalled:svieza") && !out.includes("continue svieza"), out);
  check("hotový beh nehlási", !out.includes("stalled:hotova") && !out.includes("continue hotova"), out);
  check("starý formát bez next action nehlási", !out.includes("stalled:stary-format-hotovy"), out);
}

console.log("\n6) Starý aktívny beh: 26 h = ešte oživujeme, 80 h = opustený");
{
  const root = fresh("abandoned");
  writeRunState(root, "davno-opusteny", "# Run state\n- Status: REVIEW\n- Next action: dokončiť review\n", 26 * 60);
  const legacy = run(root, ["--dry-run"], LEGACY);
  check("bez continuatora 26 h nehlási (12 h hranica)", !legacy.includes("stalled:davno-opusteny"), legacy);
  const out = run(root, ["--dry-run"]);
  check("s continuatorom 26 h ešte oživuje", out.includes("spustil by som continue davno-opusteny"), out);
  writeRunState(root, "davno-opusteny", "# Run state\n- Status: REVIEW\n- Next action: dokončiť review\n", 80 * 60);
  const out2 = run(root, ["--dry-run"]);
  check("80 h: neoživuje", !out2.includes("spustil by som continue davno-opusteny"), out2);
  check("80 h: jeden alarm o opustení", out2.includes("poslal by som abandoned:davno-opusteny"), out2);
}

console.log("\n7) Čakanie na Ivanovo rozhodnutie — miernejší limit (90 min), nikdy auto-continue");
{
  const root = fresh("waiting");
  writeRunState(root, "caka-60", "# Run state\n- Status: BLOCKED (limit)\n- Next action: čakám\n", 60);
  writeRunState(root, "caka-120", "# Run state\n- Status: BLOCKED (limit)\n- Next action: čakám\n", 120);
  const out = run(root, ["--dry-run"]);
  check("po 60 min ešte nehlási", !out.includes("stalled:caka-60"), out);
  check("po 120 min hlási", out.includes("poslal by som stalled:caka-120"), out);
  check("text je o čakaní na rozhodnutie", out.includes("čaká na tvoje rozhodnutie"), out);
  check("BLOCKED sa nikdy nespúšťa automaticky", !out.includes("spustil by som continue"), out);
}

console.log("\n8) Rovnaký stav sa nehlási dvakrát, po zmene stavu áno (alarm sémantika)");
{
  const root = fresh("dedup");
  writeRunState(root, "appka", ACTIVE, 60);
  const mtimeMs = fs.statSync(path.join(root, "projects", "appka", ".app-builder", "run-state.md")).mtimeMs;
  const alreadySent = (fingerprint) => writeState(root, { alerts: { "stalled:appka": { fingerprint, sentAt: Date.now() - 300_000 } } });
  alreadySent(`IMPLEMENTING@${Math.floor(mtimeMs / 1000)}`);
  const same = run(root, ["--dry-run"], LEGACY);
  check("nezmenený stav preskočí", same.includes("rovnaký stav už ohlásený"), same);
  alreadySent("REVIEW@1700000000");
  const cooled = run(root, ["--dry-run"], LEGACY);
  check("zmenený stav v cooldowne preskočí", cooled.includes("cooldown po predošlom alerte"), cooled);
  writeState(root, { alerts: { "stalled:appka": { fingerprint: "REVIEW@1700000000", sentAt: Date.now() - 7_200_000 } } });
  const after = run(root, ["--dry-run"], LEGACY);
  check("po cooldowne a zmene stavu hlási", after.includes("poslal by som stalled:appka"), after);
}

console.log("\n9) Odolnosť: chýbajúce cesty, poškodený alebo nečitateľný log nezhodia watchdog");
{
  const root = fresh("robust");
  fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });
  writeLog(root, ["toto nie je json", '{"1":{"event":"model_fallback_decision"}}', ""]);
  let ok = true;
  let out = "";
  try {
    out = run(root, ["--dry-run"]);
  } catch (e) {
    ok = false;
    out = String(e.stdout || "") + String(e.stderr || "");
  }
  check("nespadol", ok, out);
  check("ohlásil ok stav", out.includes("ok — runs=0"), out);
  const root2 = fresh("robust-logdir");
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(root2, "logs", `openclaw-${day}.log`)); // "log" je adresár → open zlyhá
  writeRunState(root2, "appka", ACTIVE, 30);
  let ok2 = true;
  let out2 = "";
  try {
    out2 = run(root2, ["--dry-run"]);
  } catch (e) {
    ok2 = false;
    out2 = String(e.stdout || "") + String(e.stderr || "");
  }
  check("nečitateľný log: nespadol a cyklus pokračuje (continue)", ok2 && out2.includes("spustil by som continue appka"), out2);
}

console.log("\n10) Solution Factory zaseknutý beh (EXECUTING bez buildera, 60 min)");
{
  const root = fresh("sf-stalled");
  writeSfRunState(root, "novy-system", { schema: "solution-factory.run-state.v1", status: "EXECUTING", next_action: "čakám na worker" }, 60);
  const legacy = run(root, ["--dry-run"], LEGACY);
  check("bez continuatora: alarm stalled:sf:", legacy.includes("poslal by som stalled:sf:novy-system"), legacy);
  check("text hovorí Solution Factory", legacy.includes("Solution Factory sa nehýbe"), legacy);
  const out = run(root, ["--dry-run"]);
  check("s continuatorom: spustil by continue", out.includes("spustil by som continue novy-system"), out);
}

console.log("\n11) SF stavy s loptičkou u Ivana / provider — správne ticho a správny limit");
{
  const root = fresh("sf-quiet");
  writeSfRunState(root, "caka-ivan", { status: "WAITING_USER", next_action: "Ivan odpovie" }, 300);
  writeSfRunState(root, "na-akceptacii", { status: "READY_FOR_UAT", next_action: "Ivan otestuje" }, 300);
  writeSfRunState(root, "schvalovanie", { status: "AWAITING_APPROVAL" }, 300);
  writeSfRunState(root, "hotovy", { status: "DONE", next_action: "none" }, 600);
  writeSfRunState(root, "provider-60", { status: "WAITING_PROVIDER", next_action: "reset o 22:00" }, 60);
  writeSfRunState(root, "provider-120", { status: "WAITING_PROVIDER", next_action: "reset o 22:00" }, 120);
  const out = run(root, ["--dry-run"]);
  check("WAITING_USER nehlási ani po 5 h", !out.includes("stalled:sf:caka-ivan"), out);
  check("READY_FOR_UAT nehlási", !out.includes("stalled:sf:na-akceptacii"), out);
  check("AWAITING_APPROVAL nehlási", !out.includes("stalled:sf:schvalovanie"), out);
  check("DONE nehlási", !out.includes("stalled:sf:hotovy"), out);
  check("WAITING_PROVIDER po 60 min ešte nehlási", !out.includes("stalled:sf:provider-60"), out);
  check("WAITING_PROVIDER po 120 min hlási", out.includes("poslal by som stalled:sf:provider-120"), out);
  check("žiadny user-court/waiting stav sa nespúšťa", !out.includes("spustil by som continue"), out);
}

console.log("\n11b) Poistka proti stratenej správe: 6 h v stave čakám-na-Ivana = JEDNA pripomienka");
{
  const root = fresh("sf-usercourt-timeout");
  writeSfRunState(root, "ticho-5h", { status: "WAITING_USER", next_action: "Ivan vyberie navrh" }, 300);
  writeSfRunState(root, "strateny-7h", { status: "WAITING_USER", next_action: "Ivan vyberie navrh" }, 420);
  writeSfRunState(root, "schvalenie-7h", { status: "AWAITING_APPROVAL" }, 420);
  writeSfRunState(root, "uat-7h", { status: "READY_FOR_UAT" }, 420);
  writeSfRunState(root, "opusteny-13h", { status: "WAITING_USER" }, 13 * 60);
  const out = run(root, ["--dry-run"]);
  check("po 5 h stále ticho", !out.includes("stalled:sf:ticho-5h"), out);
  check("po 7 h WAITING_USER hlási", out.includes("poslal by som stalled:sf:strateny-7h"), out);
  check("po 7 h AWAITING_APPROVAL hlási", out.includes("poslal by som stalled:sf:schvalenie-7h"), out);
  check("po 7 h READY_FOR_UAT hlási", out.includes("poslal by som stalled:sf:uat-7h"), out);
  check("opustený beh (13 h) nehlási", !out.includes("stalled:sf:opusteny-13h"), out);
  check("text upozorňuje na možné nedoručenie", out.includes("sa nedoru"), out);
  check("hlavička je otázka, nie sa-nehýbe", out.includes("na tvoju odpove"), out);
}

console.log("\n11c) Nezávislé overenie doručenia: WAITING_USER bez reálneho Telegram sendu hlási takmer hneď");
{
  const root = fresh("usercourt-unverified");
  // Bez sqlite db vôbec (DatabaseSync buď chýba, alebo súbor neexistuje) → telegramDeliveryVerifiedSince
  // vráti null, teda "neviem" → NEMÁ vyvolať falošný skorý alarm, drží sa pôvodných 6 h.
  writeRunState(root, "bez-db", "# Run state\n- Status: WAITING_USER\n- Next action: cakam\n", 15);
  const outNoDb = run(root, ["--dry-run"]);
  check("bez sqlite db (neznámy stav): žiadny skorý alarm", !outNoDb.includes("stalled:bez-db"), outNoDb);

  if (DatabaseSync) {
    // Príliš čerstvé (< 10 min): aj bez overeného sendu treba dať šancu, že správa práve odchádza.
    writeDb(root, [], null);
    writeRunState(root, "cerstvy", "# Run state\n- Status: WAITING_USER\n- Next action: cakam\n", 5);
    const outFresh = run(root, ["--dry-run"]);
    check("5 min staré a neoverené: ešte ticho", !outFresh.includes("stalled:cerstvy"), outFresh);

    // Žiadny reálny telegram:direct send v DB, run-state 15 min starý → alarm takmer hneď (nie po 6 h).
    writeRunState(root, "neoverene", "# Run state\n- Status: WAITING_USER\n- Next action: cakam\n", 15);
    const outUnverified = run(root, ["--dry-run"]);
    check("15 min a žiadny reálny send: alarmuje aj pred 6 h", outUnverified.includes("poslal by som stalled:neoverene"), outUnverified);
    check("text hovorí, že sa nenašiel reálny Telegram send", outUnverified.includes("NENAŠIEL"), outUnverified);

    // Reálny úspešný send na telegram:direct krátko pred zápisom run-state → zostáva ticho do 6 h.
    writeDb(root, [{ minAgo: 17, kind: "tool_action", action: "tool.action.finished", status: "succeeded", key: "agent:main:telegram:direct:1000000001" }], null);
    writeRunState(root, "overene", "# Run state\n- Status: WAITING_USER\n- Next action: cakam\n", 15);
    const outVerified = run(root, ["--dry-run"]);
    check("reálny send v okne pred mtime: žiadny skorý alarm", !outVerified.includes("stalled:overene"), outVerified);

    // Send do internal-ui (agent:app-builder:main, nie telegram:direct) sa NEPOČÍTA ako doručenie.
    writeDb(root, [{ minAgo: 5, kind: "tool_action", action: "tool.action.finished", status: "succeeded", key: "agent:app-builder:main" }], null);
    writeRunState(root, "interne", "# Run state\n- Status: WAITING_USER\n- Next action: cakam\n", 15);
    const outInternal = run(root, ["--dry-run"]);
    check("send len do internal-ui sa nepočíta: alarmuje", outInternal.includes("poslal by som stalled:interne"), outInternal);

    // Regresný test na reálny incident 3.9.2026: nesúvisiaci telegram send 28 min PRED zápisom
    // run-state (mimo tesného okna) nesmie omylom "overiť" úplne inú, nedoručenú eskaláciu.
    writeDb(root, [{ minAgo: 28, kind: "tool_action", action: "tool.action.finished", status: "succeeded", key: "agent:main:telegram:direct:1000000001" }], null);
    writeRunState(root, "stary-nesuvisiaci-send", "# Run state\n- Status: WAITING_USER\n- Next action: cakam\n", 15);
    const outStale = run(root, ["--dry-run"]);
    check("28 min starý nesúvisiaci send neoveruje novú eskaláciu: alarmuje", outStale.includes("poslal by som stalled:stary-nesuvisiaci-send"), outStale);
  }
}

console.log("\n11d) Písanie do prázdna: message na interný session_key bez akéhokoľvek reálneho doručenia");
if (DatabaseSync) {
  const INTERNAL = { kind: "tool_action", action: "tool.action.finished", tool: "message", key: "agent:app-builder:main" };
  const REAL = { kind: "tool_action", action: "tool.action.finished", tool: "message", status: "succeeded", key: "agent:main:telegram:direct:1000000001" };

  // a) "úspešné" volanie do internal-ui, nič reálne po ňom → alarm (toto je incident z 3.9.2026)
  const a = fresh("lost-report");
  writeRunState(a, "pisal-do-prazdna", ACTIVE, 5); // beh je aktívny, NIE WAITING_USER
  writeDb(a, [Object.assign({ minAgo: 30, status: "succeeded" }, INTERNAL)], null);
  const outA = run(a, ["--dry-run"], LEGACY);
  check("internal-ui send bez doručenia: alarmuje aj mimo WAITING_USER", outA.includes("poslal by som lost-report"), outA);
  check("text vysvetľuje, že interná konverzácia nie je Telegram", outA.includes("NIE JE Telegram"), outA);

  // b) po internom pokuse nasledoval skutočný telegram:direct send → ticho
  const b = fresh("lost-report-ok");
  writeRunState(b, "doslo-to", ACTIVE, 5);
  writeDb(b, [Object.assign({ minAgo: 30, status: "succeeded" }, INTERNAL), Object.assign({ minAgo: 25 }, REAL)], null);
  check("reálny send po internom pokuse: ticho", !run(b, ["--dry-run"], LEGACY).includes("lost-report"), "");

  // c) zlyhané volanie, ale text doručil watchdog cez outbox → ticho
  const c = fresh("lost-report-outbox");
  writeRunState(c, "cez-outbox", ACTIVE, 5);
  writeDb(c, [Object.assign({ minAgo: 30, status: "failed" }, INTERNAL)], null);
  writeAb(c, "cez-outbox", "outbox.sent.jsonl", JSON.stringify({ id: "x1", sent_at: new Date(Date.now() - 20 * 60_000).toISOString(), message_id: "3959" }) + "\n");
  check("doručenie cez outbox sa počíta ako dôkaz: ticho", !run(c, ["--dry-run"], LEGACY).includes("lost-report"), "");

  // d) čerstvý pokus (< grace) → agent ešte môže doplniť outbox, nekričíme
  const d = fresh("lost-report-fresh");
  writeRunState(d, "cerstve", ACTIVE, 5);
  writeDb(d, [Object.assign({ minAgo: 5, status: "failed" }, INTERNAL)], null);
  check("pokus mladší než grace: ticho", !run(d, ["--dry-run"], LEGACY).includes("lost-report"), "");

  // e) dávno opustený beh (> 12 h) sa už nerieši
  const e = fresh("lost-report-old");
  writeRunState(e, "stare", ACTIVE, 5);
  writeDb(e, [Object.assign({ minAgo: 13 * 60, status: "succeeded" }, INTERNAL)], null);
  check("pokus starší než 12 h: ticho", !run(e, ["--dry-run"], LEGACY).includes("lost-report"), "");
}

console.log("\n11e) Review-gate: DONE v STANDARD/DEEP bez stopy po nezávislom review = alarm; s review alebo FAST = ticho");
{
  const doneBody = (mode, extra) =>
    `# Run state\n- Status: DONE\n- Verification mode: ${mode}\n- Next action: none\n\n## Log\n- built and ${extra}\n`;

  // a) STANDARD DONE, žiadny review marker → alarm
  const a = fresh("review-gate-skipped");
  writeRunState(a, "appka", doneBody("STANDARD", "pytest 7/7, committed, marked DONE"), 30);
  const outA = run(a, ["--dry-run"], LEGACY);
  check("STANDARD DONE bez review → alarm", outA.includes("review-gate:appka") && outA.includes("bez stopy po nezávislom review"), outA);

  // b) STANDARD DONE so stopou po codex review → ticho
  const b = fresh("review-gate-ok");
  writeRunState(b, "appka", doneBody("STANDARD", "codex review PASS: 0 BLOCKER, committed, DONE"), 30);
  check("STANDARD DONE s codex review → ticho", !run(b, ["--dry-run"], LEGACY).includes("review-gate:appka"), "");

  // c) DEEP DONE s adversarial review → ticho
  const c = fresh("review-gate-deep-ok");
  writeRunState(c, "appka", doneBody("DEEP", "independent adversarial review, 0 BLOCKER, DONE"), 30);
  check("DEEP DONE s adversarial review → ticho", !run(c, ["--dry-run"], LEGACY).includes("review-gate:appka"), "");

  // d) FAST DONE bez review → ticho (FAST samostatný review nevyžaduje)
  const d = fresh("review-gate-fast");
  writeRunState(d, "appka", doneBody("FAST", "pytest ok, DONE"), 30);
  check("FAST DONE bez review → ticho", !run(d, ["--dry-run"], LEGACY).includes("review-gate:appka"), "");

  // e) ABORTED v STANDARD → ticho (nedokončený beh nič nereviewuje)
  const e = fresh("review-gate-aborted");
  writeRunState(e, "appka", `# Run state\n- Status: ABORTED\n- Verification mode: STANDARD\n- Next action: none\n`, 30);
  check("ABORTED STANDARD → ticho", !run(e, ["--dry-run"], LEGACY).includes("review-gate:appka"), "");

  // f) Neoverené DONE nesmie po 24 h z kontroly zmiznúť (test-euro-split).
  const f = fresh("review-gate-old");
  writeRunState(f, "appka", doneBody("STANDARD", "pytest ok, DONE"), 25 * 60);
  check("STANDARD DONE bez review staršie než 24 h → stále alarm", run(f, ["--dry-run"], LEGACY).includes("review-gate:appka"), "");

  // g) verification_mode chýba v run-state, ale je v confirmed_handoff.json (STANDARD) → alarm
  const g = fresh("review-gate-handoff-mode");
  writeRunState(g, "appka", `# Run state\n- Status: DONE\n- Next action: none\n\n## Log\n- built, DONE\n`, 30);
  const sfDir = path.join(projectDir(g, "appka"), ".solution-factory");
  fs.mkdirSync(sfDir, { recursive: true });
  fs.writeFileSync(path.join(sfDir, "confirmed_handoff.json"), JSON.stringify({ verification_mode: "STANDARD" }));
  check("mode z handoffu (STANDARD) + žiadny review → alarm", run(g, ["--dry-run"], LEGACY).includes("review-gate:appka"), "");
}

console.log("\n11f) Phase 7: GPT fallback nesmie preskočiť Fable; poradie a dôkaz patria aktuálnemu slice");
{
  const command = 'acpx --model claude-fable-5 --approve-reads --non-interactive-permissions deny --cwd "worktree" claude exec "review"';
  const fable = { slice: "S1", route: "fable", outcome: "unavailable", command, exit_code: 1, result: "acpx launched; Claude CLI authentication failed" };
  const weak = { slice: "S1", route: "same-family", outcome: "passed", exit_code: 0, session_id: "fresh-review-1", result: "PASS: 0 BLOCKER, 0 IMPORTANT; weaker same-family review" };
  const attempt = (a) => `- Review attempt: ${JSON.stringify(a)}\n`;
  const body = (events, extra = "", model = "gpt-5.6-sol", status = "DONE", mode = "STANDARD") =>
    `# Run state\nStatus: ${status}\nVerification mode: ${mode}\nCurrent slice: S1\nOrchestrator model: ${model}\nNext action: none\n\n## Phase 7\n${events.map(attempt).join("")}${extra}\n`;
  const scenario = (name, content, age = 30) => {
    const root = fresh(`phase7-${name}`);
    writeRunState(root, "appka", content, age);
    return root;
  };
  const gate = (root) => runStatus(root).runs.find((r) => r.source === "app-builder").reviewGate;

  const skipped = scenario("skip", body([weak]));
  check("GPT + same-family bez Fable → blocked + konkrétny backend a route", gate(skipped).blocked && gate(skipped).code === "fable-before-same-family" && gate(skipped).backend === "gpt-5.6-sol" && gate(skipped).requiredRoute === "fable", JSON.stringify(gate(skipped)));
  const out = run(skipped, ["--dry-run"]);
  check("dry-run hlási preskočený krok 2 aj backend do logu", out.includes("review-gate:appka") && out.includes("backend=gpt-5.6-sol") && out.includes("Spusti krok 2"), out);
  check("dry-run nemení run-state ani stav watchdogu", fs.readFileSync(path.join(projectDir(skipped, "appka"), ".app-builder", "run-state.md"), "utf8") === body([weak]) && !fs.existsSync(path.join(skipped, "state.json")));
  check("GPT + reálny neúspešný Fable pred slabším reviewerom → prejde", !gate(scenario("ordered", body([fable, weak]))).blocked);
  check("Fable iba naplánovaný → blokuje", gate(scenario("planned", body([{ ...fable, outcome: "planned" }, weak]))).blocked);
  check("Fable skipped ani unavailable bez exit výsledku → blokuje", gate(scenario("skipped", body([{ ...fable, exit_code: null }, weak]))).blocked);
  check("Samotné Fable/acpx/reviewer/0 BLOCKER v texte nepovolí krok 3", gate(scenario("words", body([weak], "Fable review / acpx unavailable; reviewer 0 BLOCKER"))).blocked);
  check("Fable attempt bez výstupu → blokuje", gate(scenario("empty-result", body([{ ...fable, result: "" }, weak]))).blocked);
  check("Fable timeout s reálnou dĺžkou pokusu → prejde", !gate(scenario("timeout", body([{ ...fable, outcome: "timeout", exit_code: null, duration_ms: 60000 }, weak]))).blocked);
  check("Fable timeout bez spustenia → blokuje", gate(scenario("timeout-zero", body([{ ...fable, outcome: "timeout", exit_code: null, duration_ms: 0 }, weak]))).blocked);
  check("Nepripnutý Fable model → blokuje", gate(scenario("model", body([{ ...fable, command: command.replace("--model claude-fable-5", "") }, weak]))).blocked);
  check("Fable bez read-only flags → blokuje", gate(scenario("permissions", body([{ ...fable, command: command.replace("--approve-reads", "--approve-all") }, weak]))).blocked);
  check("Fable z predchádzajúceho slice neplatí", gate(scenario("old-slice", body([{ ...fable, slice: "S0" }, weak]))).blocked);
  check("Fable až po slabšom reviewerovi (neúspešný) poradie neopraví", gate(scenario("late", body([weak, fable]))).blocked);
  check("Dodatočná úspešná Fable re-review porušenie napraví", !gate(scenario("repaired", body([weak, { ...fable, outcome: "passed", exit_code: 0, result: "PASS: 0 BLOCKER, 0 IMPORTANT" }]))).blocked);
  check("Nový slabší reviewer po doloženom Fable pokuse prejde", !gate(scenario("rerun", body([weak, fable, { ...weak, session_id: "fresh-review-2" }]))).blocked);
  check("Poškodený strojový záznam zlyhá uzavreto", gate(scenario("corrupt", body([], '- Review attempt: {broken\nsame-family review PASS'))).code === "review-evidence-invalid");
  check("Skutočný Fable PASS stačí aj pri GPT", !gate(scenario("fable-pass", body([{ ...fable, outcome: "passed", exit_code: 0, result: "PASS: 0 BLOCKER" }]))).blocked);
  check("Čakajúca Fable review v REVIEW sa smie dobehnúť", !gate(scenario("waiting-review", body([], "Fable review pending", "gpt-5.6-sol", "REVIEW"))).blocked);
  check("Porušenie sa hlási aj pred DONE (REVIEW)", gate(scenario("active", body([weak], "", "gpt-5.6-sol", "REVIEW"))).blocked);
  check("Porušenie sa hlási aj vo WAITING_USER po odovzdaní", gate(scenario("uat", body([weak], "", "gpt-5.6-sol", "WAITING_USER"))).blocked);
  check("Porušenie neexpiruje ani po 4 dňoch", gate(scenario("old", body([weak]), 4 * 24 * 60)).blocked);
  check("FAST má zachovanú výnimku", !gate(scenario("fast", body([weak], "", "gpt-5.6-sol", "DONE", "FAST"))).blocked);
  check("ABORTED má zachovanú výnimku", !gate(scenario("aborted", body([weak], "", "gpt-5.6-sol", "ABORTED"))).blocked);
  check("STANDARD na Claude bez GPT signálu nemení legacy fallback pravidlo", !gate(scenario("claude", body([weak], "", "claude-opus-4-8"))).blocked);
  check("DEEP vyžaduje Fable pred slabším Claude reviewerom aj bez GPT dôkazu", gate(scenario("deep", body([weak], "", "claude-opus-4-8", "DONE", "DEEP"))).blocked);
  check("Role swap: Claude reviewer Codex implementácie nie je self-review", !gate(scenario("roles", body([weak]).replace("Current slice:", "Implementer: codex\nCurrent slice:"))).blocked);
  check("GPT model v review zázname prekoná starý primary header", gate(scenario("runtime", body([{ ...weak, orchestrator_model: "gpt-5.6-sol" }], "", "claude-opus-4-8"))).blocked);
  check("Explicitný GPT fallback backend bez presného model ID sa zachytí", gate(scenario("gpt-name", body([weak], "", "GPT fallback"))).blocked);
  check("Novší runtime Claude záznam neoznačí starší decline za aktívny GPT", !gate(scenario("back-to-claude", body([{ slice: "S1", route: "codex", outcome: "declined", result: 'nested-codex decline' }, { ...weak, orchestrator_model: "claude-opus-4-8" }]))).blocked);
  check("Štrukturálny nested-codex decline sa deteguje aj bez model field", gate(scenario("declined", body([], 'codex review: {"status":"declined", "exitCode":null, "durationMs":null}\nfresh Claude subagent adversarial review PASS', "unknown"))).code === "fable-before-same-family");
  check("Čisto textový GPT → fresh-Claude fallback sa tiež zachytí", gate(scenario("legacy", body([], "fresh-Claude adversarial review PASS; same-family weaker"))).blocked);
  check("Plán slabšieho review bez vykonania nie je porušenie poradia", !gate(scenario("future", body([], "Next: fresh Claude subagent review only after Fable unavailable", "gpt-5.6-sol", "REVIEW"))).blocked);
  check("Očakávaný PASS v pláne ešte nie je vykonaná adversarial review", !gate(scenario("future-pass", body([], "adversarial review pending; expected PASS", "gpt-5.6-sol", "REVIEW"))).blocked);
  check("JSON bez identity slice je neplatný dôkaz", gate(scenario("missing-slice", body([{ ...fable, slice: undefined }, weak]))).code === "review-evidence-invalid");
  check("Historické slabšie review mimo aktuálnej Phase 7 sekcie neblokuje", !gate(scenario("history", body([], "codex review PASS", "claude-opus-4-8") + "## History\nOrchestrator model: gpt-5.6-sol\nsame-family review PASS\n")).blocked);
  const other = scenario("unrelated-session", body([weak], "", "claude-opus-4-8"));
  writeSessions(other, { "agent:app-builder:other": { model: "gpt-5.6-sol", status: "running", updatedAt: Date.now() } });
  check("Globálna GPT session iného projektu nesmie kontaminovať beh", !gate(other).blocked);

  // Skutočný cyklus cez falošné CLI/Telegram: gate musí zadržať continuator aj closing duty.
  const enforced = scenario("enforced", body([weak], "", "gpt-5.6-sol", "REVIEW"));
  writeAb(enforced, "appka", "continue-request.json", { requested_at: new Date().toISOString(), reason: "continue despite review" });
  writeSfRunState(enforced, "appka", { status: "EXECUTING", phases: [] }, 30);
  writeSessions(enforced, {});
  run(enforced, []);
  run(enforced, []);
  check("Zablokovaná rýchla continue požiadavka nespustí CLI", cronAdds(enforced).length === 0 && cliCalls(enforced).length === 0);
  check("Žiadosť sa nestratí pri blokácii", abFiles(enforced, "appka").includes("continue-request.json"));
  check("Alarm sa doručí presne raz, dedup platí", sink(enforced).filter((t) => t.includes("Phase 7 review gate")).length === 1, JSON.stringify(sink(enforced)));
  let rejected = false;
  try { run(enforced, ["--continue-now", projectDir(enforced, "appka"), "--force"]); } catch (e) { rejected = e.status === 3 && String(e.stdout).includes("review-gate:appka"); }
  check("--continue-now --force neobíde gate", rejected && cronAdds(enforced).length === 0);
  writeRunState(enforced, "appka", body([weak]), 30);
  run(enforced, []);
  const sf = JSON.parse(fs.readFileSync(path.join(projectDir(enforced, "appka"), ".solution-factory", "run-state.json"), "utf8"));
  check("SF sa pri neplatnom DONE buildera nezatvorí", sf.status === "EXECUTING" && sf.phases.length === 0, JSON.stringify(sf));
  writeRunState(enforced, "appka", body([fable, weak]), 30);
  run(enforced, []);
  check("Po skutočnej oprave dôkazu sa closing duty obnoví", JSON.parse(fs.readFileSync(path.join(projectDir(enforced, "appka"), ".solution-factory", "run-state.json"), "utf8")).status === "DONE");

  for (const [name, text] of [
    ["codex-failed", "codex review failed; pytest PASS"],
    ["codex-pending", "codex review pending; expected PASS"],
    ["bare-marker", "reviewer / acpx / Fable review / 0 BLOCKER"],
    ["negation", "independent review not run; tests PASS"],
  ]) check(`DONE bez dokončenej review (${name}) → blokuje`, gate(scenario(name, body([], text, "claude-opus-4-8"))).blocked);
}

console.log("\n12) SF poškodený JSON = fail-loud alarm (nie continue); builder DONE + SF EXECUTING = zatvorí Factory");
{
  const root = fresh("sf-mixed");
  writeSfRunState(root, "rozbity", "{ toto nie je json", 60);
  writeRunState(root, "kombinovany", "# Run state\n- Status: DONE\n- Next action: none\n", 600);
  writeSfRunState(root, "kombinovany", { status: "EXECUTING", next_action: "slice 1", phases: [{ phase: "EXECUTING", started: "x", ended: null }] }, 60);
  const out = run(root, ["--dry-run"]);
  check("poškodený JSON hlási aj s continuatorom (fail-loud)", out.includes("poslal by som stalled:sf:rozbity"), out);
  check("poškodený JSON sa nespúšťa", !out.includes("continue rozbity"), out);
  check("app-builder DONE v kombinovanom nehlási", !out.includes("poslal by som stalled:kombinovany"), out);
  check("SF EXECUTING po DONE builderi: nie continue, ale zatvorenie", !out.includes("spustil by som continue kombinovany") && out.includes("zavrel by som Solution Factory kombinovany"), out);
  run(root, []);
  const sf = JSON.parse(fs.readFileSync(path.join(projectDir(root, "kombinovany"), ".solution-factory", "run-state.json"), "utf8"));
  check("naostro: SF status DONE + fáza watchdogu + updated_at", sf.status === "DONE" && sf.phases.some((p) => /watchdog/.test(p.executor)) && sf.updated_at && sf.phases[0].ended !== null, JSON.stringify(sf));
  check("Ivan dostal jednu správu o uzavretí", sink(root).filter((t) => t.includes("Solution Factory kombinovany")).length === 1, JSON.stringify(sink(root)));
  writeRunState(root, "zruseny", "# Run state\n- Status: ABORTED\n- Next action: none\n", 600);
  writeSfRunState(root, "zruseny", { status: "REVIEW", phases: [] }, 60);
  run(root, []);
  const sf2 = JSON.parse(fs.readFileSync(path.join(projectDir(root, "zruseny"), ".solution-factory", "run-state.json"), "utf8"));
  check("builder ABORTED → SF ABORTED", sf2.status === "ABORTED", JSON.stringify(sf2));
  const legacy = run(root, ["--dry-run"], LEGACY);
  check("bez continuatora: closable SF nealarmuje", !legacy.includes("stalled:sf:kombinovany"), legacy);
}

console.log("\n13) SF EXECUTING s aktívnym builder súborom = delegované; jeden continue na projekt");
{
  const root = fresh("sf-delegated");
  writeSfRunState(root, "odovzdany", { status: "EXECUTING", next_action: "builder pracuje" }, 120);
  writeRunState(root, "odovzdany", ACTIVE, 10);
  const out1 = run(root, ["--dry-run"]);
  check("SF nealarmuje (delegované)", !out1.includes("stalled:sf:odovzdany"), out1);
  check("čerstvý builder nič nespúšťa", !out1.includes("continue odovzdany"), out1);
  writeRunState(root, "odovzdany", ACTIVE, 60);
  const legacy = run(root, ["--dry-run"], LEGACY);
  check("bez continuatora: stalnutý builder alarmuje builder kľúčom", legacy.includes("poslal by som stalled:odovzdany"), legacy);
  check("bez continuatora: SF stále ticho", !legacy.includes("stalled:sf:odovzdany"), legacy);
  const out2 = run(root, ["--dry-run"]);
  const hits = out2.split("spustil by som continue odovzdany").length - 1;
  check("s continuatorom: presne jeden continue pre projekt s oboma súbormi", hits === 1, out2);
  const root2 = fresh("sf-not-delegated");
  writeSfRunState(root2, "visiaci", { status: "EXECUTING", next_action: "čaká na builder" }, 60);
  const out3 = run(root2, ["--dry-run"], LEGACY);
  check("EXECUTING bez buildera alarmuje (legacy)", out3.includes("poslal by som stalled:sf:visiaci"), out3);
}

console.log("\n14) Agent s jediným pripnutým modelom (fallbacks: []) — NIE je to výpadok reťazca");
{
  const PINNED_FAIL = {
    requestedProvider: "anthropic",
    requestedModel: "claude-opus-4-8",
    candidateProvider: "anthropic",
    candidateModel: "claude-opus-4-8",
    attempt: 1,
    total: 1,
    reason: "timeout",
    status: 408,
    isPrimary: true,
    fallbackConfigured: false,
    errorPreview: "CLI exceeded timeout (600s) and was terminated.",
  };
  const root = fresh("pinned-model");
  writeLog(root, [fallbackLine("candidate_failed", PINNED_FAIL, 10)]);
  const status = runStatus(root);
  check("outage = false", status.outage.outage === false, JSON.stringify(status.outage));
  check("zaráta ho medzi pinned", status.outage.pinnedFailures === 1, JSON.stringify(status.outage));
  const out = run(root, ["--dry-run"]);
  check("neposlal by falošný alarm", !out.includes("model-outage"), out);
}

console.log("\n15) Bežný úspešný turn ruší výstrahu (nielen candidate_succeeded)");
{
  const root = fresh("turn-clears");
  writeLog(root, [fallbackLine("candidate_failed", CHAIN_EXHAUSTED, 30), turnLine(5)]);
  const status = runStatus(root);
  check("outage = false po úspešnom turne", status.outage.outage === false, JSON.stringify(status.outage));
  const root2 = fresh("turn-noclear");
  writeLog(root2, [turnLine(30), fallbackLine("candidate_failed", CHAIN_EXHAUSTED, 10), turnLine(5, true)]);
  const status2 = runStatus(root2);
  check("outage = true (posledný turn zlyhal)", status2.outage.outage === true, JSON.stringify(status2.outage));
}

console.log("\n16) Text alarmu uvádza skutočnú príčinu, nevymýšľa si limit");
{
  const TIMEOUT_EXHAUSTED = Object.assign({}, CHAIN_EXHAUSTED, { reason: "timeout", status: 408, fallbackConfigured: true, errorPreview: "CLI exceeded timeout (600s) and was terminated." });
  const root = fresh("cause-timeout");
  writeLog(root, [fallbackLine("candidate_failed", TIMEOUT_EXHAUSTED, 10)]);
  const out = run(root, ["--dry-run"]);
  check("alarm sa pošle", out.includes("poslal by som model-outage"), out);
  check("netvrdí, že ide o limit", !out.includes("narazili na limit"), out);
  check("hovorí o timeoute", out.includes("timeout"), out);
  check("neuvádza čas resetu limitu", !out.includes("Reset limitu"), out);
  const root2 = fresh("cause-limit");
  writeLog(root2, [fallbackLine("candidate_failed", CHAIN_EXHAUSTED, 10)]);
  const out2 = run(root2, ["--dry-run"]);
  check("pri limite hovorí o limite", out2.includes("narazili na limit"), out2);
  check("pri limite uvádza reset", out2.includes("Reset limitu: 10:10pm"), out2);
}

// ============================================================ CONTINUATOR

console.log("\n17) Auto-continue: 30 min bez zmeny → jeden cron job (session:main, announce), info Ivanovi, živý job = zámok, potom backoff");
{
  const root = fresh("c-basic");
  writeRunState(root, "appka", ACTIVE, 30);
  run(root, []);
  const adds = cronAdds(root);
  check("jedno volanie cron add", adds.length === 1, JSON.stringify(cliCalls(root)));
  const a = adds[0] || [];
  const arg = (flag) => a[a.indexOf(flag) + 1];
  check("--agent app-builder", arg("--agent") === "app-builder", a.join(" "));
  check("--session session:main (serializovaná hlavná session)", arg("--session") === "session:main" && !a.includes("--session-key"), a.join(" "));
  check("--declaration-key auto-continue:appka (idempotencia)", arg("--declaration-key") === "auto-continue:appka", a.join(" "));
  check("doručenie: announce na telegram s cieľom a best-effort", a.includes("--announce") && arg("--channel") === "telegram" && arg("--to") === "1" && a.includes("--best-effort-deliver") && !a.includes("--no-deliver"), a.join(" "));
  check("--delete-after-run", a.includes("--delete-after-run"), a.join(" "));
  check("--timeout-seconds 5400", arg("--timeout-seconds") === "5400", a.join(" "));
  check("správa začína continue <dir>", String(arg("--message")).startsWith(`continue ${projectDir(root, "appka")}`), arg("--message"));
  check("správa hovorí o lock/outbox/continue-request/NO_REPLY/wip", /lock\.json/.test(arg("--message")) && /outbox\.jsonl/.test(arg("--message")) && /continue-request\.json/.test(arg("--message")) && /NO_REPLY/.test(arg("--message")) && /wip/.test(arg("--message")), arg("--message"));
  const st = readState(root);
  check("state: attempts=1, lastJobId=job-1, triggers=1, allTriggers=1", st.continues.appka.attempts === 1 && st.continues.appka.lastJobId === "job-1" && st.continues.appka.triggers.length === 1 && st.continues.appka.allTriggers.length === 1, JSON.stringify(st.continues));
  check("info Ivanovi o auto-pokračovaní s tabuľkou odstupov", sink(root).some((t) => t.includes("Auto-pokračovanie") && t.includes("job-1") && t.includes("25/45/90")), JSON.stringify(sink(root)));
  check("žiadny 🛑 alarm", !sink(root).some((t) => t.includes("sa nehýbe")), JSON.stringify(sink(root)));
  check("log: cron job", wdLog(root).includes("→ cron job job-1"), wdLog(root));
  check("job je v registri (fake CLI je stavové)", readJobs(root).some((j) => j.id === "job-1" && j.enabled === true), JSON.stringify(readJobs(root)));
  run(root, []);
  check("druhý cyklus: živý job = zámok, žiadne nové volanie", cronAdds(root).length === 1 && wdLog(root).includes("beží/čaká cron job job-1"), wdLog(root));
  finishJob(root, "job-1", "ok");
  run(root, []);
  check("job dobehol → backoff (25 min), lastJobResult=ran", cronAdds(root).length === 1 && wdLog(root).includes("backoff") && readState(root).continues.appka.lastJobResult === "ran", wdLog(root));
  check("info sa neposiela dvakrát", sink(root).filter((t) => t.includes("Auto-pokračovanie")).length === 1, JSON.stringify(sink(root)));
}

console.log("\n18) Čerstvý beh (10 min) — žiadne volanie; bez chat id sa použije --no-deliver; prefix pred JSON neškodí");
{
  const root = fresh("c-fresh");
  writeRunState(root, "appka", ACTIVE, 10);
  run(root, []);
  check("žiadne cron add", cronAdds(root).length === 0, JSON.stringify(cliCalls(root)));
  check("žiadna správa", sink(root).length === 0, JSON.stringify(sink(root)));
  const root2 = fresh("c-nochat");
  writeRunState(root2, "appka", ACTIVE, 30);
  run(root2, [], { WATCHDOG_CHAT_ID: "", WATCHDOG_BOT_TOKEN: "" });
  const a = cronAdds(root2)[0] || [];
  check("bez chat id: --no-deliver", a.includes("--no-deliver") && !a.includes("--announce"), a.join(" "));
  const root3 = fresh("c-prefix");
  writeRunState(root3, "appka", ACTIVE, 30);
  run(root3, [], { FAKE_CLI_PREFIX: "[cron] scheduler warming up" });
  check("riadok so zátvorkou pred JSON: add spočítaný ako úspech", cronAdds(root3).length === 1 && readState(root3).continues.appka.lastJobId === "job-1" && !wdLog(root3).includes("ZLYHAL"), wdLog(root3));
}

console.log("\n19) Rýchla cesta: continue-request.json spustí continue hneď, žiadosť ide cez .pending do history/");
{
  const root = fresh("c-fast");
  writeRunState(root, "appka", ACTIVE, 3);
  writeAb(root, "appka", "continue-request.json", { requested_at: new Date().toISOString(), reason: "S1 hotové, ďalej S2" });
  run(root, []);
  const adds = cronAdds(root);
  check("cron add spustené", adds.length === 1, JSON.stringify(cliCalls(root)));
  check("dôvod v správe", adds.length && /S1 hotové/.test(adds[0][adds[0].indexOf("--message") + 1]), adds.length ? adds[0].join(" ") : "");
  check("žiadosť skonzumovaná do history/", !abFiles(root, "appka").includes("continue-request.json") && historyFiles(root, "appka").some((f) => f.startsWith("continue-request.consumed-")), abFiles(root, "appka").join(",") + " | " + historyFiles(root, "appka").join(","));
  check("bez info správy (bežná prevádzka)", sink(root).length === 0, JSON.stringify(sink(root)));
  const st = readState(root).continues.appka;
  check("attempts ostáva 0, triggers=1", st.attempts === 0 && st.triggers.length === 1, JSON.stringify(st));
  writeAb(root, "appka", "continue-request.json", { reason: "znova" });
  run(root, []);
  check("ďalšia žiadosť kým job žije sa nespustí", cronAdds(root).length === 1 && /beží\/čaká cron job|posledný pokus pred/.test(wdLog(root)), wdLog(root));
  finishJob(root, "job-1", "ok");
  run(root, []);
  check("po dobehnutí jobu, ale do 5 min od spustenia → ešte nie", cronAdds(root).length === 1 && wdLog(root).includes("posledný pokus pred"), wdLog(root));
  // WAITING beh (limit providera) so žiadosťou = spustí; bez žiadosti nikdy
  const root2 = fresh("c-fast-waiting");
  writeRunState(root2, "limitovana", "# Run state\n- Status: WAITING (limit resetuje 22:00)\n- Next action: continue po resete\n", 200);
  run(root2, []);
  check("WAITING bez žiadosti sa nespúšťa", cronAdds(root2).length === 0, JSON.stringify(cliCalls(root2)));
  writeAb(root2, "limitovana", "continue-request.json", { reason: "limit reset", not_before: new Date(Date.now() - 1000).toISOString() });
  run(root2, []);
  check("WAITING so splatnou žiadosťou sa spustí", cronAdds(root2).length === 1, JSON.stringify(cliCalls(root2)));
  finishJob(root2, "job-1", "ok");
  writeRunState(root2, "hotova", "# Run state\n- Status: DONE\n- Next action: none\n", 5);
  writeAb(root2, "hotova", "continue-request.json", { reason: "zabudnutá žiadosť" });
  run(root2, []);
  check("DONE so žiadosťou sa nikdy nespustí", cronAdds(root2).length === 1, JSON.stringify(cliCalls(root2)));
}

console.log("\n20) continue-request: not_before v budúcnosti čaká; poškodený JSON spustí; expected_head mimo HEAD = stará žiadosť; CLI zlyhá = ostane .pending a skúsi sa znova");
{
  const root = fresh("c-notbefore");
  writeRunState(root, "appka", ACTIVE, 3);
  writeAb(root, "appka", "continue-request.json", { not_before: new Date(Date.now() + 30 * 60_000).toISOString() });
  run(root, []);
  check("v budúcnosti → nič", cronAdds(root).length === 0, JSON.stringify(cliCalls(root)));
  writeAb(root, "appka", "continue-request.json", "{ rozbity json");
  run(root, []);
  check("poškodený → spustí", cronAdds(root).length === 1, JSON.stringify(cliCalls(root)));
  const root2 = fresh("c-stalehead");
  writeRunState(root2, "appka", ACTIVE, 3);
  writeGitHead(root2, "appka", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  writeAb(root2, "appka", "continue-request.json", { reason: "x", expected_head: "aaaaaaaaaaaa" });
  run(root2, []);
  check("expected_head ≠ HEAD → nespustí, žiadosť odložená ako stale", cronAdds(root2).length === 0 && historyFiles(root2, "appka").some((f) => f.includes("stale")), wdLog(root2));
  writeAb(root2, "appka", "continue-request.json", { reason: "x", expected_head: "bbbbbbbbbbbb" });
  run(root2, []);
  check("expected_head = HEAD → spustí", cronAdds(root2).length === 1, wdLog(root2));
  const root3 = fresh("c-pending");
  writeRunState(root3, "appka", ACTIVE, 3);
  writeAb(root3, "appka", "continue-request.json", { reason: "cli padne" });
  run(root3, [], { FAKE_CLI_FAIL: "1" });
  check("CLI zlyhalo → žiadosť ostáva ako .pending", abFiles(root3, "appka").some((f) => f.startsWith("continue-request.pending-")) && !historyFiles(root3, "appka").length, abFiles(root3, "appka").join(","));
  const st3 = readState(root3).continues.appka;
  st3.lastTriggerAt = Date.now() - 10 * 60_000;
  writeState(root3, { alerts: {}, continues: { appka: st3 } });
  run(root3, []);
  check("ďalší cyklus: .pending sa spustí a skonzumuje", cronAdds(root3).length === 2 && historyFiles(root3, "appka").some((f) => f.startsWith("continue-request.consumed-")) && !abFiles(root3, "appka").some((f) => f.startsWith("continue-request.pending-")), abFiles(root3, "appka").join(",") + "|" + historyFiles(root3, "appka").join(","));
}

console.log("\n21) lock.json: čerstvý blokuje, orezaný na 100 min, neplatný nie; sirota len s dôkazom z DB");
{
  const root = fresh("c-lock");
  writeRunState(root, "appka", ACTIVE, 30);
  writeSessions(root, { "agent:app-builder:main": { status: "running", startedAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000 } });
  writeAb(root, "appka", "lock.json", { owner: "turn-1", started_at: new Date(Date.now() - 5 * 60_000).toISOString(), expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
  run(root, []);
  check("čerstvý lock + bežiaca session → skip (nie sirota)", cronAdds(root).length === 0 && /lock\.json čerstvý|beží ťah/.test(wdLog(root)) && !wdLog(root).includes("vlastníka"), wdLog(root));
  writeSessions(root, { "agent:app-builder:main": { status: "done" } });
  run(root, []);
  check("čerstvý lock bez DB dôkazu → lock rešpektovaný (DB neodpovedala)", cronAdds(root).length === 0 && wdLog(root).includes("DB o behu neodpovedala") && abFiles(root, "appka").includes("lock.json"), wdLog(root));
  if (writeDb(root, IDLE_DB)) {
    run(root, []);
    check("čerstvý lock + DB hovorí nič nebeží = sirota → odložený a spustí", cronAdds(root).length === 1 && historyFiles(root, "appka").some((f) => f.startsWith("lock.orphaned-")) && !abFiles(root, "appka").includes("lock.json"), wdLog(root));
  } else console.log("  SKIP  node:sqlite nie je dostupné (sirota)");
  const root2 = fresh("c-lock2");
  writeRunState(root2, "appka", ACTIVE, 30);
  writeSessions(root2, { "agent:app-builder:main": { status: "running", startedAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000 } });
  writeAb(root2, "appka", "lock.json", { owner: "turn-1", started_at: new Date(Date.now() - 130 * 60_000).toISOString(), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
  backdate(path.join(projectDir(root2, "appka"), ".app-builder", "lock.json"), 130);
  const status = runStatus(root2);
  check("expires_at v budúcnosti, ale started_at 130 min → orezané, nie je čerstvý", status.runs.find((x) => x.project === "appka").lock.fresh === false, "");
  writeAb(root2, "appka", "lock.json", { owner: "bez casu" });
  check("lock bez časov je neplatný", runStatus(root2).runs.find((x) => x.project === "appka").lock.fresh === false, "");
  const root3 = fresh("c-lock-noevidence");
  writeRunState(root3, "appka", ACTIVE, 30);
  writeAb(root3, "appka", "lock.json", { owner: "turn-1", started_at: new Date(Date.now() - 5 * 60_000).toISOString(), expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
  run(root3, []); // bez sessions.json aj bez DB
  check("žiadny dôkaz (bez DB, bez sessions.json) → lock ostáva, nič sa nespúšťa", cronAdds(root3).length === 0 && abFiles(root3, "appka").includes("lock.json"), wdLog(root3));
}

console.log("\n22) Bežiaci ťah podľa sessions.json: iba status running, pre každú app-builder session; killed/timeout = voľné");
{
  const root = fresh("c-busy");
  writeRunState(root, "appka", ACTIVE, 30);
  writeSessions(root, { "agent:app-builder:main": { status: "running", startedAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000 } });
  run(root, []);
  check("main running → skip", cronAdds(root).length === 0 && wdLog(root).includes("beží ťah"), wdLog(root));
  writeSessions(root, { "agent:app-builder:main": { status: "killed" }, "agent:app-builder:subagent:x": { status: "running", updatedAt: Date.now() - 30_000 } });
  run(root, []);
  check("subagent running → skip", cronAdds(root).length === 0, wdLog(root));
  writeSessions(root, { "agent:app-builder:main": { status: "killed", startedAt: Date.now() - 120_000 }, "agent:app-builder:cron:abc:run:1": { status: "timeout" } });
  run(root, []);
  check("killed/timeout → voľné → spustí", cronAdds(root).length === 1, wdLog(root));
  const root2 = fresh("c-busy-stale");
  writeRunState(root2, "appka", ACTIVE, 30);
  writeSessions(root2, { "agent:app-builder:main": { status: "running", startedAt: Date.now() - 200 * 60_000, updatedAt: Date.now() - 200 * 60_000 } });
  run(root2, []);
  check("running staršie než limit ťahu = mŕtvy záznam → spustí", cronAdds(root2).length === 1, wdLog(root2));
}

console.log("\n22b) Bežiaci ťah podľa SQLite audit_events/task_runs (spoľahlivejší zdroj)");
{
  if (!DatabaseSync) {
    console.log("  SKIP  node:sqlite nie je dostupné");
  } else {
    const root = fresh("c-sqlite");
    writeRunState(root, "appka", ACTIVE, 30);
    writeSessions(root, { "agent:app-builder:main": { status: "done" } }); // sessions.json klame "done"
    writeDb(root, [
      { minAgo: 40, kind: "agent_run", action: "agent.run.finished", status: "succeeded" },
      { minAgo: 3, kind: "tool_action", action: "tool.action.started", status: "started" },
    ]);
    run(root, []);
    check("tool udalosť pred 3 min bez finished → skip", cronAdds(root).length === 0 && wdLog(root).includes("audit: tool.action.started"), wdLog(root));
    writeDb(root, [
      { minAgo: 40, kind: "tool_action", action: "tool.action.started", status: "started" },
      { minAgo: 35, kind: "agent_run", action: "agent.run.finished", status: "timed_out" },
    ]);
    run(root, []);
    check("posledná udalosť agent.run.finished → spustí", cronAdds(root).length === 1, wdLog(root));
    const root2 = fresh("c-sqlite2");
    writeRunState(root2, "appka", ACTIVE, 30);
    writeSessions(root2, { "agent:app-builder:main": { status: "done" } });
    writeDb(root2, [{ minAgo: 200, kind: "agent_run", action: "agent.run.finished", status: "succeeded" }], ["running"]);
    run(root2, []);
    check("task_runs running → skip", cronAdds(root2).length === 0 && wdLog(root2).includes("task_runs running"), wdLog(root2));
    const root3 = fresh("c-sqlite3");
    writeRunState(root3, "appka", ACTIVE, 30);
    writeSessions(root3, { "agent:app-builder:main": { status: "done" } });
    writeDb(root3, [{ minAgo: 25, kind: "tool_action", action: "tool.action.started", status: "started", key: "agent:app-builder:subagent:xyz" }]);
    run(root3, []);
    check("stará udalosť subagenta (25 min) → nie je busy → spustí", cronAdds(root3).length === 1, wdLog(root3));
    const status = runStatus(root3);
    check("--status ukazuje sessionBusy zo SQLite (dbAnswered)", status.sessionBusy && /audit:/.test(status.sessionBusy.reason) && status.sessionBusy.dbAnswered === true, JSON.stringify(status.sessionBusy));
  }
}

console.log("\n22c) Živý cron job auto-continue = primárny zámok; vypnutý job = zapíše chybu, upraceme a skúsime znova; rm zlyhá = nič");
{
  const root = fresh("c-jobs");
  writeRunState(root, "appka", ACTIVE, 30);
  writeJobs(root, [{ id: "job-x", name: "auto-continue: appka", declarationKey: "auto-continue:appka", enabled: true, status: "running", state: { runningAtMs: Date.now() } }]);
  run(root, []);
  check("bežiaci job → skip", cronAdds(root).length === 0 && wdLog(root).includes("beží/čaká cron job"), wdLog(root));
  writeJobs(root, [{ id: "job-y", name: "auto-continue: iny-projekt", declarationKey: "auto-continue:iny-projekt", enabled: true, status: "idle", state: { nextRunAtMs: Date.now() + 5000 } }]);
  run(root, []);
  check("živý job INÉHO projektu → tiež skip (session:main je jedna)", cronAdds(root).length === 0, wdLog(root));
  // OpenClaw retry po prechodnej chybe: job ostáva enabled:true, status error, nextRunAtMs v budúcnosti = ŽIVÝ
  writeJobs(root, [{ id: "job-r", name: "auto-continue: appka", declarationKey: "auto-continue:appka", enabled: true, status: "error", state: { lastRunStatus: "error", lastError: "gateway timeout", nextRunAtMs: Date.now() + 10 * 60_000, consecutiveErrors: 1 } }]);
  run(root, []);
  check("job v cron retry (enabled, error, nextRunAtMs) = živý → skip, bez rm", cronAdds(root).length === 0 && !cliCalls(root).some((a) => a[1] === "rm") && wdLog(root).includes("job-r"), wdLog(root));
  writeJobs(root, [{ id: "job-z", name: "auto-continue: appka", declarationKey: "auto-continue:appka", enabled: false, status: "disabled", state: { lastRunStatus: "error", lastError: "CLI exceeded timeout (5400s) and was terminated." } }]);
  run(root, []);
  const st = readState(root).continues.appka;
  check("vypnutý job → prevJobResult s chybou, cron rm, nový pokus", cliCalls(root).some((a) => a[0] === "cron" && a[1] === "rm" && a[2] === "job-z") && cronAdds(root).length === 1 && String(st.prevJobResult).includes("5400s"), JSON.stringify(st) + " | " + JSON.stringify(cliCalls(root)));
  const add = cronAdds(root)[0];
  check("dôvod pokusu obsahuje predošlú chybu", /predošlý pokus/.test(add[add.indexOf("--message") + 1]), add.join(" "));
  check("register: starý job zmazaný, nový enabled", !readJobs(root).some((j) => j.id === "job-z") && readJobs(root).some((j) => j.enabled === true), JSON.stringify(readJobs(root)));
  const root2 = fresh("c-jobs-rmfail");
  writeRunState(root2, "appka", ACTIVE, 30);
  writeJobs(root2, [{ id: "job-old", name: "auto-continue: appka", declarationKey: "auto-continue:appka", enabled: false, status: "disabled", state: { lastError: "x" } }]);
  run(root2, [], { FAKE_CLI_FAIL_RM: "1" });
  check("rm zlyhá → žiadny add (upsert by prepísal vypnutý job)", cronAdds(root2).length === 0 && wdLog(root2).includes("nepodarilo odstrániť"), wdLog(root2));
  run(root2, []);
  check("ďalší cyklus: rm prejde, add prebehne", cronAdds(root2).length === 1 && readState(root2).continues.appka.attempts === 1, wdLog(root2));
}

console.log("\n23) Backoff a eskalácia: 4. pokus → alarm, potom pomalý režim a pripomienky");
{
  const root = fresh("c-escalate");
  writeRunState(root, "appka", ACTIVE, 300);
  const fp = "IMPLEMENTING#-";
  writeState(root, { alerts: {}, continues: { appka: { attempts: 3, lastFingerprint: fp, episodeStartedAt: Date.now() - 200 * 60_000, lastTriggerAt: Date.now() - 100 * 60_000, triggers: [] } } });
  run(root, []);
  let st = readState(root).continues.appka;
  check("4. pokus spustený", cronAdds(root).length === 1 && st.attempts === 4, JSON.stringify(st));
  check("eskalácia Ivanovi s návodom na pauzu", sink(root).some((t) => t.includes("Auto-pokračovanie nepomohlo") && t.includes("pauza appka")), JSON.stringify(sink(root)));
  check("escalatedAt zapísané", Boolean(st.escalatedAt), JSON.stringify(st));
  finishJob(root, "job-1", "ok");
  run(root, []);
  check("po eskalácii: pomalý režim, žiadne volanie", cronAdds(root).length === 1 && wdLog(root).includes("po eskalácii"), wdLog(root));
  st = readState(root).continues.appka;
  st.lastTriggerAt = Date.now() - 200 * 60_000;
  st.lastRemindAt = Date.now() - 7 * 60 * 60_000;
  writeState(root, { alerts: readState(root).alerts, continues: { appka: st } });
  run(root, []);
  check("po 3 h ďalší pokus", cronAdds(root).length === 2, wdLog(root));
  check("po 6 h pripomienka", sink(root).some((t) => t.includes("Pripomienka")), JSON.stringify(sink(root)));
  const root2 = fresh("c-backoff");
  writeRunState(root2, "appka", ACTIVE, 60);
  writeState(root2, { alerts: {}, continues: { appka: { attempts: 1, lastFingerprint: fp, lastTriggerAt: Date.now() - 10 * 60_000, episodeStartedAt: Date.now() - 10 * 60_000, triggers: [] } } });
  run(root2, []);
  check("10 min po 1. pokuse: čaká (25 min)", cronAdds(root2).length === 0 && wdLog(root2).includes("backoff"), wdLog(root2));
  const s2 = readState(root2).continues.appka;
  s2.lastTriggerAt = Date.now() - 30 * 60_000;
  writeState(root2, { alerts: {}, continues: { appka: s2 } });
  run(root2, []);
  check("30 min po 1. pokuse: 2. pokus", cronAdds(root2).length === 1 && readState(root2).continues.appka.attempts === 2, wdLog(root2));
}

console.log("\n24) Pokrok = zmena Status alebo HEAD (nie mtime): nuluje počítadlá aj okno spustení; samotný dotyk súboru nie");
{
  const root = fresh("c-progress");
  writeRunState(root, "appka", ACTIVE, 30);
  writeState(root, { alerts: {}, continues: { appka: { attempts: 4, lastFingerprint: "IMPLEMENTING#staryhead", escalatedAt: 1, lastRemindAt: 1, lastTriggerAt: Date.now() - 60_000, episodeStartedAt: 5, triggers: [1, 2, 3], allTriggers: [Date.now() - 1000] } } });
  run(root, []);
  const st = readState(root).continues.appka;
  check("HEAD sa zmenil → log pokrok, attempts=1, bez escalatedAt, triggers vynulované, allTriggers ostáva", wdLog(root).includes("pokrok") && st.attempts === 1 && !st.escalatedAt && st.triggers.length === 1 && st.allTriggers.length === 2, JSON.stringify(st));
  check("continue spustený v tom istom cykle", cronAdds(root).length === 1, JSON.stringify(cliCalls(root)));
  const root2 = fresh("c-touch");
  writeRunState(root2, "appka", ACTIVE, 30);
  writeState(root2, { alerts: {}, continues: { appka: { attempts: 2, lastFingerprint: "IMPLEMENTING#-", lastTriggerAt: Date.now() - 10 * 60_000, episodeStartedAt: 5, triggers: [] } } });
  run(root2, []);
  const st2 = readState(root2).continues.appka;
  check("iba iný mtime = žiadny pokrok (attempts ostáva 2, backoff)", st2.attempts === 2 && !wdLog(root2).includes("pokrok"), JSON.stringify(st2) + wdLog(root2));
}

console.log("\n25) Rýchla cesta bez pokroku: 3. spustenie bez zmeny HEAD/Status sa už nespustí, žiadosť sa odloží, eskaluje sa, stall cesta preberá");
{
  const root = fresh("c-fastloop");
  writeRunState(root, "appka", ACTIVE, 3);
  writeState(root, { alerts: {}, continues: { appka: { attempts: 0, lastFingerprint: "IMPLEMENTING#-", lastFastFingerprint: "IMPLEMENTING#-", noProgressFast: 2, lastTriggerAt: Date.now() - 10 * 60_000, episodeStartedAt: 5, triggers: [] } } });
  writeAb(root, "appka", "continue-request.json", { reason: "zase" });
  run(root, []);
  check("žiadne spustenie", cronAdds(root).length === 0 && wdLog(root).includes("bez pokroku"), wdLog(root));
  check("žiadosť odložená ako exhausted", !abFiles(root, "appka").includes("continue-request.json") && historyFiles(root, "appka").some((f) => f.includes("exhausted")), historyFiles(root, "appka").join(","));
  check("eskalácia s dôvodom (3 ťahy)", sink(root).some((t) => t.includes("Auto-pokračovanie nepomohlo") && t.includes("3 ťahy")), JSON.stringify(sink(root)));
  writeRunState(root, "appka", ACTIVE, 30);
  run(root, []);
  check("bez žiadosti preberá stall cesta (pokus 1 po 20 min)", cronAdds(root).length === 1 && readState(root).continues.appka.attempts === 1, wdLog(root));
  finishJob(root, "job-1", "ok");
  writeGitHead(root, "appka", "cccccccccccccccccccccccccccccccccccccccc");
  writeAb(root, "appka", "continue-request.json", { reason: "po commite" });
  const st = readState(root).continues.appka;
  st.lastTriggerAt = Date.now() - 10 * 60_000;
  writeState(root, { alerts: readState(root).alerts, continues: { appka: st } });
  run(root, []);
  check("po novom commite pokrok → žiadosť sa spustí", cronAdds(root).length === 2, wdLog(root));
  const root2 = fresh("c-fastcount");
  writeRunState(root2, "appka", ACTIVE, 3);
  writeState(root2, { alerts: {}, continues: { appka: { attempts: 0, lastFingerprint: "IMPLEMENTING#-", lastFastFingerprint: "IMPLEMENTING#-", noProgressFast: 1, lastTriggerAt: Date.now() - 10 * 60_000, episodeStartedAt: 5, triggers: [] } } });
  writeAb(root2, "appka", "continue-request.json", { reason: "x" });
  run(root2, []);
  check("2. rýchle spustenie bez pokroku prejde a zvýši počítadlo na 2", cronAdds(root2).length === 1 && readState(root2).continues.appka.noProgressFast === 2, JSON.stringify(readState(root2).continues));
}

console.log("\n26) Denný strop: 8 spustení BEZ pokroku za 24 h → PAUSE + správa; s pokrokom sa okno nuluje; 48 celkovo = tvrdý strop");
{
  const root = fresh("c-cap");
  writeRunState(root, "appka", ACTIVE, 30);
  const triggers = Array.from({ length: 8 }, (_, i) => Date.now() - (i + 1) * 60 * 60_000);
  writeState(root, { alerts: {}, continues: { appka: { attempts: 1, lastFingerprint: "IMPLEMENTING#-", lastTriggerAt: Date.now() - 60 * 60_000, episodeStartedAt: 5, triggers, allTriggers: triggers } } });
  run(root, []);
  check("žiadne spustenie", cronAdds(root).length === 0 && wdLog(root).includes("denný strop"), wdLog(root));
  check("PAUSE vytvorený", abFiles(root, "appka").includes("PAUSE"), abFiles(root, "appka").join(","));
  check("správa o strope", sink(root).some((t) => t.includes("Denný strop") && t.includes("bez pokroku")), JSON.stringify(sink(root)));
  const root2 = fresh("c-cap-old");
  writeRunState(root2, "appka", ACTIVE, 30);
  writeState(root2, { alerts: {}, continues: { appka: { attempts: 0, lastFingerprint: "IMPLEMENTING#-", triggers: Array.from({ length: 8 }, (_, i) => Date.now() - (25 + i) * 60 * 60_000) } } });
  run(root2, []);
  check("staršie než 24 h sa nepočítajú → spustí", cronAdds(root2).length === 1, wdLog(root2));
  // produktívny build: 9 rýchlych ťahov, každý s novým HEAD → žiadny strop
  const root3 = fresh("c-cap-productive");
  writeRunState(root3, "appka", ACTIVE, 3);
  let paused = false;
  for (let i = 1; i <= 9; i++) {
    writeGitHead(root3, "appka", String(i).repeat(40));
    writeAb(root3, "appka", "continue-request.json", { reason: `slice ${i}` });
    if (fs.existsSync(path.join(root3, "state.json"))) {
      const s = readState(root3);
      s.continues.appka.lastTriggerAt = Date.now() - 10 * 60_000;
      writeState(root3, s);
    }
    run(root3, []);
    finishJob(root3, `job-${i}`, "ok");
    if (abFiles(root3, "appka").includes("PAUSE")) paused = true;
  }
  check("9 produktívnych rýchlych ťahov: 9 spustení, žiadny PAUSE", cronAdds(root3).length === 9 && !paused, wdLog(root3));
  const root4 = fresh("c-cap-hard");
  writeRunState(root4, "appka", ACTIVE, 3);
  writeGitHead(root4, "appka", "d".repeat(40));
  writeAb(root4, "appka", "continue-request.json", { reason: "x" });
  writeState(root4, { alerts: {}, continues: { appka: { attempts: 0, lastFingerprint: "IMPLEMENTING#eeeeeeeeeeee", triggers: [], allTriggers: Array.from({ length: 48 }, (_, i) => Date.now() - (i + 1) * 20 * 60_000) } } });
  run(root4, []);
  check("48 spustení celkovo za 24 h → tvrdý strop aj s pokrokom", cronAdds(root4).length === 0 && abFiles(root4, "appka").includes("PAUSE") && sink(root4).some((t) => t.includes("celkovo")), wdLog(root4));
}

console.log("\n27) Outbox: atomické odloženie, potvrdenia v outbox.sent.jsonl, dedup, neodoslané späť");
{
  const root = fresh("c-outbox");
  writeRunState(root, "appka", ACTIVE, 5);
  const lines = [
    JSON.stringify({ ts: "2026-09-02T10:00:00+02:00", text: "S1 hotové: ingest funguje" }),
    JSON.stringify({ ts: "2026-09-02T10:01:00+02:00", text: "už poslané", sent: true, message_id: "1" }),
    "nie json",
    JSON.stringify({ ts: "2026-09-02T10:02:00+02:00", text: "Otázka: pokračovať na S2?" }),
    JSON.stringify({ ts: "2026-09-02T10:03:00+02:00", text: "S1 hotové: ingest funguje" }),
  ];
  writeAb(root, "appka", "outbox.jsonl", lines.join("\n") + "\n");
  const dry = run(root, ["--dry-run"]);
  check("dry-run len ohlási a nič nepresúva", dry.includes("poslal by som outbox appka") && sink(root).length === 0 && abFiles(root, "appka").includes("outbox.jsonl"), dry);
  run(root, []);
  const msgs = sink(root);
  check("poslal 2 správy (duplicita a už-poslané preskočené)", msgs.length === 2 && msgs.every((t) => t.startsWith("📨 appka")), JSON.stringify(msgs));
  check("outbox.jsonl zmizol, .processing upratané, outbox.sent.jsonl má 2 potvrdenia", !abFiles(root, "appka").includes("outbox.jsonl") && !abFiles(root, "appka").some((f) => f.includes("processing")) && fs.readFileSync(path.join(projectDir(root, "appka"), ".app-builder", "outbox.sent.jsonl"), "utf8").trim().split("\n").length === 2, abFiles(root, "appka").join(","));
  writeAb(root, "appka", "outbox.jsonl", JSON.stringify({ ts: "x", text: "S1 hotové: ingest funguje" }) + "\n");
  run(root, []);
  check("rovnaký text do 24 h sa nepošle znova", sink(root).length === 2 && wdLog(root).includes("duplicitná"), JSON.stringify(sink(root)));
  check("outbox funguje aj pre čerstvý beh (bez continue)", cronAdds(root).length === 0, JSON.stringify(cliCalls(root)));
  const root2 = fresh("c-outbox-fail");
  writeRunState(root2, "appka", ACTIVE, 5);
  writeAb(root2, "appka", "outbox.jsonl", JSON.stringify({ text: "prvá" }) + "\n" + JSON.stringify({ text: "druhá" }) + "\n");
  run(root2, [], { WATCHDOG_TELEGRAM_SINK: path.join(root2, "neexistujuci-priecinok", "sink.jsonl") });
  const back = fs.existsSync(path.join(projectDir(root2, "appka"), ".app-builder", "outbox.jsonl")) ? fs.readFileSync(path.join(projectDir(root2, "appka"), ".app-builder", "outbox.jsonl"), "utf8") : "";
  check("po zlyhaní ostanú obe správy v outbox.jsonl", back.includes("prvá") && back.includes("druhá") && wdLog(root2).includes("FAILED"), back + wdLog(root2));
}

console.log("\n28) Pauza a iné prekážky: nespustí, ale po 45 min bez zmeny pošle klasický alarm s dôvodom (aj so žiadosťou na disku)");
{
  const root = fresh("c-pause");
  writeRunState(root, "appka", ACTIVE, 30);
  writeAb(root, "appka", "PAUSE", "stop");
  run(root, []);
  check("projektová pauza → skip, po 30 min ešte bez alarmu", cronAdds(root).length === 0 && wdLog(root).includes("pozastavený") && sink(root).length === 0, wdLog(root));
  writeRunState(root, "appka", ACTIVE, 60);
  writeAb(root, "appka", "continue-request.json", { reason: "ležiaca žiadosť nesmie umlčať alarm" });
  run(root, []);
  check("po 60 min alarm s dôvodom PAUSE", sink(root).some((t) => t.includes("sa nehýbe") && t.includes("PAUSE")), JSON.stringify(sink(root)));
  fs.unlinkSync(path.join(projectDir(root, "appka"), ".app-builder", "PAUSE"));
  fs.unlinkSync(path.join(projectDir(root, "appka"), ".app-builder", "continue-request.json"));
  fs.writeFileSync(path.join(root, "global.PAUSE"), "stop");
  run(root, []);
  check("globálna pauza → skip (alarm už ohlásený, dedup)", cronAdds(root).length === 0 && wdLog(root).includes("globálna pauza") && sink(root).length === 1, wdLog(root));
  fs.unlinkSync(path.join(root, "global.PAUSE"));
  fs.unlinkSync(path.join(root, "state.json"));
  const legacy = run(root, ["--dry-run"], LEGACY);
  check("env vypnutie → pôvodný alarm", legacy.includes("poslal by som stalled:appka") && !legacy.includes("spustil by som continue"), legacy);
  const root2 = fresh("c-outage");
  writeRunState(root2, "appka", ACTIVE, 60);
  writeLog(root2, [fallbackLine("candidate_failed", CHAIN_EXHAUSTED, 10)]);
  run(root2, []);
  check("výpadok modelov → žiadne spustenie, alarm o výpadku + stall s dôvodom", cronAdds(root2).length === 0 && sink(root2).some((t) => t.includes("výpadok modelov")) && sink(root2).some((t) => t.includes("narazili na limit")), JSON.stringify(sink(root2)));
}

console.log("\n28b) Výpadok modelov nie je navždy: po 30 min (a po hlásenom čase resetu) jeden skúšobný ťah, potom opäť odstup");
{
  // "6:20pm" v tvare, aký píše provider; vzťahuje sa na lokálny čas tohto PC.
  const ampm = (d) => {
    const h = d.getHours();
    return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  };
  const exhausted = (resetMinutesFromNow, minAgo) =>
    fallbackLine(
      "candidate_failed",
      Object.assign({}, CHAIN_EXHAUSTED, {
        errorPreview: `You've hit your session limit · resets ${ampm(new Date(Date.now() + resetMinutesFromNow * 60_000))} (Europe/Bratislava)`,
      }),
      minAgo
    );

  // a) zlyhanie pred 40 min, reset už bol (pred 35 min) → skúšobný ťah; hneď ďalší cyklus už nie
  const a = fresh("outage-reprobe");
  writeRunState(a, "appka", ACTIVE, 60);
  writeLog(a, [exhausted(-35, 40)]);
  writeState(a, { alerts: { "model-outage": { fingerprint: "x", sentAt: Date.now() - 3_600_000 } }, modelOutage: { lastExhaustedAt: Date.now() - 45 * 60_000, lastSuccessAt: 0 } }); // starší než log riadok (40 min), aby sa z neho prevzal detail s "resets …"
  run(a, []);
  check("po 30 min od zlyhania a po resete: jeden skúšobný continue", cronAdds(a).length === 1 && wdLog(a).includes("povoľujem skúšobný ťah"), wdLog(a));
  check("lastProbeAt zapísaný do stavu", Number(readState(a).modelOutage.lastProbeAt) > Date.now() - 60_000, JSON.stringify(readState(a).modelOutage));
  run(a, []);
  check("ďalší cyklus bez nového dôkazu: opäť blokuje, skúšobný ťah sa neopakuje", wdLog(a).split("povoľujem skúšobný ťah").length === 2 && wdLog(a).includes("(výpadok modelov)"), wdLog(a));

  // b) zlyhanie pred 40 min, ale provider hlási reset až o 2 h → ešte nie
  const b = fresh("outage-reset-future");
  writeRunState(b, "appka", ACTIVE, 60);
  writeLog(b, [exhausted(120, 40)]);
  writeState(b, { alerts: { "model-outage": { fingerprint: "x", sentAt: Date.now() - 3_600_000 } }, modelOutage: { lastExhaustedAt: Date.now() - 45 * 60_000, lastSuccessAt: 0 } }); // starší než log riadok (40 min), aby sa z neho prevzal detail s "resets …"
  run(b, []);
  check("hlásený reset v budúcnosti: žiadny skúšobný ťah", cronAdds(b).length === 0 && !wdLog(b).includes("povoľujem skúšobný ťah"), wdLog(b));
  const stB = runStatus(b);
  check("--status ukazuje notBefore skúšky", stB.outage && stB.outage.probe && stB.outage.probe.due === false && typeof stB.outage.probe.notBefore === "string", JSON.stringify(stB.outage));
}

console.log("\n29) Zmrazený spec (confirmed_handoff.json): zmena hashu = PAUSE + správa; CRLF verzia sa berie ako zhodná");
{
  const root = fresh("c-frozen");
  writeRunState(root, "appka", ACTIVE, 30);
  const sfDir = path.join(projectDir(root, "appka"), ".solution-factory");
  fs.mkdirSync(sfDir, { recursive: true });
  const spec = "# Spec\n\nline\n";
  fs.writeFileSync(path.join(projectDir(root, "appka"), "SPEC.md"), spec.replace(/\n/g, "\r\n")); // CRLF pracovná kópia
  const sha = crypto.createHash("sha256").update(spec).digest("hex");
  fs.writeFileSync(path.join(sfDir, "confirmed_handoff.json"), JSON.stringify({ spec_file: "SPEC.md", spec_sha256: sha }));
  run(root, []);
  check("CRLF kópia s LF hashom = OK → spustí", cronAdds(root).length === 1 && !abFiles(root, "appka").includes("PAUSE"), wdLog(root));
  fs.writeFileSync(path.join(projectDir(root, "appka"), "SPEC.md"), "# Spec\n\nZMENENE\n");
  finishJob(root, "job-1", "ok");
  const st = readState(root).continues.appka;
  st.lastTriggerAt = Date.now() - 60 * 60_000;
  writeState(root, { alerts: {}, continues: { appka: st } });
  run(root, []);
  check("zmenený spec → žiadne spustenie, PAUSE, správa", cronAdds(root).length === 1 && abFiles(root, "appka").includes("PAUSE") && sink(root).some((t) => t.includes("Zmrazený spec")), wdLog(root) + JSON.stringify(sink(root)));
  const status = runStatus(root);
  check("--status ukazuje frozen.ok=false", status.runs.find((r) => r.project === "appka" && r.source === "app-builder").frozen.ok === false, "");
}

console.log("\n30) Zlyhanie CLI: nepočíta sa ako pokus agenta; po 3 zlyhaniach správa Ivanovi");
{
  const root = fresh("c-clifail");
  writeRunState(root, "appka", ACTIVE, 30);
  run(root, [], { FAKE_CLI_FAIL: "1" });
  let st = readState(root).continues.appka;
  check("attempts=0, triggerErrors=1, lastJobResult=cli-error", st.attempts === 0 && st.triggerErrors === 1 && String(st.lastJobResult).startsWith("cli-error"), JSON.stringify(st));
  check("log ZLYHAL", wdLog(root).includes("ZLYHAL"), wdLog(root));
  check("zatiaľ bez správy", sink(root).length === 0, JSON.stringify(sink(root)));
  st.triggerErrors = 2;
  st.lastTriggerAt = Date.now() - 60 * 60_000;
  writeState(root, { alerts: {}, continues: { appka: st } });
  run(root, [], { FAKE_CLI_FAIL: "1" });
  check("3. zlyhanie → správa", sink(root).some((t) => t.includes("nevie spustiť")), JSON.stringify(sink(root)));
}

console.log("\n30b) Nedoručená jednorazová správa (eskalácia) sa zaradí do fronty a pošle v ďalšom cykle presne raz");
{
  const root = fresh("c-pending-alert");
  writeRunState(root, "appka", ACTIVE, 300);
  writeState(root, { alerts: {}, continues: { appka: { attempts: 3, lastFingerprint: "IMPLEMENTING#-", episodeStartedAt: Date.now() - 200 * 60_000, lastTriggerAt: Date.now() - 100 * 60_000, triggers: [] } } });
  run(root, [], { WATCHDOG_TELEGRAM_SINK: path.join(root, "neexistujuci", "sink.jsonl") }); // Telegram "padne"
  const st = readState(root);
  check("4. pokus prebehol, eskalácia zapísaná, správa vo fronte", cronAdds(root).length === 1 && st.continues.appka.escalatedAt && Array.isArray(st.pendingAlerts) && st.pendingAlerts.some((p) => p.key === "continue-failed:appka"), JSON.stringify(st.pendingAlerts));
  finishJob(root, "job-1", "ok");
  run(root, []); // Telegram funguje
  check("v ďalšom cykle doručená presne raz", sink(root).filter((t) => t.includes("Auto-pokračovanie nepomohlo")).length === 1 && readState(root).pendingAlerts.length === 0, JSON.stringify(sink(root)));
  run(root, []);
  check("a už sa neopakuje", sink(root).filter((t) => t.includes("Auto-pokračovanie nepomohlo")).length === 1, JSON.stringify(sink(root)));
}

console.log("\n31) --continue-now: ručné spustenie, odmietnutie pri bežiacom ťahu/jobe, --force, chýbajúci argument");
{
  const root = fresh("c-now");
  writeRunState(root, "appka", ACTIVE, 1);
  const out = run(root, ["--continue-now", projectDir(root, "appka")]);
  check("spustené hneď aj pre čerstvý beh", cronAdds(root).length === 1 && /"ok":true/.test(out), out);
  check("stav uložený", readState(root).continues.appka.lastJobId === "job-1" && readState(root).continues.appka.triggers.length === 1, JSON.stringify(readState(root).continues));
  let code = 0;
  try {
    run(root, ["--continue-now", projectDir(root, "appka")]);
  } catch (e) {
    code = e.status;
  }
  check("živý job z prvého spustenia → exit 3", code === 3, String(code));
  run(root, ["--continue-now", projectDir(root, "appka"), "--force"]);
  check("--force spustí aj tak (upsert existujúceho jobu)", cliCalls(root).filter((a) => a[1] === "add").length === 2, JSON.stringify(cliCalls(root)));
  finishJob(root, "job-1", "ok");
  writeSessions(root, { "agent:app-builder:main": { status: "running", updatedAt: Date.now() } });
  let code2 = 0;
  try {
    run(root, ["--continue-now", projectDir(root, "appka")]);
  } catch (e) {
    code2 = e.status;
  }
  check("bežiaci ťah → exit 3", code2 === 3, String(code2));
  let code3 = 0;
  try {
    run(root, ["--continue-now", path.join(root, "projects", "neexistuje")]);
  } catch (e) {
    code3 = e.status;
  }
  check("neznámy projekt → exit 2", code3 === 2, String(code3));
  let code4 = 0;
  try {
    run(root, ["--continue-now"]);
  } catch (e) {
    code4 = e.status;
  }
  check("bez argumentu → exit 2 a žiadny bežný cyklus", code4 === 2 && cliCalls(root).filter((a) => a[1] === "add").length === 2, String(code4));
  writeSessions(root, { "agent:app-builder:main": { status: "done" } });
  const outUp = run(root, ["--continue-now", projectDir(root, "appka").toUpperCase()]);
  check("cesta v inej veľkosti písmen (Windows) sa nájde", /"ok":true/.test(outUp), outUp);
}

console.log("\n31b) --continue-now nad starým vypnutým jobom: cron add ho len upsertne (enabled:false) → rm + druhý add, nie chyba");
{
  const root = fresh("continue-now-disabled-job");
  writeRunState(root, "appka", ACTIVE, 60);
  writeJobs(root, [{ id: "job-old", name: "auto-continue: appka", declarationKey: "auto-continue:appka", enabled: false, status: "disabled", state: { lastRunStatus: "error", lastError: "run_failed" } }]);
  let out = "";
  let ok = true;
  try {
    out = run(root, ["--continue-now", projectDir(root, "appka"), "--force"]);
  } catch (e) {
    ok = false;
    out = String(e.stdout || "") + String(e.stderr || "");
  }
  const calls = cliCalls(root);
  check("exit 0 a ok:true", ok && /"ok":true/.test(out), out);
  check("poradie: add (upsert vypnutého) → rm job-old → add znova", cronAdds(root).length === 2 && calls.some((a) => a[0] === "cron" && a[1] === "rm" && a[2] === "job-old"), JSON.stringify(calls));
  check("výsledný job je zapnutý", readJobs(root).some((j) => j.enabled !== false && j.declarationKey === "auto-continue:appka"), JSON.stringify(readJobs(root)));
  check("log vysvetľuje samoliečbu", wdLog(root).includes("upsertol vypnutý job"), wdLog(root));
}

console.log("\n32) --status obsahuje continuator a nové polia behu; dry-run nezapisuje stav; stav sa píše atomicky");
{
  const root = fresh("c-status");
  writeRunState(root, "appka", ACTIVE, 30);
  writeAb(root, "appka", "lock.json", { owner: "x", started_at: new Date().toISOString() });
  const status = runStatus(root);
  const r = status.runs.find((x) => x.project === "appka");
  check("continuator.enabled + backoff + dailyCap", status.continuator && status.continuator.enabled === true && Array.isArray(status.continuator.backoffMinutes) && status.continuator.dailyCap === 8, JSON.stringify(status.continuator));
  check("run má lock.fresh=true a frozen", r && r.lock && r.lock.fresh === true && r.frozen && r.frozen.checked === false, JSON.stringify(r && r.lock));
  run(root, ["--dry-run"]);
  check("dry-run nevytvorí state.json", !fs.existsSync(path.join(root, "state.json")), "");
  check("dry-run nevolá CLI", cronAdds(root).length === 0, JSON.stringify(cliCalls(root)));
  writeRunState(root, "appka", ACTIVE, 30);
  fs.unlinkSync(path.join(projectDir(root, "appka"), ".app-builder", "lock.json"));
  run(root, []);
  check("naostro: state.json existuje, žiadny .tmp zvyšok, modelOutage zapísaný", fs.existsSync(path.join(root, "state.json")) && !fs.readdirSync(root).some((f) => f.includes(".tmp-")) && readState(root).modelOutage, fs.readdirSync(root).join(","));
}

console.log("\n33) Jeden projekt na cyklus: dva zaseknuté projekty → spustí sa iba prvý, druhý až keď prvý job dobehne");
{
  const root = fresh("c-one-per-cycle");
  writeRunState(root, "alfa", ACTIVE, 30);
  writeRunState(root, "beta", ACTIVE, 30);
  run(root, []);
  check("prvý cyklus: jedno spustenie", cronAdds(root).length === 1 && wdLog(root).includes("v tomto cykle už bol spustený"), wdLog(root));
  run(root, []);
  check("druhý cyklus: živý job alfy blokuje aj betu", cronAdds(root).length === 1 && wdLog(root).includes("beží/čaká cron job"), wdLog(root));
  finishJob(root, "job-1", "ok");
  run(root, []);
  check("po dobehnutí: beta", cronAdds(root).length === 2 && cronAdds(root)[1].includes("auto-continue: beta"), wdLog(root));
}

console.log("\n34) Host runner integration: forged DONE, automatic queue, HOLD repair, final completion");
{
  const root = fresh("host-review");
  const project = "sample", dir = projectDir(root, project);
  const host = { WATCHDOG_TEST_LEGACY_REVIEW: "0" };
  writeRunState(root, project, "Status: DONE\nCurrent slice: S1\nVerification mode: STANDARD\nOrchestrator model: openai/gpt-5.6-sol\nCodex review: APPROVE (0/0/0)\n", 1);
  fs.writeFileSync(path.join(dir, "app.test.js"), "require('node:test')('real test',()=>require('node:assert/strict').equal(1+1,2));\n");
  fs.writeFileSync(path.join(dir, "APP_SPEC.md"), "One plus one equals two.\n");
  writeSessions(root, {});
  const before = runStatus(root, host).runs.find((r) => r.source === "app-builder");
  check("model PASS without host receipt is blocked", before.reviewGate.blocked && before.reviewGate.host, JSON.stringify(before.reviewGate));
  check("status command writes no host state", !fs.existsSync(path.join(root, "review-host")));
  run(root, ["--dry-run"], host);
  check("dry-run does not launch or create a receipt", !fs.existsSync(path.join(root, "review-host")) && cronAdds(root).length === 0);
  writeAb(root, project, "outbox.jsonl", JSON.stringify({ kind: "completion", text: "FINAL RESULT fixture" }) + "\n" + JSON.stringify({ text: "PROGRESS fixture" }) + "\n");
  run(root, [], host);
  const queued = runStatus(root, host).runs.find((r) => r.source === "app-builder");
  check("watchdog demotes false DONE and queues a host review", queued.status === "REVIEW" && queued.hostReview.status === "queued", JSON.stringify(queued.hostReview));
  check("review queue never wakes implementer prematurely", cronAdds(root).length === 0);
  check("completion report is held while ordinary progress is delivered", !sink(root).some((text) => text.includes("FINAL RESULT fixture")) && sink(root).some((text) => text.includes("PROGRESS fixture")));
  check("GPT fallback routing is visible in watchdog log", wdLog(root).includes("routes=fable→same-family") && wdLog(root).includes("gpt-5.6-sol"), wdLog(root));
  const engine = path.join(__dirname, "app-builder-review.js");
  const execute = (verdict, command = "run") => execFileSync(process.execPath, ["-e", `
    const {createService}=require(process.argv[1]);
    const verdict=process.argv[4];
    const service=createService({root:process.argv[2],invokeRoute:async()=>({outcome:'reviewed',exit_code:0,review:{verdict,acceptance:verdict==='APPROVE'?'PASS':'FAIL',summary:'Fixture review',findings:verdict==='APPROVE'?[]:[{severity:'IMPORTANT',location:'app.test.js:1',evidence:'Verified fixture defect',correction:'Repair the defect'}]}})});
    const project=process.argv[3];
    (async()=>{if(process.argv[5]==='complete')service.complete(project);else{service.request(project,{final:true});await service.run(project);}console.log(JSON.stringify(service.inspect(project)));})().catch(e=>{console.error(e.message);process.exit(1)});
  `, engine, path.join(root, "review-host"), dir, verdict, command], { encoding: "utf8", windowsHide: true });
  execute("HOLD"); run(root, [], host);
  const jobs = cronAdds(root);
  check("host HOLD allows exactly one repair continuation", jobs.length === 1, wdLog(root));
  const message = jobs[0]?.[jobs[0].indexOf("--message") + 1] || "";
  check("repair continuation includes central evidence and existing worker resume", message.includes("review.json") && message.includes("resumeSessionId") && message.includes("oprav iba doložené chyby"), message);
  finishJob(root, "job-1", "ok");
  fs.appendFileSync(path.join(dir, "app.test.js"), "// repaired\n");
  execute("APPROVE");
  writeRunState(root, project, "Status: DONE\nCurrent slice: S1\n", 0);
  const premature = runStatus(root, host).runs.find((r) => r.source === "app-builder");
  check("even an approved review requires host completion, model DONE is blocked", premature.reviewGate.blocked && !premature.hostReview.completed);
  execute("APPROVE", "complete");
  const done = runStatus(root, host).runs.find((r) => r.source === "app-builder");
  check("host complete releases DONE for the approved source", !done.reviewGate.blocked && done.hostReview.completed, JSON.stringify(done.hostReview));
  run(root, [], host);
  check("held completion report is delivered only after host complete", sink(root).filter((text) => text.includes("FINAL RESULT fixture")).length === 1);
  fs.appendFileSync(path.join(dir, "app.test.js"), "// changed after approval\n");
  check("source edit after DONE re-closes gate", runStatus(root, host).runs.find((r) => r.source === "app-builder").reviewGate.blocked);
  let refused = false;
  try { run(root, ["--continue-now", dir, "--force"], host); } catch (e) { refused = e.status === 3; }
  check("--force cannot bypass stale completion", refused);
}

console.log("\n34b) Host-review alerts ignore normal running state and deduplicate unchanged failures");
{
  const host = { WATCHDOG_TEST_LEGACY_REVIEW: "0", WATCHDOG_DISABLE_CONTINUE: "1" };
  const prepare = (root, project, execute) => {
    const dir = projectDir(root, project);
    writeRunState(root, project, "Status: REVIEW\nCurrent slice: S1\nVerification mode: STANDARD\nOrchestrator model: anthropic/claude-opus-4-8\n", 1);
    fs.writeFileSync(path.join(dir, "app.test.js"), "require('node:test')('real test',()=>{});\n");
    fs.writeFileSync(path.join(dir, "APP_SPEC.md"), "The fixture remains valid.\n");
    execFileSync(process.execPath, ["-e", `
      const {createService}=require(process.argv[1]);
      const service=createService({root:process.argv[2],invokeRoute:async()=>({outcome:'unavailable',error:'offline'})});
      (async()=>{service.request(process.argv[3]);if(process.argv[4]==='run')await service.run(process.argv[3]);})().catch(e=>{console.error(e);process.exit(1)});
    `, path.join(__dirname, "app-builder-review.js"), path.join(root, "review-host"), dir, execute ? "run" : "queue"], { encoding: "utf8", windowsHide: true });
  };
  const queuedRoot = fresh("host-review-quiet-running");
  prepare(queuedRoot, "queued-app", false); run(queuedRoot, [], host);
  check("queued/running review neposiela poplašnú správu", !sink(queuedRoot).some((text) => text.includes("Phase 7 review gate")), sink(queuedRoot).join("\n"));

  const failedRoot = fresh("host-review-stable-alert");
  prepare(failedRoot, "failed-app", true);
  backdate(path.join(projectDir(failedRoot, "failed-app"), ".app-builder", "run-state.md"), 180);
  run(failedRoot, [], host);
  const firstCount = sink(failedRoot).filter((text) => text.includes("Phase 7 review gate")).length;
  check("review-pending nevytvára súčasne druhý stalled alarm", sink(failedRoot).length === 1, sink(failedRoot).join("\n"));
  const state = readState(failedRoot); state.alerts["review-gate:failed-app"].sentAt = Date.now() - 3 * 60 * 60_000; writeState(failedRoot, state);
  fs.appendFileSync(path.join(projectDir(failedRoot, "failed-app"), ".app-builder", "run-state.md"), "\n");
  run(failedRoot, [], host);
  const secondCount = sink(failedRoot).filter((text) => text.includes("Phase 7 review gate")).length;
  check("rovnaké needs-attention sa po zmene mtime znovu neposiela", firstCount === 1 && secondCount === 1, sink(failedRoot).join("\n"));
}

console.log("\n35) Registered isolated worktree outside project roots remains scheduled");
{
  const root = fresh("external-worktree"), host = { WATCHDOG_TEST_LEGACY_REVIEW: "0" };
  const dir = path.join(root, "worktrees", "isolated-app");
  fs.mkdirSync(path.join(dir, ".app-builder"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".app-builder", "run-state.md"), "Status: REVIEW\nCurrent slice: S1\nOrchestrator model: gpt-5.6-sol\n");
  fs.writeFileSync(path.join(dir, "app.test.js"), "require('node:test')('fixture',()=>{});\n");
  writeSessions(root, {});
  const service = require("./app-builder-review").createService({ root: path.join(root, "review-host") });
  service.request(dir);
  const runs = runStatus(root, host).runs;
  check("exact registered worktree is discovered outside roots", runs.length === 1 && runs[0].dir === dir && runs[0].hostReview.status === "queued");
  run(root, [], host);
  check("watchdog processes its review queue without waking implementer", wdLog(root).includes("host-review:isolated-app queued=") && cronAdds(root).length === 0, wdLog(root));
}

console.log(`\n=== ${pass} PASS, ${fail} FAIL ===`);
console.log(`temp: ${TMP}`);
try {
  if (!process.env.WATCHDOG_TEST_KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true });
} catch (_) {}
process.exit(fail ? 1 : 0);
