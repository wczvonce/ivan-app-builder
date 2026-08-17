// Testy detekcie pre app-builder-watchdog.js.
// Spúšťa watchdog v --dry-run/--status proti syntetickým dátam v temp adresári
// (env WATCHDOG_* prepíše cesty), takže produkčný stav ani Telegram sa nedotkne.
//
// Použitie: node app-builder-watchdog.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const WATCHDOG = path.join(__dirname, "app-builder-watchdog.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-test-"));

let pass = 0;
let fail = 0;

function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? "\n        " + extra : ""}`);
  }
}

function fresh(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  return dir;
}

function writeRunState(root, project, body, ageMinutes) {
  const dir = path.join(root, "projects", project, ".app-builder");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "run-state.md");
  fs.writeFileSync(file, body);
  const when = new Date(Date.now() - ageMinutes * 60_000);
  fs.utimesSync(file, when, when);
}

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

function writeLog(root, lines) {
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(root, "logs", `openclaw-${day}.log`), lines.join("\n") + "\n");
}

function run(root, args) {
  const env = Object.assign({}, process.env, {
    WATCHDOG_PROJECT_ROOTS: path.join(root, "projects"),
    WATCHDOG_OPENCLAW_LOG_DIR: path.join(root, "logs"),
    WATCHDOG_STATE_FILE: path.join(root, "state.json"),
    WATCHDOG_LOG_FILE: path.join(root, "watchdog.log"),
  });
  return execFileSync(process.execPath, [WATCHDOG].concat(args), {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

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

console.log("\n1) Fallback zabral (Claude limit → GPT uspel) — žiadny alarm");
{
  const root = fresh("fallback-ok");
  writeLog(root, [
    fallbackLine("candidate_failed", MID_CHAIN_FAIL, 20),
    fallbackLine("candidate_succeeded", SUCCEEDED, 19),
  ]);
  const status = JSON.parse(run(root, ["--status"]));
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
  const status = JSON.parse(run(root, ["--status"]));
  check("outage = true", status.outage.outage === true, JSON.stringify(status.outage));
  const out = run(root, ["--dry-run"]);
  check("poslal by alarm", out.includes("poslal by som model-outage"), out);
  check("obsahuje čas resetu", out.includes("10:10pm"), out);
}

console.log("\n3) Reťazec ožil po výpadku — správa o zotavení, keď bol alarm v stave");
{
  const root = fresh("recovered");
  writeLog(root, [
    fallbackLine("candidate_failed", CHAIN_EXHAUSTED, 60),
    fallbackLine("candidate_succeeded", SUCCEEDED, 5),
  ]);
  fs.writeFileSync(
    path.join(root, "state.json"),
    JSON.stringify({ alerts: { "model-outage": { fingerprint: "x", sentAt: Date.now() - 3_600_000 } } })
  );
  const out = run(root, ["--dry-run"]);
  check("poslal by zotavenie", out.includes("poslal by som model-recovered"), out);
}

console.log("\n4) Zaseknutý beh (Status: IMPLEMENTING, 60 min bez zmeny) — alarm");
{
  const root = fresh("stalled");
  writeRunState(
    root,
    "appka-test",
    "# Run state\n- Status: IMPLEMENTING\n- Next action: dokončiť slice 2\n",
    60
  );
  const out = run(root, ["--dry-run"]);
  check("poslal by alarm", out.includes("poslal by som stalled:appka-test"), out);
  check("uvádza continue príkaz", out.includes("continue "), out);
}

console.log("\n5) Beh v poriadku alebo uzavretý — žiadny alarm");
{
  const root = fresh("quiet");
  writeRunState(root, "svieza", "# Run state\n- Status: IMPLEMENTING\n- Next action: slice 1\n", 10);
  writeRunState(root, "hotova", "# Run state\n- Status: DONE\n- Next action: none\n", 600);
  writeRunState(
    root,
    "stary-format-hotovy",
    "# run-state\n- discovery status: CONFIRMED\n- repair rounds (slice): 0\n",
    900
  );
  writeLog(root, [fallbackLine("candidate_succeeded", SUCCEEDED, 5)]);
  const out = run(root, ["--dry-run"]);
  check("svieži beh nehlási", !out.includes("stalled:svieza"), out);
  check("hotový beh nehlási", !out.includes("stalled:hotova"), out);
  check("starý formát bez next action nehlási", !out.includes("stalled:stary-format-hotovy"), out);
}

console.log("\n6) Opustený projekt (26 h bez zmeny) — nehlásiť, nie je to zaseknutý beh");
{
  const root = fresh("abandoned");
  writeRunState(
    root,
    "davno-opusteny",
    "# Run state\n- Status: REVIEW\n- Next action: dokončiť review\n",
    26 * 60
  );
  const out = run(root, ["--dry-run"]);
  check("nehlási opustený projekt", !out.includes("stalled:davno-opusteny"), out);
}

console.log("\n7) Čakanie na Ivanovo rozhodnutie — miernejší limit (90 min)");
{
  const root = fresh("waiting");
  writeRunState(root, "caka-60", "# Run state\n- Status: BLOCKED (limit)\n- Next action: čakám\n", 60);
  writeRunState(root, "caka-120", "# Run state\n- Status: BLOCKED (limit)\n- Next action: čakám\n", 120);
  const out = run(root, ["--dry-run"]);
  check("po 60 min ešte nehlási", !out.includes("stalled:caka-60"), out);
  check("po 120 min hlási", out.includes("poslal by som stalled:caka-120"), out);
  check("text je o čakaní na rozhodnutie", out.includes("čaká na tvoje rozhodnutie"), out);
}

console.log("\n8) Rovnaký stav sa nehlási dvakrát, po zmene stavu áno");
{
  const root = fresh("dedup");
  writeRunState(root, "appka", "# Run state\n- Status: IMPLEMENTING\n- Next action: slice 2\n", 60);
  const mtimeMs = fs.statSync(
    path.join(root, "projects", "appka", ".app-builder", "run-state.md")
  ).mtimeMs;
  const alreadySent = (fingerprint) =>
    fs.writeFileSync(
      path.join(root, "state.json"),
      JSON.stringify({ alerts: { "stalled:appka": { fingerprint, sentAt: Date.now() - 300_000 } } })
    );

  alreadySent(`IMPLEMENTING@${Math.floor(mtimeMs / 1000)}`);
  const same = run(root, ["--dry-run"]);
  check("nezmenený stav preskočí", same.includes("rovnaký stav už ohlásený"), same);

  alreadySent("REVIEW@1700000000"); // iný stav, ale ohlásený pred 5 min → cooldown
  const cooled = run(root, ["--dry-run"]);
  check("zmenený stav v cooldowne preskočí", cooled.includes("cooldown po predošlom alerte"), cooled);

  fs.writeFileSync(
    path.join(root, "state.json"),
    JSON.stringify({
      alerts: { "stalled:appka": { fingerprint: "REVIEW@1700000000", sentAt: Date.now() - 7_200_000 } },
    })
  );
  const after = run(root, ["--dry-run"]);
  check("po cooldowne a zmene stavu hlási", after.includes("poslal by som stalled:appka"), after);
}

console.log("\n9) Odolnosť: chýbajúce cesty a poškodený log nezhodia watchdog");
{
  const root = fresh("robust");
  fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });
  writeLog(root, ["toto nie je json", "{\"1\":{\"event\":\"model_fallback_decision\"}}", ""]);
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
}

console.log(`\n=== ${pass} PASS, ${fail} FAIL ===`);
console.log(`temp: ${TMP}`);
process.exit(fail ? 1 : 0);
