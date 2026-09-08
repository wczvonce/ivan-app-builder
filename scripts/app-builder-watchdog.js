// App Builder watchdog + continuator — model-free bezpečnostná sieť a MOTOR pokračovania.
//
// Beží ako naplánovaná úloha Windows (nie OpenClaw cron), takže funguje aj vtedy,
// keď je gateway mŕtva alebo keď narazili na limit VŠETKY modely naraz a žiadny
// agent nedokáže poslať správu. Telegram volá priamo cez bot API — bez LLM.
//
// Kontroly (pôvodné):
//   A) rozrobená stavba appky sa prestala hýbať (.app-builder/run-state.md)
//      + Solution Factory beh v tom istom projekte (.solution-factory/run-state.json)
//   B) fallback reťazec modelov je vyčerpaný (nikto neobslúžil poslednú správu)
//   C) OpenClaw gateway neodpovedá
//
// Continuator (2026-09-02, po zaseknutí nehnutelnosti-tracker):
//   D) aktívny beh, ktorý sa nehýbe, sa NERIEŠI len alarmom — watchdog sám spustí
//      `continue <projekt>` ako jednorazový OpenClaw cron ťah cez skutočné CLI
//      (session:main = serializované s ostatnými ťahmi agenta), s odstupom pokusov
//      0/25/45/90 min a eskaláciou Ivanovi po 4 neúspechoch. Agent nemá ako sa sám
//      prebudiť (cron tool je mu strhnutý, claude-cli most nemá CronCreate), preto je
//      motorom slučky tento skript.
//   E) rýchla cesta: agent na konci ťahu zapíše .app-builder/continue-request.json —
//      watchdog ho spustí hneď v ďalšom cykle (bez čakania na 20 min ticho).
//   F) outbox: .app-builder/outbox.jsonl — správy, ktoré agent nevedel doručiť
//      (message tool padol / internal-ui), pošle watchdog priamo cez Telegram API.
//   G) stráž zmrazených súborov: ak sa zmení hash spec/UI súboru z confirmed_handoff.json,
//      projekt sa pozastaví (PAUSE) a Ivan dostane správu.
//   H) zatvorenie Solution Factory stavu, keď builder skončil (DONE/ABORTED).
//   Poistky: primárny zámok = živý cron job `auto-continue: <projekt>` (declaration-key,
//   idempotentný), sekundárne lock.json + stav session + audit_events; denný strop ťahov
//   na projekt; pokrok = zmena git HEAD alebo Status:, nie mtime.
//   Pauza: súbor <projekt>/.app-builder/PAUSE alebo <scripts>/app-builder-continuator.PAUSE.
//
// Použitie: node app-builder-watchdog.js [--dry-run|--status|--test|--continue-now <projektDir> [--force]]

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const HOME = os.homedir();
const OPENCLAW_DIR = path.join(HOME, ".openclaw");
const CONFIG_FILE = process.env.WATCHDOG_CONFIG_FILE || path.join(OPENCLAW_DIR, "openclaw.json");
// Cesty sa dajú prepísať cez env — používa to test harness, aby nešpinil produkčný stav.
const STATE_FILE =
  process.env.WATCHDOG_STATE_FILE || path.join(__dirname, "app-builder-watchdog-state.json");
const LOG_FILE =
  process.env.WATCHDOG_LOG_FILE || path.join(__dirname, "app-builder-watchdog.log");
const LOG_DIR =
  process.env.WATCHDOG_OPENCLAW_LOG_DIR ||
  path.join(process.env.LOCALAPPDATA || os.tmpdir(), "Temp", "openclaw");
const PROJECT_ROOTS = process.env.WATCHDOG_PROJECT_ROOTS
  ? process.env.WATCHDOG_PROJECT_ROOTS.split(";").filter(Boolean)
  : [
      path.join(OPENCLAW_DIR, "workspace", "projects"),
      path.join(OPENCLAW_DIR, "workspace-app-builder", "projects"),
    ];
// Skutočné OpenClaw CLI (NIE bash alias `openclaw`, ten spúšťa starú verziu 2026.3).
const OPENCLAW_CLI =
  process.env.WATCHDOG_OPENCLAW_CLI ||
  path.join(HOME, "MojeAI", "node_modules", "openclaw", "dist", "index.js");
const NODE_BIN = process.env.WATCHDOG_NODE || process.execPath;
const SESSIONS_FILE =
  process.env.WATCHDOG_SESSIONS_FILE ||
  path.join(OPENCLAW_DIR, "agents", "app-builder", "sessions", "sessions.json");
// Stavová DB gateway (audit_events, task_runs) — spoľahlivý zdroj "beží ťah?"
// (sessions.json status vie ostať "done" aj počas neskorších behov; overené 2026-09-02).
const SQLITE_FILE =
  process.env.WATCHDOG_SQLITE_FILE || path.join(OPENCLAW_DIR, "state", "openclaw.sqlite");
const GLOBAL_PAUSE_FILE =
  process.env.WATCHDOG_PAUSE_FILE || path.join(__dirname, "app-builder-continuator.PAUSE");
const CONTINUE_DISABLED = process.env.WATCHDOG_DISABLE_CONTINUE === "1";
// Testovacie prepínače platia LEN s WATCHDOG_TEST=1 — zabudnutá premenná v prostredí by inak
// v produkcii ticho presmerovala Telegram do súboru alebo vypla kontrolu gateway.
const TEST_MODE = process.env.WATCHDOG_TEST === "1";
const LEGACY_REVIEW_TEST = TEST_MODE && process.env.WATCHDOG_TEST_LEGACY_REVIEW === "1";
const reviewService = require("./app-builder-review").createService({
  ...(TEST_MODE ? { root: process.env.WATCHDOG_REVIEW_ROOT || path.join(path.dirname(STATE_FILE), "review-host") } : {}),
});
const SKIP_GATEWAY = TEST_MODE && process.env.WATCHDOG_SKIP_GATEWAY === "1";
const TELEGRAM_SINK = TEST_MODE ? process.env.WATCHDOG_TELEGRAM_SINK || null : null;

const STALL_MINUTES = 45; // rozrobený beh bez zmeny run-state.md (alarm pre stavy bez auto-continue)
const WAITING_STALL_MINUTES = 90; // beh, ktorý čaká na Ivanovo rozhodnutie
const USER_COURT_STALL_MINUTES = 360; // 6 h v "čakám na Ivana", keď je doručenie nezávisle overené
const USER_COURT_UNVERIFIED_STALL_MINUTES = 10; // bez overeného Telegram sendu → pripomienka takmer hneď
// "Písal do prázdna": agent volal message na vlastný interný session_key (agent:app-builder:*),
// čo NIKDY nekončí na Telegrame, a ani nezapísal do outboxu. Platí v KAŽDOM stave behu, nielen
// pri WAITING_USER — 3.9.2026 takto zmizlo deväť "hotovo S1/S2" reportov pri Status: IMPLEMENTING.
const LOST_REPORT_GRACE_MINUTES = 15; // agent má čas doplniť outbox (watchdog beží každých 5 min)
const LOST_REPORT_MAX_HOURS = 12; // staršie už neriešime, to nie je živý beh
// Ako ďaleko PRED zápisom run-state hľadať reálny send. Musí byť tesné: cieľom je zachytiť
// send, ktorý patrí k TEJTO eskalácii (zvyčajne pár sekúnd pred zápisom stavu), nie hocijaký
// starší telegram send v konverzácii — široké okno (skúšané 30 min) omylom "overilo" doručenie
// 3.9.2026, lebo 28 min predtým odišla nesúvisiaca správa a skutočná eskalácia sa stratila.
const USER_COURT_VERIFY_LOOKBACK_MINUTES = 5;
const MAX_STALE_HOURS = 12; // starší run-state (čakajúce stavy) = dávno opustený projekt
const ACTIVE_MAX_STALE_HOURS = 72; // aktívny build sledujeme a oživujeme až 3 dni, potom je opustený
const COOLDOWN_MS = 60 * 60 * 1000; // po zmene stavu neposielať častejšie ako raz za hodinu
const GATEWAY_STRIKES = 2; // koľko behov po sebe musí gateway mlčať

// Continuator
const CONTINUE_AFTER_MINUTES = 20; // aktívny beh bez zmeny → prvý auto-continue
const CONTINUE_BACKOFF_MINUTES = [0, 25, 45, 90]; // odstup pred pokusom č. 1..4
const CONTINUE_MAX_ATTEMPTS = CONTINUE_BACKOFF_MINUTES.length; // po 4 neúspechoch eskalácia
const CONTINUE_SLOW_MINUTES = 180; // po eskalácii ďalší pokus každé 3 h
const CONTINUE_REMIND_MINUTES = 360; // po eskalácii pripomienka Ivanovi každých 6 h
// Výpadok modelov sa ruší LEN kladným dôkazom (úspešný ťah v logu gateway). Keď ale watchdog
// počas výpadku nič nespúšťa, dôkaz nikdy nevznikne — 3.9.2026 tak stál nehnutelnosti-tracker
// 3,5 h po tom, čo sa limit o 18:20 reálne obnovil. Preto: skúšobný ťah najskôr po tomto odstupe
// od posledného zlyhania/skúšky, a nie skôr než hlásený čas resetu ("resets 6:20pm"), ak sa dá prečítať.
const OUTAGE_REPROBE_MINUTES = 30;
const FAST_MIN_GAP_MINUTES = 5; // rýchla cesta: najviac raz za 5 min na projekt
const FAST_NOPROGRESS_MAX = 3; // rýchle pokračovania bez pokroku (HEAD/Status) → eskalácia
const DAILY_TRIGGER_CAP = 8; // spustení BEZ POKROKU na projekt za 24 h; potom auto-PAUSE + správa
const HARD_TRIGGER_CAP = 48; // absolútny strop spustení na projekt za 24 h (aj s pokrokom) — poistka proti falošnému pokroku
const PENDING_ALERT_MAX = 20; // nedoručené jednorazové správy čakajú na ďalší cyklus (max 24 h)
const TRIGGER_ERRORS_ALERT = 3; // zlyhania CLI za sebou → správa Ivanovi
const LOCK_MAX_MINUTES = 100; // lock.json platí najviac 100 min (ťah má 90 min)
const BUSY_WINDOW_MINUTES = 20; // tool udalosť mladšia než toto bez agent.run.finished = ťah beží
const STUCK_BUSY_MINUTES = 150; // "beží ťah", ale run-state stojí tak dlho → alarm
const CLI_TIMEOUT_MS = 30_000;
const CONTINUE_TURN_TIMEOUT_SECONDS = 5400; // vlastný limit pre continue ťah (default agenta je 1800)
const OUTBOX_MAX_PER_RUN = 10;
const TELEGRAM_MAX_CHARS = 4000;

// run-state statusy, pri ktorých je beh uzavretý a nič nečakáme
const TERMINAL_STATUSES = ["DONE", "ABORTED", "CANCELLED", "CANCELED", "MERGED", "DELIVERED"];
// statusy, kde loptička je u Ivana (agent už písal, len to mohlo zapadnúť)
const WAITING_STATUSES = ["BLOCKED", "WAITING", "AWAITING", "ESCALATED", "PAUSED"];
// Solution Factory stavy, kde je loptička u Ivana a smie ležať aj hodiny (discovery,
// schvaľovanie, akceptácia) — watchdog pri nich mlčí, ale NIE navždy: agent sa vie
// prepnúť do "čakám na Ivana" po správe, ktorá sa mu nikdy nedoručila (2026-09-02,
// nehnutelnosti-tracker: mockupy odišli do internal-ui, nie na Telegram, a beh by tam
// ležal donekonečna). Po USER_COURT_STALL_MINUTES pošle watchdog JEDNU pripomienku.
const USER_COURT_STATUSES = ["WAITING_USER", "AWAITING_APPROVAL", "READY_FOR_UAT"];

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const STATUS_ONLY = args.includes("--status");
const TEST_SEND = args.includes("--test");
const CONTINUE_NOW_IDX = args.indexOf("--continue-now");
const CONTINUE_NOW_DIR = CONTINUE_NOW_IDX >= 0 ? args[CONTINUE_NOW_IDX + 1] : null;
const FORCE = args.includes("--force");

// ---------------------------------------------------------------- utility

function now() {
  const fixed = TEST_MODE ? Number(process.env.WATCHDOG_NOW_MS) : NaN;
  return Number.isFinite(fixed) && fixed > 0 ? fixed : Date.now();
}

function iso(ms) {
  return new Date(ms === undefined ? now() : ms).toISOString();
}

function logLine(msg) {
  const line = `${iso()} ${msg}\n`;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1_000_000) {
      const keep = fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-2000).join("\n");
      fs.writeFileSync(LOG_FILE, keep);
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
  console.log(line.trimEnd());
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

// Atomický zápis (tmp + rename) — stav nesmie skončiť polovičný, keď scheduler proces zabije.
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function saveState(state) {
  if (DRY_RUN) return;
  try {
    writeJsonAtomic(STATE_FILE, state);
  } catch (e) {
    logLine(`stav sa nepodarilo uložiť: ${e.message}`);
  }
}

function telegramConfig() {
  const cfg = readJson(CONFIG_FILE, null);
  return (cfg && cfg.channels && cfg.channels.telegram) || {};
}

function botToken() {
  const token = process.env.WATCHDOG_BOT_TOKEN || telegramConfig().botToken;
  if (!token) throw new Error("Telegram botToken sa nenašiel v openclaw.json ani v WATCHDOG_BOT_TOKEN");
  return token;
}

// Príjemca = vlastník inštancie. Berieme ho z exec-approvers, aby v kóde
// nebolo natvrdo zapísané žiadne osobné id.
function chatId() {
  if (process.env.WATCHDOG_CHAT_ID) return process.env.WATCHDOG_CHAT_ID;
  const tg = telegramConfig();
  const approvers = tg.execApprovals && tg.execApprovals.approvers;
  if (Array.isArray(approvers) && approvers.length) return String(approvers[0]);
  throw new Error(
    "Nenašiel som príjemcu: nastav WATCHDOG_CHAT_ID alebo channels.telegram.execApprovals.approvers v openclaw.json"
  );
}

function chatIdOrNull() {
  try {
    return chatId();
  } catch (_) {
    return null;
  }
}

function maskChatId(id) {
  return id.length > 6 ? `${id.slice(0, 3)}***${id.slice(-3)}` : "***";
}

// Vracia message_id (Telegram), aby outbox vedel zapísať dôkaz o doručení.
async function sendTelegram(text) {
  if (TELEGRAM_SINK) {
    fs.appendFileSync(TELEGRAM_SINK, JSON.stringify({ ts: iso(), text }) + "\n");
    return `sink-${Date.now()}`;
  }
  const url = `https://api.telegram.org/bot${botToken()}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId(), text, disable_notification: false }),
    signal: AbortSignal.timeout(15_000), // visiace spojenie nesmie zožrať celý cyklus (PT10M limit úlohy)
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  try {
    const body = await res.json();
    return body && body.result && body.result.message_id ? String(body.result.message_id) : null;
  } catch (_) {
    return null;
  }
}

function minutesAgo(ms) {
  return Math.max(0, Math.round((now() - ms) / 60000));
}

function humanAge(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function parseTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function shortHash(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, 12);
}

// ------------------------------------------------- A) rozrobené stavby

// Skill negarantuje pole `Status:` (prvé behy ho nemali), preto klasifikujeme
// tolerantne: bez jasného signálu radšej mlčíme, než by sme budili falošný alarm.
function classifyRun(status, nextAction) {
  const done = (s) => TERMINAL_STATUSES.some((t) => s.startsWith(t));
  if (status) {
    const up = status.toUpperCase();
    if (done(up)) return "terminal";
    // user-court pred waiting: WAITING_USER obsahuje aj substring WAITING
    if (USER_COURT_STATUSES.some((w) => up.includes(w))) return "user-court";
    if (WAITING_STATUSES.some((w) => up.includes(w))) return "waiting";
    return "active";
  }
  // Bez statusu sa opierame o "next action": žiadny ďalší krok = uzavretý beh.
  if (!nextAction || /^(none|n\/a|nič|ziadn|žiadn)/i.test(nextAction)) return "terminal";
  return "active";
}

// HEAD gitu projektu (bez spúšťania gitu) — súčasť definície pokroku.
function gitHead(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref:\s*(.+)$/);
    if (!m) return head.slice(0, 12);
    const refFile = path.join(dir, ".git", ...m[1].split("/"));
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, "utf8").trim().slice(0, 12);
    const packed = fs.readFileSync(path.join(dir, ".git", "packed-refs"), "utf8");
    const line = packed.split(/\r?\n/).find((l) => l.endsWith(" " + m[1]));
    return line ? line.slice(0, 12) : null;
  } catch (_) {
    return null;
  }
}

// lock.json je poradný (píše ho model). Platí najviac LOCK_MAX_MINUTES od started_at aj od
// mtime súboru — dlhší expires_at sa oreže, lock bez časov je neplatný (zabitý ťah by inak
// blokoval navždy).
function readLock(dir) {
  const file = path.join(dir, ".app-builder", "lock.json");
  if (!fs.existsSync(file)) return { present: false, fresh: false, lock: null };
  const lock = readJson(file, null);
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch (_) {}
  if (!lock || typeof lock !== "object") return { present: true, fresh: false, lock: null };
  const expires = parseTime(lock.expires_at);
  const started = parseTime(lock.started_at);
  const cap = Math.min(
    started !== null ? started + LOCK_MAX_MINUTES * 60_000 : Infinity,
    mtime ? mtime + LOCK_MAX_MINUTES * 60_000 : Infinity
  );
  let until;
  if (expires !== null) until = Math.min(expires, cap);
  else if (started !== null) until = cap;
  else until = 0;
  return { present: true, fresh: until > now(), lock, until };
}

// Žiadosť agenta o prebudenie: continue-request.json (čerstvá) alebo
// continue-request.pending-*.json (CLI predtým zlyhalo — skúsi sa znova).
function readContinueRequest(dir) {
  const abDir = path.join(dir, ".app-builder");
  let names = [];
  try {
    names = fs.readdirSync(abDir).filter((f) => f === "continue-request.json" || /^continue-request\.pending-.*\.json$/.test(f));
  } catch (_) {
    return null;
  }
  if (!names.length) return null;
  names.sort();
  const name = names.includes("continue-request.json") ? "continue-request.json" : names[names.length - 1];
  const file = path.join(abDir, name);
  const req = readJson(file, null);
  if (!req || typeof req !== "object") return { file, corrupt: true, due: true, pending: name !== "continue-request.json" };
  const notBefore = parseTime(req.not_before);
  return {
    file,
    corrupt: false,
    due: notBefore === null || notBefore <= now(),
    request: req,
    pending: name !== "continue-request.json",
  };
}

// G) Zmrazené súbory z confirmed_handoff.json — hash musí sedieť (raw alebo s CRLF→LF,
// lebo core.autocrlf mení bajty v pracovnej kópii).
function checkFrozenContract(dir) {
  const handoff = readJson(path.join(dir, ".solution-factory", "confirmed_handoff.json"), null);
  if (!handoff || typeof handoff !== "object") return { checked: false, ok: true, violations: [] };
  const pairs = [
    [handoff.spec_file, handoff.spec_sha256],
    [handoff.ui_spec_file, handoff.ui_spec_sha256],
  ];
  const violations = [];
  let checked = false;
  for (const [file, expected] of pairs) {
    if (!file || !expected || !/^[0-9a-f]{64}$/i.test(String(expected))) continue;
    const full = path.isAbsolute(file) ? file : path.join(dir, file);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (_) {
      violations.push({ file, expected, actual: "(súbor chýba)" });
      checked = true;
      continue;
    }
    checked = true;
    const raw = sha256(buf);
    const lf = sha256(buf.toString("utf8").replace(/\r\n/g, "\n"));
    if (raw !== expected.toLowerCase() && lf !== expected.toLowerCase()) {
      violations.push({ file, expected, actual: lf });
    }
  }
  return { checked, ok: violations.length === 0, violations };
}

function scanRuns() {
  const runs = [];
  const projectDirs = new Map();
  const add = (dir) => projectDirs.set(path.resolve(dir).toLowerCase(), path.resolve(dir));
  for (const root of PROJECT_ROOTS) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (_) {
      continue;
    }
    for (const dir of entries) {
      add(path.join(root, dir.name));
    }
  }
  // Phase 3 stores run-state INSIDE the isolated worktree, which may be outside projects/.
  // request registers that exact path; never recursively scan its unrelated parent directory.
  if (!LEGACY_REVIEW_TEST) for (const dir of reviewService.registeredProjects()) add(dir);
  for (const projectDir of projectDirs.values()) {
      const dir = { name: path.basename(projectDir) };
      let abPresent = false;
      let abPhase = null;
      let abStatus = null;
      let abReviewGate = null;
      const abFile = path.join(projectDir, ".app-builder", "run-state.md");
      try {
        const text = fs.readFileSync(abFile, "utf8");
        abPresent = true;
        const mtimeMs = fs.statSync(abFile).mtimeMs;
        const statusMatch = text.match(/^[-*]?\s*(?:run )?status:\s*(.+)$/im);
        const nextMatch = text.match(/^[-*]?\s*Next action:\s*(.+)$/im);
        const status = statusMatch ? statusMatch[1].trim() : null;
        const nextAction = nextMatch ? nextMatch[1].trim() : null;
        abPhase = classifyRun(status, nextAction);
        abStatus = status;
        const legacyGate = checkReviewGate(projectDir, text, status);
        const hostReview = LEGACY_REVIEW_TEST ? null : reviewService.inspect(projectDir);
        abReviewGate = hostReviewGate(projectDir, status, legacyGate, hostReview);
        runs.push({
          source: "app-builder",
          project: dir.name,
          dir: projectDir,
          stateFile: abFile,
          status,
          reviewGate: abReviewGate,
          hostReview,
          nextAction,
          phase: abPhase,
          ageMinutes: minutesAgo(mtimeMs),
          mtimeMs,
          head: gitHead(projectDir),
          lock: readLock(projectDir),
          continueRequest: readContinueRequest(projectDir),
          paused: fs.existsSync(path.join(projectDir, ".app-builder", "PAUSE")),
          frozen: checkFrozenContract(projectDir),
        });
      } catch (_) {}

      // Solution Factory beh v tom istom projekte — JSON formát.
      const sfFile = path.join(projectDir, ".solution-factory", "run-state.json");
      try {
        const raw = fs.readFileSync(sfFile, "utf8");
        const mtimeMs = fs.statSync(sfFile).mtimeMs;
        // Nečitateľný JSON počas behu = fail-loud (klasifikuje sa ako aktívny beh),
        // nie ticho — poškodený stavový súbor nesmie umlčať watchdog.
        let status = "CORRUPT";
        let nextAction = null;
        try {
          const obj = JSON.parse(raw);
          status = typeof obj.status === "string" && obj.status.trim() ? obj.status.trim() : null;
          nextAction =
            typeof obj.next_action === "string" && obj.next_action.trim()
              ? obj.next_action.trim()
              : null;
        } catch (_) {}
        // Factory v EXECUTING odovzdala prácu builderovi — kým builder beh je OTVORENÝ,
        // živý stav drží .app-builder súbor (ten má vlastné stráženie) a alarm na stojaci
        // SF súbor by bol falošný poplach na nesprávnu vrstvu (30.8., firemna-prirucka).
        const delegated =
          abPresent &&
          abPhase !== "terminal" &&
          typeof status === "string" &&
          status.toUpperCase().includes("EXECUTING");
        // Builder skončil, Factory ostala otvorená → watchdog ju zavrie (H), nie alarm.
        const closable =
          abPresent &&
          abPhase === "terminal" &&
          typeof status === "string" &&
          /EXECUTING|REVIEW|QA/.test(status.toUpperCase());
        runs.push({
          source: "solution-factory",
          project: dir.name,
          dir: projectDir,
          stateFile: sfFile,
          status,
          nextAction,
          phase: delegated ? "delegated" : closable ? "closable" : classifyRun(status, nextAction),
          builderStatus: abStatus,
          reviewGate: abReviewGate,
          ageMinutes: minutesAgo(mtimeMs),
          mtimeMs,
          head: gitHead(projectDir),
          lock: readLock(projectDir),
          continueRequest: abPresent ? null : readContinueRequest(projectDir),
          paused: fs.existsSync(path.join(projectDir, ".app-builder", "PAUSE")),
          corrupt: status === "CORRUPT",
          frozen: abPresent ? { checked: false, ok: true, violations: [] } : checkFrozenContract(projectDir),
        });
      } catch (_) {}
  }
  return runs;
}

function hostReviewGate(dir, status, legacy, info) {
  if (!info || /^(ABORTED|CANCELLED|CANCELED)\b/i.test(status || "")) return legacy;
  if (info.approved && (!/^(DONE|MERGED|DELIVERED)\b/i.test(status || "") || info.completed)) return { ...legacy, blocked: false, code: null, reason: null, host: true, route: info.route };
  if (!info.managed && reviewService.legacyReviewed(dir)) return { ...legacy, blocked: false, code: null, reason: null, legacyBaseline: true };
  if (info.managed || /^(DONE|MERGED|DELIVERED|REVIEW)\b|REVIEW[-_ ]pending/i.test(status || "") || legacy.blocked) {
    return { ...legacy, host: true, blocked: true, code: `host-review-${info.managed ? info.status : "required"}`,
      backend: info.backend || legacy.backend, requiredRoute: "host-runner",
      reason: info.reason || "Chýba platné schválenie host runnera pre aktuálny zdrojový kód a testy." };
  }
  return legacy;
}

function canContinueThroughReview(run) {
  return !run.reviewGate?.blocked || (run.phase !== "terminal" && Boolean(run.hostReview?.allow_continue));
}

// Run reviews outside the model harness, with one global lock. The scheduler stays short.
// State-only/status/dry-run checks do not start a model or write to project files.
function driveReviews(runs, ctx) {
  if (LEGACY_REVIEW_TEST || CONTINUE_DISABLED || fs.existsSync(GLOBAL_PAUSE_FILE)) return false;
  let changed = false, registry;
  for (const run of runs) {
    if (run.source !== "app-builder" || run.paused || run.lock.fresh || run.corrupt || (run.frozen.checked && !run.frozen.ok)) continue;
    if (/^(ABORTED|CANCELLED|CANCELED)\b/i.test(run.status || "") || run.phase === "user-court") continue;
    const info = run.hostReview;
    if (info?.status === "needs_attention" && !info.retry_due) continue;
    const ready = /^REVIEW\b|REVIEW[-_ ]pending|^(DONE|MERGED|DELIVERED)\b/i.test(run.status || "") ||
      info?.status === "queued" || info?.retry_due || info?.interrupted;
    if (!ready || info?.completed || run.reviewGate?.legacyBaseline || (info?.approved && !/^(DONE|MERGED|DELIVERED)\b/i.test(run.status || ""))) continue;
    if (DRY_RUN) { logLine(`[dry-run] host review ${run.project}: backend=${info?.backend || run.reviewGate?.backend || "unknown"}`); continue; }
    if (ctx.sessionBusy.busy || ctx.sessionBusy.unknown || !ctx.gatewayUp || ctx.modelOutage || reviewService.runnerBusy()) continue;
    registry ||= listJobs();
    if (!registry.ok || registry.jobs.some((j) => jobIsLive(j) && (String(j.declarationKey || "").startsWith("auto-continue:") || String(j.name || "").startsWith("auto-continue: ")))) continue;
    try {
      if (info?.approved && info.final) {
        reviewService.setRunState(run.dir, "REVIEW_PASSED", "Dokonči dodacie podmienky a použi host command complete; samotný model nesmie zapísať DONE.");
        fs.writeFileSync(path.join(run.dir, ".app-builder", "continue-request.json"), JSON.stringify({ requested_at: iso(), reason: "Host final approval exists; complete delivery with host completion gate" }));
        changed = true; continue;
      }
      const request = reviewService.request(run.dir, { final: /^(DONE|MERGED|DELIVERED)\b/i.test(run.status || "") || Boolean(info?.final) });
      if (request.status === "queued") {
        const launched = TEST_MODE ? false : reviewService.launch(run.dir);
        logLine(`host-review:${run.project} queued=${request.request_id}; backend=${request.backend}; routes=${require("./app-builder-review").routePlan(request.backend, request.mode, request.implementer).join("→")}; launched=${launched}`);
        changed = true;
        break; // keep all projects and their continuations serialized
      }
    } catch (e) {
      reviewService.fail(run.dir, e);
      logLine(`host-review:${run.project} needs-attention: ${e.message}`); changed = true;
    }
  }
  return changed;
}

// Beh, ktorý continuator sám oživuje: aktívny stav (agent mal pracovať), nie poškodený súbor.
function isContinuable(run) {
  return run.phase === "active" && !run.corrupt;
}

// S continuatorom sledujeme aktívny build 72 h (oživujeme ho), bez neho platí pôvodných 12 h.
function maxStaleMinutes(run, continuatorOn) {
  return (continuatorOn && isContinuable(run) ? ACTIVE_MAX_STALE_HOURS : MAX_STALE_HOURS) * 60;
}

function stallAlertText(run, extraReason, unverifiedDelivery) {
  const sf = run.source === "solution-factory";
  const who = sf ? "Solution Factory" : "App Builder";
  const userCourt = run.phase === "user-court";
  const waiting = run.phase === "waiting";
  const head = userCourt
    ? `❓ ${who} čaká na tvoju odpoveď — ${run.project}`
    : waiting
      ? `⏸️ ${who} čaká na tvoje rozhodnutie — ${run.project}`
      : `🛑 ${who} sa nehýbe — ${run.project}`;
  const lines = [head, "", `Stav: ${run.status || "(run-state neuvádza status)"}`, `Bez zmeny už: ${humanAge(run.ageMinutes)}`];
  if (run.nextAction) lines.push(`Ďalší krok podľa run-state: ${run.nextAction}`);
  if (extraReason) lines.push(`Auto-pokračovanie neprebehlo: ${extraReason}`);
  if (userCourt && unverifiedDelivery) {
    lines.push(
      "",
      "Watchdog nezávisle overil gateway log a NENAŠIEL žiadny skutočný Telegram send k tejto",
      "otázke — agent nahlásil úspech, ale správa pravdepodobne odišla len do internej",
      "konverzácie, nie k tebe (presne toto sa stalo 2.9. aj 3.9.2026)."
    );
  } else if (userCourt) {
    lines.push(
      "",
      "Agent tvrdí, že ti napísal a čaká na odpoveď. Ak si od neho nič nedostal,",
      "správa sa nedoručila a beh by tu ležal donekonečna."
    );
  }
  lines.push(
    "",
    `Projekt: ${run.dir}`,
    "Rozrobená práca je v poriadku (git vetva + run-state.md).",
    userCourt
      ? `Ak si správu nedostal: napíš "continue ${run.dir}" a nech ti ju agent pošle znova.`
      : `Pokračovanie: napíš do Telegramu "continue ${run.dir}".`,
    "",
    "(Toto píše watchdog priamo, mimo agentov — takže to príde aj keď majú modely limit.)"
  );
  return lines.join("\n");
}

// D2) Overenie, že "čakám na teba" naozaj odišlo na Telegram — nie len do internal-ui.
// Agent vie nahlásiť úspech aj keď poslal do vlastnej internej konverzácie (žiadna chyba,
// žiadne message id) — presne to sa zopakovalo 2.9. (mockupy) aj 3.9.2026 (eskalácia opravného
// rozpočtu) napriek písanému pravidlu v skille. Namiesto dôvery v jeho vlastné `delivered_via`
// v run-state.md sa nezávisle overí v gateway DB, či niekto skutočne poslal správu na
// telegram:direct session_key. null = DB nedostupná/nečitateľná → neblokovať alarm falošne.
function telegramDeliveryVerifiedSince(sinceMs) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (_) {
    return null;
  }
  if (!fs.existsSync(SQLITE_FILE)) return null;
  let db;
  try {
    try {
      db = new DatabaseSync(SQLITE_FILE, { readOnly: true, timeout: 2000 });
    } catch (e) {
      if (e && /timeout/i.test(String(e.message))) db = new DatabaseSync(SQLITE_FILE, { readOnly: true });
      else throw e;
    }
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM audit_events WHERE action = 'tool.action.finished' AND status = 'succeeded' " +
          "AND session_key LIKE '%telegram:direct:%' AND occurred_at >= ?"
      )
      .get(sinceMs);
    return row ? Number(row.c) > 0 : null;
  } catch (_) {
    return null;
  } finally {
    try {
      if (db) db.close();
    } catch (_) {}
  }
}

// D3) "Písal do prázdna" — agent poslal správu na vlastný interný session_key a nikde inde
// nie je stopa po skutočnom doručení. Vracia { at, status } posledného takého volania, alebo null.
// Doplnok k D2: tá rieši len stavy čakania na Ivana, táto platí aj počas IMPLEMENTING.
function lastInternalMessageAttempt() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (_) {
    return null;
  }
  if (!fs.existsSync(SQLITE_FILE)) return null;
  let db;
  try {
    try {
      db = new DatabaseSync(SQLITE_FILE, { readOnly: true, timeout: 2000 });
    } catch (e) {
      if (e && /timeout/i.test(String(e.message))) db = new DatabaseSync(SQLITE_FILE, { readOnly: true });
      else throw e;
    }
    const internal = db
      .prepare(
        "SELECT occurred_at, status FROM audit_events WHERE action = 'tool.action.finished' " +
          "AND tool_name LIKE '%message%' AND session_key LIKE 'agent:app-builder:%' " +
          "ORDER BY occurred_at DESC LIMIT 1"
      )
      .get();
    if (!internal) return null;
    const real = db
      .prepare(
        "SELECT occurred_at FROM audit_events WHERE action = 'tool.action.finished' AND status = 'succeeded' " +
          "AND session_key LIKE '%telegram:direct:%' ORDER BY occurred_at DESC LIMIT 1"
      )
      .get();
    return {
      at: Number(internal.occurred_at),
      status: String(internal.status || ""),
      lastRealSendAt: real ? Number(real.occurred_at) : 0,
    };
  } catch (_) {
    return null;
  } finally {
    try {
      if (db) db.close();
    } catch (_) {}
  }
}

// Najnovší dôkaz o doručení cez outbox (watchdog doň zapisuje sent_at + message_id).
function lastOutboxDeliveryAt(runs) {
  let newest = 0;
  const dirs = new Set(runs.map((r) => r.dir));
  for (const dir of dirs) {
    const file = path.join(dir, ".app-builder", "outbox.sent.jsonl");
    if (!fs.existsSync(file)) continue;
    try {
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch (_) {
          continue;
        }
        const t = parseTime(row && row.sent_at);
        if (t !== null && t > newest) newest = t;
      }
    } catch (_) {}
  }
  return newest;
}

function lostReportAlerts(runs) {
  const attempt = lastInternalMessageAttempt();
  if (!attempt) return [];
  const ageMin = minutesAgo(attempt.at);
  // Grace: agent smie po zlyhaní ešte doplniť outbox. Strop: staré behy neriešime.
  if (ageMin < LOST_REPORT_GRACE_MINUTES || ageMin > LOST_REPORT_MAX_HOURS * 60) return [];
  // Akýkoľvek reálny dôkaz doručenia mladší než ten interný pokus = správa sa nestratila.
  const delivered = Math.max(attempt.lastRealSendAt || 0, lastOutboxDeliveryAt(runs));
  if (delivered >= attempt.at) return [];
  const failed = /fail|error/i.test(attempt.status);
  return [
    {
      key: "lost-report",
      fingerprint: `internal@${Math.floor(attempt.at / 1000)}`,
      text: [
        "📭 App Builder písal do prázdna — správa sa k tebe nedostala",
        "",
        `Pred ${humanAge(ageMin)} volal agent nástroj message na vlastnú internú konverzáciu`,
        failed
          ? "(volanie navyše zlyhalo) a nezapísal text do outboxu, takže ho nemá kto doručiť."
          : "(volanie síce 'uspelo', ale interná konverzácia NIE JE Telegram) a do outboxu nezapísal.",
        "Odvtedy neodišla ani jedna skutočná správa na Telegram.",
        "",
        "Watchdog nevie prečítať obsah stratenej správy — vidí len, že odišla do prázdna.",
        'Ak chceš vedieť, čo ti chcel povedať: napíš "status <projekt>" alebo si pozri',
        ".app-builder/run-state.md daného projektu (sekcie Slice status a Log).",
        "",
        "(Toto píše watchdog priamo, mimo agentov.)",
      ].join("\n"),
    },
  ];
}

// I) Review-gate: zmienka o nástroji ani plán NIE JE výsledok review. Pri GPT backende
// (a DEEP same-family review) musí byť pred slabším reviewerom doložený pokus o pinned
// Fable. Gate sa vyhodnotí už pri skene, pred continuatorom a zatvorením Solution Factory.
// Nikdy neexpiruje vekom DONE; dedup správ zabezpečuje stav watchdogu. Neoveruje pravdivosť
// modelom písaného denníka ani nezastaví už bežiaci worker — blokuje vlastné ďalšie akcie.

function reviewMode(dir, text) {
  const m = text.match(/verification[_ ]mode\s*[:=]?\s*(FAST|STANDARD|DEEP)/i);
  if (m) return m[1].toUpperCase();
  const handoff = readJson(path.join(dir, ".solution-factory", "confirmed_handoff.json"), null);
  const hm = handoff && typeof handoff.verification_mode === "string" ? handoff.verification_mode.toUpperCase() : null;
  return hm === "FAST" || hm === "STANDARD" || hm === "DEEP" ? hm : null;
}

function reviewContext(text) {
  const scope = text.match(/^[-*]?\s*Current slice:\s*(S\d+)\b/im);
  // Nové behy držia jedinú aktuálnu sekciu; staré historické review nesmie schváliť nový slice.
  const section = text.match(/^## (?:Phase 7(?:[^\r\n]*)|Current review)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/im);
  const current = section ? section[1] : text;
  const slice = scope ? scope[1].toUpperCase() : "run";
  const lines = current.split(/\r?\n/).filter((line) => {
    const tagged = line.match(/^\s*[-*]?\s*(S\d+)\b/i);
    return !tagged || !scope || tagged[1].toUpperCase() === slice;
  });
  return { slice, text: lines.join("\n") };
}

function reviewAttempts(text, slice) {
  const attempts = [];
  let malformed = false;
  for (const match of text.matchAll(/^[-*]?\s*Review attempt:\s*(.+)$/gim)) {
    try {
      const item = JSON.parse(match[1]);
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid record");
      if (typeof item.slice !== "string" || !/^(?:S\d+|run)$/.test(item.slice) ||
          !["codex", "fable", "same-family"].includes(item.route) || typeof item.outcome !== "string")
        throw new Error("missing review identity");
      if (item.slice === slice) attempts.push({ ...item, index: match.index });
    } catch (_) { malformed = true; }
  }
  return { attempts, malformed };
}

function fableAttemptRan(attempt) {
  const cmd = typeof attempt.command === "string" ? attempt.command : "";
  // Jednorazová read-only route zo worker-routing.md; samotné slovo Fable/acpx nestačí.
  if (attempt.route !== "fable" || !/\bacpx(?:\.cmd|\.exe)?\b/i.test(cmd) ||
      !/--model\s+claude-fable-5\b/i.test(cmd) || !/--approve-reads\b/.test(cmd) ||
      !/--non-interactive-permissions\s+deny\b/.test(cmd) || !/\bclaude\s+exec\b/.test(cmd) ||
      /--approve-all\b|\bresume\b|--resumeSessionId\b/i.test(cmd) ||
      typeof attempt.result !== "string" || !attempt.result.trim()) return false;
  if (attempt.outcome === "passed") return attempt.exit_code === 0;
  if (attempt.outcome === "unavailable") return Number.isInteger(attempt.exit_code) && attempt.exit_code !== 0;
  return attempt.outcome === "timeout" && attempt.exit_code === null &&
    Number.isFinite(attempt.duration_ms) && attempt.duration_ms > 0;
}

function checkReviewGate(dir, text, status) {
  const mode = reviewMode(dir, text);
  const gate = { blocked: false, mode, backend: "unknown", requiredRoute: null, code: null };
  if ((mode !== "STANDARD" && mode !== "DEEP") || /^(ABORTED|CANCELLED|CANCELED)\b/i.test(status || "")) return gate;
  const context = reviewContext(text);
  const { attempts, malformed } = reviewAttempts(context.text, context.slice);
  // Iba aktuálna deklarácia tohto projektu, nikdy globálny sessions.json/config (ten môže
  // patriť inému projektu alebo inému času). Backend z review záznamu má prednosť.
  const header = text.split(/^## /m)[0];
  const model = header.match(/^[-*]?\s*(?:Orchestrator (?:model|backend)|Active backend|Backend|Model shepherding(?: this run)?):\s*(.+)$/im);
  const recorded = attempts.filter((a) => typeof a.orchestrator_model === "string").at(-1);
  const backendText = recorded ? recorded.orchestrator_model : model ? model[1] : "";
  const modelIds = backendText.match(/\b(?:gpt-[\w.-]+|claude-[\w.-]+)\b/gi);
  if (modelIds) gate.backend = modelIds.at(-1).toLowerCase();
  const structuralDecline = /(?:nested[- ]codex[^\n]*declin|codex[^\n]*["']?status["']?\s*:\s*["']declined["'])/i.test(context.text);
  const gpt = gate.backend.startsWith("gpt-") || (!modelIds && /^(?:GPT|codex)\b/i.test(backendText)) ||
    (!recorded && structuralDecline);
  if (gpt && gate.backend === "unknown") gate.backend = structuralDecline ? "GPT (nested-codex decline)" : "GPT fallback";
  gate.requiredRoute = gpt ? "fable" : "codex";

  const handoff = readJson(path.join(dir, ".solution-factory", "confirmed_handoff.json"), null);
  const implementer = header.match(/^[-*]?\s*Implementer:\s*(codex|claude)\b/im);
  const codexImplemented = implementer ? implementer[1].toLowerCase() === "codex" : handoff?.roles?.implementer === "codex";
  const prose = context.text.split(/\r?\n/).filter((line) => !/^[-*]?\s*Review attempt:/i.test(line));
  const notExecuted = /\b(?:planned|pending|not run|not attempted|never ran|will|must|next|skip(?:ped)?)\b/i;
  const weakClaim = prose.some((line) =>
    /same[- ]family|fresh[- ]Claude|fresh Claude subagent|Claude subagent.*(?:review|adversarial)/i.test(line) &&
    /review|reviewer/i.test(line) && !notExecuted.test(line));
  const lastAttempt = attempts.at(-1);
  const weakAttempt = attempts.findLast((a) => a.route === "same-family" && ["passed", "running"].includes(a.outcome));
  const correctedByFable = lastAttempt?.outcome === "passed" && fableAttemptRan(lastAttempt);
  const weakSelected = !correctedByFable && (weakAttempt || weakClaim ||
    (gpt && prose.some((line) => /adversarial.*(?:PASS|0 BLOCKER)/i.test(line) && !notExecuted.test(line))));
  const deny = (code, reason) => Object.assign(gate, { blocked: true, code, reason });
  if (malformed) return deny("review-evidence-invalid", "Nečitateľný Review attempt; oprav záznam podľa skutočného výsledku.");
  if (!codexImplemented && weakSelected && (gpt || mode === "DEEP")) {
    gate.requiredRoute = "fable";
    const before = weakAttempt ? weakAttempt.index : context.text.search(/same[- ]family|fresh[- ]Claude|Claude subagent|adversarial/i);
    const fable = attempts.find((a) => a.index < before && fableAttemptRan(a));
    if (!fable) return deny("fable-before-same-family", "Slabšia same-family review bez doloženého predchádzajúceho pokusu o Fable v aktuálnom slice. Spusti krok 2 cez fresh read-only acpx; do jeho výsledku REVIEW-pending.");
  }
  // Zachovanie starých úspešných záznamov, ale NIE samotných názvov nástrojov, plánov či chýb.
  const passed = prose.some((line) =>
    /(?:codex review|fable review|independent.*review|adversarial.*review|re-review)[\s:*—–,-]*(?:PASS(?:ED)?\b|APPROVE(?:D)?\b|(?:0|NO) BLOCKER\b)/i.test(line) &&
    !/\b(?:pending|planned|not run|not attempted|never ran|skip(?:ped)?|declined|hung|unavailable|failed|will|must)\b/i.test(line));
  const recordedPass = [lastAttempt].some((a) => a && a.outcome === "passed" && a.exit_code === 0 &&
    typeof a.result === "string" && /\bPASS(?:ED)?\b|\bAPPROVE(?:D)?\b|\b0 BLOCKER\b/i.test(a.result) &&
    (a.route === "fable" ? fableAttemptRan(a) :
      ["codex", "same-family"].includes(a.route) && typeof a.session_id === "string" && a.session_id.trim()));
  const reviewPassed = attempts.length ? recordedPass : passed;
  if (/^(DONE|MERGED|DELIVERED)\b/i.test(status || "") && !reviewPassed)
    return deny("review-missing", "Build je označený ako hotový bez stopy po nezávislom review s výsledkom. Neúspešný príkaz ani plán review gate nesplní.");
  if (/REVIEW[-_ ]pending|needs[-_ ]attention/i.test(status || "") && !reviewPassed)
    return deny("review-pending", "Nezávislá review zostáva nedokončená; beh vyžaduje pozornosť a nesmie byť DONE.");
  return gate;
}

function reviewGateAlerts(runs) {
  const alerts = [];
  for (const run of runs) {
    if (run.source !== "app-builder") continue;
    const gate = run.reviewGate;
    if (!gate || !gate.blocked) continue;
    alerts.push({
      key: `review-gate:${run.project}`,
      fingerprint: `${gate.code}:${shortHash(JSON.stringify(gate))}:${run.status}@${Math.floor(run.mtimeMs / 1000)}`,
      text: [
        `🔎 Phase 7 review gate BLOKOVANÝ — ${run.project}`,
        "",
        `Režim: ${gate.mode}; backend: ${gate.backend}; pravidlo: ${gate.code}.`,
        gate.reason,
        "",
        `Projekt: ${run.dir}`,
        run.hostReview?.allow_continue ? "Host runner vrátil konkrétne chyby; continuator smie spustiť iba ich opravu, nie DONE." :
          "Uzavretie Solution Factory je zablokované. Host runner musí vykonať nezávislú review; text PASS v run-state nestačí.",
        "",
        "(Toto píše watchdog priamo, mimo agentov.)",
      ].join("\n"),
    });
  }
  return alerts;
}

function stalledRunAlerts(runs, continuatorOn) {
  const alerts = [];
  for (const run of runs) {
    if (run.phase === "terminal" || run.phase === "delegated" || run.phase === "closable") continue;
    // Aktívne behy oživuje continuator (a eskaluje/alarmuje sám); alarm tu ostáva len keď je vypnutý.
    if (continuatorOn && isContinuable(run)) continue;
    const userCourt = run.phase === "user-court";
    const waiting = run.phase === "waiting";
    let limit = userCourt ? USER_COURT_STALL_MINUTES : waiting ? WAITING_STALL_MINUTES : STALL_MINUTES;
    let unverifiedDelivery = false;
    if (userCourt) {
      const verified = telegramDeliveryVerifiedSince(run.mtimeMs - USER_COURT_VERIFY_LOOKBACK_MINUTES * 60_000);
      if (verified === false) {
        limit = USER_COURT_UNVERIFIED_STALL_MINUTES;
        unverifiedDelivery = true;
      }
    }
    if (run.ageMinutes < limit) continue;
    // Nad hornou hranicou už nejde o zaseknutý beh, ale o opustený projekt.
    if (run.ageMinutes > maxStaleMinutes(run, continuatorOn)) continue;
    const sf = run.source === "solution-factory";
    // SF beh má vlastný kľúč, aby sa nebil s app-builder behom v tom istom projekte.
    const key = sf ? `stalled:sf:${run.project}` : `stalled:${run.project}`;
    const fingerprint = `${run.status || "no-status"}@${Math.floor(run.mtimeMs / 1000)}`;
    alerts.push({ key, fingerprint, text: stallAlertText(run, null, unverifiedDelivery) });
  }
  return alerts;
}

// ------------------------------------------------- D/E) continuator

// Beží ťah app-buildera? Zdroj 1: audit_events/task_runs v SQLite gateway (read-only).
// null = DB nedostupná.
function sqliteBusy() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (_) {
    return null;
  }
  if (!fs.existsSync(SQLITE_FILE)) return null;
  let db;
  try {
    try {
      db = new DatabaseSync(SQLITE_FILE, { readOnly: true, timeout: 2000 }); // busy timeout počas WAL checkpointu
    } catch (e) {
      if (e && /timeout/i.test(String(e.message))) db = new DatabaseSync(SQLITE_FILE, { readOnly: true });
      else throw e;
    }
    const running = db
      .prepare(
        "SELECT COUNT(*) AS c FROM task_runs WHERE (agent_id = 'app-builder' OR owner_key LIKE 'agent:app-builder%' " +
          "OR child_session_key LIKE 'agent:app-builder%') AND status IN ('queued', 'running')"
      )
      .get();
    if (running && Number(running.c) > 0) return { busy: true, answered: true, reason: `task_runs running=${running.c}` };
    const last = db
      .prepare(
        "SELECT occurred_at, action, status, session_key FROM audit_events WHERE session_key LIKE 'agent:app-builder:%' " +
          "ORDER BY occurred_at DESC LIMIT 1"
      )
      .get();
    if (!last) return { busy: false, answered: true, reason: "audit: žiadne udalosti" };
    const ageMin = (now() - Number(last.occurred_at)) / 60000;
    if (String(last.action) !== "agent.run.finished" && ageMin < BUSY_WINDOW_MINUTES) {
      return { busy: true, answered: true, reason: `audit: ${last.action} pred ${Math.round(ageMin)} min (${last.session_key})` };
    }
    return { busy: false, answered: true, reason: `audit: ${last.action} pred ${Math.round(ageMin)} min` };
  } catch (e) {
    return null;
  } finally {
    try {
      if (db) db.close();
    } catch (_) {}
  }
}

// Zdroj 2: sessions.json — busy IBA pri status "running" (killed/timeout/failed/done = voľné),
// pre KAŽDÚ session app-buildera (main, cron:*, subagent:*), ohraničené limitom ťahu.
function sessionsBusy() {
  const store = readJson(SESSIONS_FILE, null);
  if (!store || typeof store !== "object") return { busy: false, unknown: true, reason: "sessions.json nečitateľný" };
  const bound = (CONTINUE_TURN_TIMEOUT_SECONDS + 600) * 1000;
  for (const [key, entry] of Object.entries(store)) {
    if (!key.startsWith("agent:app-builder:") || !entry || typeof entry !== "object") continue;
    const status = typeof entry.status === "string" ? entry.status.toLowerCase() : "";
    if (status !== "running") continue;
    const started = parseTime(entry.startedAt);
    const updated = parseTime(entry.updatedAt);
    const ref = Math.max(started || 0, updated || 0);
    if (ref && now() - ref > bound) continue; // dávno "running" bez konca = mŕtvy záznam
    return { busy: true, reason: `session ${key} status=running` };
  }
  return { busy: false, reason: "žiadna session running" };
}

// Výsledok nesie aj kvalitu dôkazu: dbAnswered = SQLite odpovedala (silný zdroj),
// unknown = ani DB, ani sessions.json sa nedali prečítať (žiadny dôkaz o ničom).
function sessionBusy() {
  const fromDb = sqliteBusy();
  if (fromDb && fromDb.busy) return Object.assign({}, fromDb, { dbAnswered: true });
  const fromSessions = sessionsBusy();
  if (fromSessions.busy) return Object.assign({}, fromSessions, { dbAnswered: fromDb !== null });
  const base = fromDb || fromSessions;
  return Object.assign({}, base, {
    dbAnswered: fromDb !== null,
    unknown: fromDb === null && Boolean(fromSessions.unknown),
    reason: fromDb ? base.reason : `${base.reason}; DB nedostupná`,
  });
}

function runCli(cliArgs) {
  const out = execFileSync(NODE_BIN, [OPENCLAW_CLI].concat(cliArgs), {
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  const text = String(out || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {}
  // CLI občas pridá riadok(y) pred JSON (aj so zátvorkou, napr. "[cron] …") — skús od posledného
  // riadku, ktorý začína zátvorkou, smerom dozadu.
  const lines = text.split(/\r?\n/);
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!/^[\[{]/.test(lines[k].trim())) continue;
    try {
      return JSON.parse(lines.slice(k).join("\n"));
    } catch (_) {}
  }
  throw new Error(`CLI nevrátilo JSON: ${text.slice(0, 160)}`);
}

function declarationKey(project) {
  return `auto-continue:${project}`;
}

// Register cron jobov (jedno volanie na cyklus). {ok, jobs, error}
function listJobs() {
  try {
    const res = runCli(["cron", "list", "--all", "--json"]);
    const jobs = Array.isArray(res) ? res : res && Array.isArray(res.jobs) ? res.jobs : [];
    if (res && res.hasMore) logLine("cron list: hasMore=true — zoznam je stránkovaný, vidím len prvú stranu");
    return { ok: true, jobs };
  } catch (e) {
    return { ok: false, jobs: [], error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

function projectJobs(jobs, project) {
  const key = declarationKey(project);
  const name = `auto-continue: ${project}`;
  return jobs.filter((j) => j && (j.declarationKey === key || j.name === name));
}

// Živý job = ešte pobeží alebo beží (jednorazový job sa po úspechu maže, po chybe vypne).
function jobIsLive(job) {
  const st = job.state || {};
  if (String(job.status || "").toLowerCase() === "running" || st.runningAtMs) return true;
  return job.enabled !== false;
}

function jobOutcome(job) {
  const st = job.state || {};
  const err = st.lastError || st.lastDiagnosticSummary || null;
  const status = st.lastRunStatus || job.status || null;
  return err ? `error: ${String(err).slice(0, 200)}` : status ? String(status) : "neznámy";
}

function removeJob(jobId) {
  try {
    runCli(["cron", "rm", jobId, "--json"]);
    return true;
  } catch (e) {
    logLine(`cron rm ${jobId} zlyhalo: ${String(e && e.message ? e.message : e).slice(0, 120)}`);
    return false;
  }
}

function continueMessage(run, attempt, reason) {
  return [
    `continue ${run.dir}`,
    `— automatické pokračovanie (continuator, pokus ${attempt}, dôvod: ${reason}).`,
    "Každý ťah začína bez pamäte: 1) prečítaj .app-builder/run-state.md, .solution-factory/run-state.json, `git status` a `git log -5`;",
    "2) ak je stav DONE/ABORTED alebo existuje čerstvý cudzí .app-builder/lock.json, odpovedz iba `NO_REPLY` a nič nerob;",
    "3) inak zapíš lock.json a nadviaž presne tam, kde beh skončil — nič neopakuj, hotové slice nestavaj znova, zmrazené spec/UI súbory nemeň, žiadne git reset/checkout --/rebase/force-push/git init;",
    "4) rozpracovanú prácu commituj priebežne (`wip:` commit pred každou verifikáciou, najneskôr po ~15 min), aby sa pokrok dal odčítať z HEAD;",
    "5) reporty používateľovi najprv zapíš do .app-builder/outbox.jsonl; watchdog ich doručí príjemcovi z konfigurácie;",
    "6) na konci ťahu aktualizuj Status:/Next action:, zmaž lock.json a kým beh nie je DONE/ABORTED, zapíš .app-builder/continue-request.json (requested_at, not_before, reason, expected_head);",
    "7) záverečná odpoveď = 1–3 vety pre Ivana o tom, čo sa v tomto ťahu urobilo (doručí sa mu), alebo `NO_REPLY`, ak nie je čo hlásiť.",
    `8) Phase 7 riadi host: node "${path.join(__dirname, "app-builder-review.js")}" request --project "${run.dir}" --slice <aktuálne S číslo> --backend <skutočný runtime model> (pre finálnu appku pridaj --final). Po request uvoľni lock a skonči ťah; watchdog spustí testy a review mimo modelového sandboxu.`,
    run.hostReview?.managed ? `Host review: ${run.hostReview.status}. Prečítaj ${run.hostReview.state_file} a ${run.hostReview.review_file}. Pri changes_requested alebo stale po oprave resumni EXISTUJÚCI Claude Code worker cez zaznamenaný resumeSessionId a rovnaké cwd; oprav iba doložené chyby a znova požiadaj host o review. Neobchádzaj testy, neresetuj počítadlá ani nevymýšľaj výsledky. Pri approved dokonči slice; finálny DONE smie zapísať iba príkaz node "${path.join(__dirname, "app-builder-review.js")}" complete --project "${run.dir}" po splnení ostatných dodacích podmienok. Zohľadni všetky stále platné schválenia a čakanie na používateľa.` :
      "Po implementácii a každej oprave je host review povinná; rodič ani implementátor neschvaľuje sám seba.",
  ].join(" ");
}

// Spustí `continue` ako jednorazový cron ťah cez skutočné CLI. Vracia {ok, jobId, error, updated}.
function triggerContinue(run, attempt, reason) {
  const to = chatIdOrNull();
  const delivery = to
    ? ["--announce", "--channel", "telegram", "--to", to, "--best-effort-deliver"]
    : ["--no-deliver"];
  const cliArgs = [
    "cron",
    "add",
    "--name",
    `auto-continue: ${run.project}`,
    "--declaration-key",
    declarationKey(run.project),
    "--agent",
    "app-builder",
    "--session",
    "session:main",
    "--at",
    "+5s",
    "--message",
    continueMessage(run, attempt, reason),
    ...delivery,
    "--delete-after-run",
    "--timeout-seconds",
    String(CONTINUE_TURN_TIMEOUT_SECONDS),
    "--json",
  ];
  try {
    let res = runCli(cliArgs);
    let job = res && (res.job || res);
    if (job && job.enabled === false && job.id) {
      // `cron add` s rovnakým declaration-key len upsertol starý VYPNUTÝ job (gateway vypne
      // jednorazový job, ktorého ťah skončil chybou) a enabled:false nechal. Bežný cyklus také
      // joby uprace vopred, ale --continue-now nie — a cyklus sa k upratovaniu nedostane, keď ho
      // skôr zastaví výpadok modelov/gateway (3.9.2026: ručné spustenie po výpadku 2× zlyhalo).
      // Samoliečba: rm + jeden nový pokus.
      logLine(`continue ${run.project}: cron add upsertol vypnutý job ${String(job.id).slice(0, 8)} — mažem a skúšam znova`);
      if (removeJob(job.id)) {
        res = runCli(cliArgs);
        job = res && (res.job || res);
      }
    }
    const jobId = job && job.id;
    const updated = Boolean(res && res.created === false && res.updated);
    if (job && job.enabled === false) return { ok: false, error: "cron add vrátil vypnutý job (declaration-key prepísal starý vypnutý job) — rm pred add zlyhalo" };
    if (!jobId && !updated) return { ok: false, error: `CLI nevrátilo id jobu: ${JSON.stringify(res).slice(0, 200)}` };
    return { ok: true, jobId: jobId ? String(jobId) : null, updated };
  } catch (e) {
    const detail = (e && (e.stderr || e.stdout || e.message) ? String(e.stderr || e.stdout || e.message) : String(e)).trim();
    return { ok: false, error: detail.slice(0, 300) };
  }
}

function historyDir(run) {
  const dir = path.join(run.dir, ".app-builder", "history");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

function stamp() {
  return iso().replace(/[:.]/g, "-");
}

// Presun žiadosti: pred CLI na .pending (aby sa nespustila dvakrát), po úspechu do history/.
function moveRequest(run, fromFile, kind) {
  try {
    if (kind === "pending") {
      const target = path.join(run.dir, ".app-builder", `continue-request.pending-${stamp()}.json`);
      fs.renameSync(fromFile, target);
      return target;
    }
    const target = path.join(historyDir(run), `continue-request.${kind}-${stamp()}.json`);
    fs.renameSync(fromFile, target);
    return target;
  } catch (e) {
    logLine(`continue ${run.project}: presun žiadosti (${kind}) zlyhal: ${e.message}`);
    return null;
  }
}

function pruneTriggers(st) {
  const cutoff = now() - 24 * 60 * 60_000;
  st.triggers = (st.triggers || []).filter((t) => t > cutoff); // spustenia bez pokroku (nuluje sa pokrokom)
  st.allTriggers = (st.allTriggers || []).filter((t) => t > cutoff); // všetky spustenia (nikdy sa nenuluje)
  return st.triggers.length;
}

function progressFingerprint(run) {
  const status = (run.status || "no-status").toUpperCase().split(/\s+/)[0];
  return `${status}#${run.head || "-"}`;
}

function writePause(run, reason) {
  try {
    fs.mkdirSync(path.join(run.dir, ".app-builder"), { recursive: true });
    fs.writeFileSync(path.join(run.dir, ".app-builder", "PAUSE"), `${iso()} ${reason}\n`);
    return true;
  } catch (e) {
    logLine(`PAUSE ${run.project}: nemôžem zapísať: ${e.message}`);
    return false;
  }
}

// Rozhodne a (mimo dry-run) vykoná auto-continue pre všetky oživiteľné behy.
// Vracia alerty (info o zásahu, eskalácia, pripomienky, opustený projekt, pozastavenie).
function continuator(runs, state, ctx) {
  const alerts = [];
  if (!LEGACY_REVIEW_TEST && reviewService.runnerBusy()) return alerts;
  if (!state.continues) state.continues = {};
  const paused = fs.existsSync(GLOBAL_PAUSE_FILE);
  const seen = new Set();
  let jobsCache = null;
  const jobs = () => {
    if (!jobsCache) jobsCache = listJobs();
    return jobsCache;
  };
  let triggeredThisCycle = false;

  for (const run of runs) {
    // Výslovná žiadosť agenta (continue-request.json) platí pre každý otvorený beh — aj WAITING
    // (napr. čakanie na reset limitu s not_before). Stall auto-continue len pre aktívne stavy.
    if (!canContinueThroughReview(run)) continue;
    if (run.hostReview?.status === "running" || run.hostReview?.status === "queued") continue;
    const explicit =
      Boolean(run.continueRequest && run.continueRequest.due) &&
      !run.corrupt &&
      run.phase !== "terminal" &&
      run.phase !== "delegated" &&
      run.phase !== "closable";
    if ((!isContinuable(run) && !explicit) || seen.has(run.project)) continue;
    seen.add(run.project);
    const key = run.project;
    const fingerprint = progressFingerprint(run);
    const staleFp = `${run.status || "no-status"}@${Math.floor(run.mtimeMs / 1000)}`;
    let st = state.continues[key] || { attempts: 0, lastFingerprint: null, episodeStartedAt: null, triggers: [] };

    // Pokrok (zmena Status alebo HEAD) → nová epizóda, počítadlá od nuly.
    if (st.lastFingerprint && st.lastFingerprint !== fingerprint) {
      logLine(`continue ${key}: pokrok (${st.lastFingerprint} → ${fingerprint}), počítadlá vynulované`);
      st = { attempts: 0, lastFingerprint: fingerprint, episodeStartedAt: null, triggers: [], allTriggers: st.allTriggers || [], noProgressFast: 0 };
    }
    st.lastFingerprint = fingerprint;
    state.continues[key] = st;

    const req = run.continueRequest;
    const fastPath = explicit;
    const stale = isContinuable(run) && run.ageMinutes >= CONTINUE_AFTER_MINUTES;
    if (!fastPath && !stale) continue;

    // Opustený beh: 72 h bez pokroku — posledný alarm, ďalej nič.
    if (!fastPath && run.ageMinutes > maxStaleMinutes(run, true)) {
      alerts.push({
        key: `abandoned:${key}`,
        fingerprint: staleFp,
        text: [
          `🪦 Rozrobený beh je opustený — ${key}`,
          "",
          `Stav: ${run.status || "(bez statusu)"}, bez pokroku ${humanAge(run.ageMinutes)}.`,
          `Auto-pokračovanie som skúšal ${st.attempts}×, ďalej ho už neskúšam.`,
          `Projekt: ${run.dir}`,
          `Ak chceš pokračovať, napíš "continue ${run.dir}" alebo projekt uzavri (Status: ABORTED).`,
        ].join("\n"),
      });
      continue;
    }

    // G) Zmrazené súbory: porušenie = pauza + správa, nič nespúšťať.
    if (run.frozen && run.frozen.checked && !run.frozen.ok) {
      const detail = run.frozen.violations.map((v) => `${v.file}: očakávané ${String(v.expected).slice(0, 12)}…, teraz ${String(v.actual).slice(0, 12)}…`).join("; ");
      if (!run.paused && !DRY_RUN) writePause(run, `zmrazené súbory sa zmenili: ${detail}`);
      alerts.push({
        key: `frozen:${key}`,
        fingerprint: run.frozen.violations.map((v) => v.actual).join("+"),
        text: [
          `🧊 Zmrazený spec sa zmenil — ${key} pozastavený`,
          "",
          `Hash spec/UI súboru už nesedí s confirmed_handoff.json: ${detail}.`,
          "Auto-pokračovanie som vypol (.app-builder/PAUSE), aby ďalší ťah nestaval podľa iného zadania.",
          `Skontroluj \`git diff\` v ${run.dir}; ak je zmena úmyselná, aktualizuj handoff a zmaž PAUSE.`,
        ].join("\n"),
      });
      logLine(`skip continue ${key} (zmrazené súbory: ${detail})`);
      continue;
    }

    // Prekážky, pri ktorých beh NESMIE ostať ticho: po 45 min bez zmeny posielame klasický alarm.
    const blocked = paused
      ? "globálna pauza (app-builder-continuator.PAUSE)"
      : run.paused
        ? "projekt je pozastavený (.app-builder/PAUSE)"
        : CONTINUE_DISABLED
          ? "auto-pokračovanie vypnuté (WATCHDOG_DISABLE_CONTINUE)"
          : !ctx.gatewayUp
            ? "gateway neodpovedá"
            : ctx.modelOutage
              ? "výpadok modelov"
              : null;
    if (blocked) {
      logLine(`skip continue ${key} (${blocked})`);
      if (run.ageMinutes >= STALL_MINUTES) {
        alerts.push({ key: `stalled:${key}`, fingerprint: staleFp, text: stallAlertText(run, blocked) });
      }
      continue;
    }

    // Primárny zámok: živý cron job auto-continue (pre KTORÝKOĽVEK projekt — všetky bežia
    // v session:main, teda serializovane; ďalší by sa len zaradil do fronty).
    const reg = jobs();
    const mine = reg.ok ? projectJobs(reg.jobs, key) : [];
    const live = reg.ok ? reg.jobs.filter((j) => j && (String(j.declarationKey || "").startsWith("auto-continue:") || String(j.name || "").startsWith("auto-continue: ")) && jobIsLive(j)) : [];
    if (!reg.ok) logLine(`continue ${key}: cron list zlyhal (${reg.error}) — spolieham sa na lock/session`);
    const dead = mine.filter((j) => !jobIsLive(j));
    let rmFailed = false;
    for (const j of dead) {
      // Vypnutý job = predošlý pokus skončil chybou → zapíš dôvod a uprac. Bez úspešného rm by
      // `cron add` s rovnakým declaration-key len prepísal vypnutý job (ostal by enabled:false).
      st.prevJobResult = jobOutcome(j);
      logLine(`continue ${key}: predošlý job ${String(j.id).slice(0, 8)} skončil: ${st.prevJobResult}`);
      if (!DRY_RUN && !removeJob(j.id)) rmFailed = true;
    }
    if (rmFailed) {
      logLine(`skip continue ${key} (vypnutý job sa nepodarilo odstrániť — skúsim v ďalšom cykle)`);
      continue;
    }
    if (st.lastJobId && reg.ok && !mine.some((j) => j.id === st.lastJobId) && !dead.length && !st.lastJobResult) {
      st.lastJobResult = "ran"; // zmizol = úspešne dobehol (delete-after-run)
    }
    if (live.length) {
      const j = live[0];
      logLine(`skip continue ${key} (beží/čaká cron job ${String(j.id).slice(0, 8)} ${j.name} status=${j.status || "?"})`);
      if (run.ageMinutes >= STUCK_BUSY_MINUTES) {
        alerts.push({ key: `stalled:${key}`, fingerprint: staleFp, text: stallAlertText(run, `cron job ${String(j.id).slice(0, 8)} beží/čaká už dlho`) });
      }
      continue;
    }
    if (run.lock.fresh) {
      // Sirota: lock je "čerstvý", ale jeho vlastník už nebeží (žiadny živý job, žiadna bežiaca
      // session, audit ticho). Stalo sa 2.9.2026 17:42 — opus zapísal lock, CLI padlo, fallback
      // gpt-5.6-sol v čistom kontexte uvidel vlastný lock a skončil "iný ťah beží". Bez tohto
      // pravidla by každý ďalší continue robil to isté až do vypršania locku.
      // Sirotu vyhlásime len na základe kladného dôkazu: register jobov sa dal prečítať a SQLite
      // audit (silný zdroj) odpovedal "nič nebeží". Bez DB odpovede lock rešpektujeme.
      const orphan = reg.ok && !ctx.sessionBusy.busy && ctx.sessionBusy.dbAnswered === true;
      if (orphan) {
        logLine(`continue ${key}: lock.json bez živého vlastníka (${JSON.stringify(run.lock.lock).slice(0, 100)}) → odkladám do history/ a pokračujem`);
        if (!DRY_RUN) {
          try {
            fs.renameSync(path.join(run.dir, ".app-builder", "lock.json"), path.join(historyDir(run), `lock.orphaned-${stamp()}.json`));
          } catch (e) {
            logLine(`continue ${key}: sirotu lock.json sa nepodarilo odložiť: ${e.message}`);
            continue;
          }
        }
      } else {
        logLine(`skip continue ${key} (lock.json čerstvý do ${iso(run.lock.until)}${ctx.sessionBusy.dbAnswered ? "" : ", DB o behu neodpovedala"}: ${JSON.stringify(run.lock.lock).slice(0, 120)})`);
        if (run.ageMinutes >= STUCK_BUSY_MINUTES) {
          alerts.push({ key: `stalled:${key}`, fingerprint: staleFp, text: stallAlertText(run, "lock.json je stále čerstvý") });
        }
        continue;
      }
    }
    if (ctx.sessionBusy.busy) {
      logLine(`skip continue ${key} (beží ťah: ${ctx.sessionBusy.reason})`);
      if (run.ageMinutes >= STUCK_BUSY_MINUTES) {
        alerts.push({ key: `stalled:${key}`, fingerprint: staleFp, text: stallAlertText(run, `beží ťah (${ctx.sessionBusy.reason})`) });
      }
      continue;
    }
    if (triggeredThisCycle) {
      logLine(`skip continue ${key} (v tomto cykle už bol spustený iný projekt)`);
      continue;
    }

    // Denný strop: ochrana pred slučkou, ktorá páli tokeny bez pokroku (počítadlo sa nuluje
    // pokrokom) + absolútna poistka proti "falošnému pokroku" (nikdy sa nenuluje).
    const noProgressCount = pruneTriggers(st);
    const capHit = noProgressCount >= DAILY_TRIGGER_CAP ? `${noProgressCount} spustení bez pokroku` : st.allTriggers.length >= HARD_TRIGGER_CAP ? `${st.allTriggers.length} spustení celkovo` : null;
    if (capHit) {
      logLine(`skip continue ${key} (denný strop: ${capHit})`);
      if (!DRY_RUN) writePause(run, `denný strop auto-pokračovaní za 24 h (${capHit})`);
      alerts.push({
        key: `continue-budget:${key}`,
        fingerprint: `episode-${st.episodeStartedAt || "x"}-${noProgressCount}-${st.allTriggers.length}`,
        text: [
          `⛔ Denný strop auto-pokračovania — ${key} pozastavený`,
          "",
          `Za 24 h: ${capHit} (limit ${DAILY_TRIGGER_CAP} bez pokroku / ${HARD_TRIGGER_CAP} celkovo), stav: ${fingerprint}.`,
          "Vytvoril som .app-builder/PAUSE. Pozri run-state.md a posledné správy agenta;",
          `pokračovanie: zmaž PAUSE alebo napíš "continue ${run.dir}" s inštrukciou, čo má robiť inak.`,
        ].join("\n"),
      });
      continue;
    }

    // Rýchla cesta: expected_head už neplatí → iný ťah medzitým pokročil, žiadosť je stará.
    if (fastPath && req.request && req.request.expected_head && run.head && !String(run.head).startsWith(String(req.request.expected_head).slice(0, 12)) && !String(req.request.expected_head).startsWith(String(run.head))) {
      logLine(`continue ${key}: žiadosť má expected_head ${req.request.expected_head}, HEAD je ${run.head} → stará žiadosť, ignorujem`);
      if (!DRY_RUN) moveRequest(run, req.file, "stale");
      continue;
    }

    // Odstup medzi pokusmi.
    const sinceLast = st.lastTriggerAt ? now() - st.lastTriggerAt : Infinity;
    if (fastPath) {
      if (sinceLast < FAST_MIN_GAP_MINUTES * 60_000) {
        logLine(`skip continue ${key} (continue-request, posledný pokus pred ${Math.round(sinceLast / 60000)} min)`);
        continue;
      }
      // Koľko rýchlych pokračovaní BEZ pokroku by to bolo vrátane tohto (prospektívne).
      const nextNoProgress = st.lastFastFingerprint === fingerprint ? (st.noProgressFast || 0) + 1 : 0;
      if (nextNoProgress >= FAST_NOPROGRESS_MAX) {
        logLine(`skip continue ${key} (${nextNoProgress}. rýchle pokračovanie bez pokroku — žiadosť odkladám, ďalej platí stall cesta)`);
        // Žiadosť odlož, inak by ležiaci súbor navždy blokoval stall cestu (pokusy každé 3 h, alarmy).
        if (!DRY_RUN) moveRequest(run, req.file, "exhausted");
        if (!st.escalatedAt) {
          st.escalatedAt = now();
          st.lastRemindAt = now();
          alerts.push({ key: `continue-failed:${key}`, fingerprint: `fast-${st.episodeStartedAt || now()}`, alwaysSend: true, text: escalationText(run, st, false, `${nextNoProgress} ťahy po sebe skončili bez nového commitu ani zmeny stavu`) });
        }
        continue;
      }
    } else if (st.attempts >= CONTINUE_MAX_ATTEMPTS) {
      if (sinceLast < CONTINUE_SLOW_MINUTES * 60_000) {
        logLine(`skip continue ${key} (po eskalácii, ďalší pokus o ${Math.round((CONTINUE_SLOW_MINUTES * 60_000 - sinceLast) / 60000)} min)`);
        continue;
      }
    } else {
      const wait = CONTINUE_BACKOFF_MINUTES[st.attempts] * 60_000;
      if (sinceLast < wait) {
        logLine(`skip continue ${key} (backoff, ďalší pokus o ${Math.round((wait - sinceLast) / 60000)} min)`);
        continue;
      }
    }

    const attempt = fastPath ? Math.max(1, st.attempts || 1) : st.attempts + 1;
    const reason = fastPath
      ? `agent požiadal o pokračovanie (${(req.request && req.request.reason) || "continue-request.json"})`
      : `run-state bez zmeny ${humanAge(run.ageMinutes)}` +
        (st.prevJobResult && String(st.prevJobResult).startsWith("error") ? `; predošlý pokus: ${st.prevJobResult}` : "");

    if (DRY_RUN) {
      logLine(`[dry-run] spustil by som continue ${key} (pokus ${attempt}, ${reason})`);
      continue;
    }

    // Žiadosť najprv odlož ako .pending — keby CLI vypršalo po tom, čo gateway job prijala,
    // ďalší cyklus ju nesmie spustiť druhýkrát (declaration-key je navyše idempotentný).
    let pendingFile = null;
    if (fastPath) {
      pendingFile = req.pending ? req.file : moveRequest(run, req.file, "pending");
      if (!pendingFile) {
        logLine(`continue ${key}: žiadosť sa nedá presunúť — nespúšťam`);
        continue;
      }
    }

    const res = triggerContinue(run, attempt, reason);
    triggeredThisCycle = true;
    st.lastTriggerAt = now();
    st.lastTriggerReason = reason;
    if (!st.episodeStartedAt) st.episodeStartedAt = now();
    if (res.ok) {
      st.triggers = (st.triggers || []).concat([now()]);
      st.allTriggers = (st.allTriggers || []).concat([now()]);
      st.triggerErrors = 0;
      if (st.lastJobResult) st.prevJobResult = st.lastJobResult; // výsledok predošlého jobu ostáva pre eskaláciu
      st.lastJobId = res.jobId;
      st.lastJobResult = null;
      if (fastPath) {
        st.noProgressFast = st.lastFastFingerprint === fingerprint ? (st.noProgressFast || 0) + 1 : 0;
        st.lastFastFingerprint = fingerprint;
        if (!st.episodeStartedAt) st.episodeStartedAt = now();
        moveRequest(run, pendingFile, "consumed");
      } else {
        st.attempts = attempt;
      }
      logLine(`continue ${key}: pokus ${attempt} (${reason}) → cron job ${res.jobId || "(existujúci, aktualizovaný)"}`);
    } else {
      st.triggerErrors = (st.triggerErrors || 0) + 1;
      st.lastJobResult = `cli-error: ${res.error}`;
      logLine(`continue ${key}: pokus ${attempt} ZLYHAL (CLI): ${res.error}`);
      if (st.triggerErrors >= TRIGGER_ERRORS_ALERT) {
        alerts.push({
          key: `continue-cli-error:${key}`,
          fingerprint: `errors-${st.triggerErrors}`,
          text: [
            `⚠️ Continuator nevie spustiť pokračovanie — ${key}`,
            "",
            `${st.triggerErrors}× po sebe zlyhalo volanie OpenClaw CLI: ${res.error}`,
            "Gateway pravdepodobne neprijíma cron.add. Skús `openclaw gateway restart` alebo napíš \"continue " + run.dir + "\".",
          ].join("\n"),
        });
      }
    }
    saveState(state); // write-through: bookkeeping nesmie zmiznúť, keď scheduler proces zabije

    // Info Ivanovi pri prvom zásahu v epizóde (nie pri rýchlej ceste — to je bežná prevádzka).
    if (!fastPath && attempt === 1 && res.ok) {
      alerts.push({
        key: `continue-info:${key}`,
        fingerprint: `episode-${st.episodeStartedAt}`,
        text: [
          `🔁 Auto-pokračovanie — ${key}`,
          "",
          `Beh sa nehýbal ${humanAge(run.ageMinutes)} (stav ${run.status || "?"}), tak som poslal agentovi "continue".`,
          `Cron job ${res.jobId || "aktualizovaný"} vytvorený. Ďalšie pokusy bez pokroku: o ${CONTINUE_BACKOFF_MINUTES.slice(1).join("/")} min, po ${CONTINUE_MAX_ATTEMPTS}. sa ozvem.`,
          `Zastaviť: napíš mi "pauza ${key}" (main agent vytvorí .app-builder/PAUSE).`,
        ].join("\n"),
      });
    }
    // Eskalácia po vyčerpaní pokusov.
    if (!fastPath && res.ok && attempt >= CONTINUE_MAX_ATTEMPTS && !st.escalatedAt) {
      st.escalatedAt = now();
      st.lastRemindAt = now();
      alerts.push({ key: `continue-failed:${key}`, fingerprint: `episode-${st.episodeStartedAt}`, alwaysSend: true, text: escalationText(run, st) });
    }
  }

  // Pripomienky po eskalácii (každých 6 h, kým sa niečo nepohne).
  for (const [key, st] of Object.entries(state.continues)) {
    if (!st.escalatedAt || !st.lastRemindAt) continue;
    const run = runs.find((r) => r.project === key && isContinuable(r));
    if (!run) {
      delete st.escalatedAt;
      delete st.lastRemindAt;
      continue;
    }
    if (run.ageMinutes > maxStaleMinutes(run, true)) continue;
    if (now() - st.lastRemindAt >= CONTINUE_REMIND_MINUTES * 60_000) {
      st.lastRemindAt = now();
      alerts.push({ key: `continue-remind:${key}`, fingerprint: `remind-${st.lastRemindAt}`, alwaysSend: true, text: escalationText(run, st, true) });
    }
  }
  return alerts;
}

function escalationText(run, st, remind = false, why = null) {
  const lastResult = st.lastJobResult || st.prevJobResult;
  const lines = [
    remind ? `⏰ Pripomienka: beh stále stojí — ${run.project}` : `🛑 Auto-pokračovanie nepomohlo — ${run.project}`,
    "",
    `Stav: ${run.status || "(bez statusu)"}, bez pokroku ${humanAge(run.ageMinutes)} (HEAD ${run.head || "?"}).`,
    `Pokusov o continue: ${st.attempts}${why ? ` — ${why}` : ""}${lastResult ? ` (posledný známy výsledok: ${lastResult})` : ""}.`,
    `Spustení za 24 h: ${(st.triggers || []).length}/${DAILY_TRIGGER_CAP}.`,
  ];
  if (run.nextAction) lines.push(`Ďalší krok podľa run-state: ${run.nextAction}`);
  lines.push(
    "",
    `Projekt: ${run.dir}`,
    "Čo môžeš urobiť: (1) pozrieť .app-builder/run-state.md a posledný report agenta, (2) napísať \"continue " + run.dir + " — <čo má urobiť inak>\",",
    `(3) napísať mi "pauza ${run.project}" (zastaví auto-pokračovanie), (4) beh uzavrieť (Status: ABORTED).`,
    "Bez tvojho zásahu skúšam ďalej každé 3 h a pripomeniem sa každých 6 h.",
    "",
    "(Píše watchdog priamo cez Telegram API, mimo agentov.)"
  );
  return lines.join("\n");
}

// ------------------------------------------------- H) zatvorenie SF stavu

function closeSolutionFactory(runs) {
  const alerts = [];
  for (const run of runs) {
    if (run.source !== "solution-factory" || run.phase !== "closable") continue;
    if (run.reviewGate?.blocked) continue;
    const builder = String(run.builderStatus || "").toUpperCase();
    const target = builder.startsWith("DONE") || builder.startsWith("MERGED") || builder.startsWith("DELIVERED") ? "DONE" : "ABORTED";
    const fingerprint = `${run.status}@${Math.floor(run.mtimeMs / 1000)}`;
    if (DRY_RUN) {
      logLine(`[dry-run] zavrel by som Solution Factory ${run.project}: ${run.status} → ${target}`);
      alerts.push({ key: `sf-closed:${run.project}`, fingerprint, text: `🏁 Solution Factory ${run.project}: ${run.status} → ${target} (builder ${run.builderStatus}).` });
      continue;
    }
    try {
      const obj = readJson(run.stateFile, null);
      if (!obj || typeof obj !== "object") continue;
      const nowIso = iso();
      const phases = Array.isArray(obj.phases) ? obj.phases : [];
      for (const p of phases) if (p && p.ended === null) p.ended = nowIso;
      phases.push({ phase: target, executor: "watchdog (closing duty)", started: nowIso, ended: nowIso, result: `uzavreté watchdogom: builder run-state je ${run.builderStatus}` });
      obj.phases = phases;
      obj.status = target;
      obj.updated_at = nowIso;
      obj.next_action = `nič — uzavreté watchdogom (builder ${run.builderStatus})`;
      writeJsonAtomic(run.stateFile, obj);
      logLine(`Solution Factory ${run.project}: ${run.status} → ${target} (builder ${run.builderStatus})`);
      alerts.push({
        key: `sf-closed:${run.project}`,
        fingerprint,
        text: `🏁 Solution Factory ${run.project}: builder skončil (${run.builderStatus}), stav Factory som uzavrel ako ${target}.`,
      });
    } catch (e) {
      logLine(`Solution Factory ${run.project}: zatvorenie zlyhalo: ${e.message}`);
    }
  }
  return alerts;
}

// ------------------------------------------------- F) outbox

// Agentov súbor sa nikdy neprepisuje na mieste: atomicky sa odloží na .processing, odošle sa,
// potvrdenia idú do outbox.sent.jsonl a neodoslané riadky sa vrátia späť (append).
async function flushOutbox(runs) {
  let sent = 0;
  const dirs = new Set(runs.map((r) => r.dir));
  for (const dir of dirs) {
    const abDir = path.join(dir, ".app-builder");
    const file = path.join(abDir, "outbox.jsonl");
    const sentFile = path.join(abDir, "outbox.sent.jsonl");
    // Nedokončené .processing z minulého behu (proces zabitý) — spracuj najprv.
    let batches = [];
    try {
      batches = fs.readdirSync(abDir).filter((f) => /^outbox\..*\.processing\.jsonl$/.test(f)).map((f) => path.join(abDir, f));
    } catch (_) {
      continue;
    }
    if (fs.existsSync(file)) {
      if (DRY_RUN) {
        const n = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim().startsWith("{")).length;
        if (n) logLine(`[dry-run] poslal by som outbox ${path.basename(dir)}: ${n} riadkov`);
        continue;
      }
      const processing = path.join(abDir, `outbox.${stamp()}.processing.jsonl`);
      try {
        fs.renameSync(file, processing);
        batches.push(processing);
      } catch (e) {
        logLine(`outbox ${path.basename(dir)}: nemôžem odložiť súbor: ${e.message}`);
      }
    }
    if (!batches.length) continue;
    // Dedup: id správ odoslaných za posledných 24 h.
    const sentIds = new Set();
    try {
      const cutoff = now() - 24 * 60 * 60_000;
      for (const l of fs.readFileSync(sentFile, "utf8").split(/\r?\n/)) {
        if (!l.trim()) continue;
        try {
          const e = JSON.parse(l);
          if (e && e.id && parseTime(e.sent_at) > cutoff) sentIds.add(e.id);
        } catch (_) {}
      }
    } catch (_) {}
    const project = path.basename(dir);
    for (const batch of batches) {
      let lines;
      try {
        lines = fs.readFileSync(batch, "utf8").split(/\r?\n/).filter((l) => l.trim());
      } catch (_) {
        continue;
      }
      const leftovers = [];
      let stop = false;
      for (const raw of lines) {
        let entry;
        try {
          entry = JSON.parse(raw);
        } catch (_) {
          continue; // nie JSON — zahodiť, nemá čo doručovať
        }
        if (!entry || typeof entry.text !== "string" || !entry.text.trim()) continue;
        if (entry.sent === true) continue;
        if (!LEGACY_REVIEW_TEST && entry.kind === "completion" && !reviewService.inspect(dir).completed) {
          leftovers.push(raw);
          logLine(`outbox ${project}: completion zadržaná — chýba platná host completion pre aktuálny kód`);
          continue;
        }
        const id = entry.id || shortHash(entry.text.trim());
        if (sentIds.has(id)) {
          logLine(`outbox ${project}: duplicitná správa ${id} preskočená`);
          continue;
        }
        if (stop || sent >= OUTBOX_MAX_PER_RUN) {
          leftovers.push(raw);
          continue;
        }
        const text = `📨 ${project}\n\n${entry.text.trim()}`.slice(0, TELEGRAM_MAX_CHARS);
        try {
          const messageId = await sendTelegram(text);
          sentIds.add(id);
          sent++;
          fs.appendFileSync(
            sentFile,
            JSON.stringify({ id, ts: entry.ts || null, sent_at: iso(), message_id: messageId, sent_by: "watchdog", text_prefix: entry.text.trim().slice(0, 80) }) + "\n"
          );
          logLine(`outbox ${project}: odoslané ${id} (message_id ${messageId || "?"})`);
        } catch (e) {
          logLine(`outbox ${project}: FAILED ${e.message}`);
          leftovers.push(raw);
          stop = true;
        }
      }
      try {
        if (leftovers.length) fs.appendFileSync(file, leftovers.join("\n") + "\n");
        fs.unlinkSync(batch);
      } catch (e) {
        logLine(`outbox ${project}: upratovanie dávky zlyhalo: ${e.message}`);
      }
    }
  }
  return sent;
}

// ------------------------------------- B) vyčerpaný fallback reťazec

// Dva najnovšie denné logy (starší → novší): o polnoci sa začne nový súbor a bez staršieho by
// výpadok "zmizol" a poslal falošné ✅ zotavenie.
function newestLogFiles(count = 2) {
  try {
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => /^openclaw-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, count)
      .reverse();
    return files.map((x) => path.join(LOG_DIR, x.f));
  } catch (_) {
    return [];
  }
}

function tailFile(file, maxBytes = 2_000_000) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Preloží technickú chybu na zrozumiteľnú príčinu. Rovnaká tabuľka ako
// v model-switch-notify.js — text alarmu bol natvrdo "všetky modely narazili
// na limit", takže klamal pri každom inom type zlyhania (30.8.: timeout).
function classifyFailure(detail) {
  const d = String(detail || "").toLowerCase();
  if (!d) return { kind: "unknown", label: "Dôvod sa nepodarilo zistiť (v logu nie je detail chyby)." };
  if (d.includes("disabled claude subscription") || d.includes("ask your admin"))
    return {
      kind: "subscription",
      label: "Anthropic odmietol predplatné pre Claude Code (nastavenie organizácie), NIE vyčerpaný limit.",
    };
  if (
    d.includes("usage limit") ||
    d.includes("session limit") || // Anthropic posiela "session limit", nie "usage limit"
    d.includes("rate limit") ||
    d.includes("rate_limit") ||
    d.includes("quota") ||
    d.includes("429")
  )
    return { kind: "limit", label: "Skutočne vyčerpaný limit / kvóta." };
  if (d.includes("auth") || d.includes("401") || d.includes("403") || d.includes("credential"))
    return { kind: "auth", label: "Problém s prihlásením alebo tokenom." };
  if (d.includes("model_not_found") || d.includes("unknown model"))
    return { kind: "config", label: "Model nie je dostupný alebo je zle zapísaný v configu." };
  if (d.includes("timeout") || d.includes("timed out") || d.includes("terminated"))
    return {
      kind: "timeout",
      label: "Model nestihol odpovedať a bol ukončený (timeout) — nie je to vyčerpaná kvóta.",
    };
  if (d.includes("overloaded") || d.includes("503"))
    return { kind: "overloaded", label: "Poskytovateľ je preťažený alebo nereaguje." };
  return { kind: "other", label: "Iná chyba." };
}

// Reťazec je vyčerpaný, keď posledný candidate_failed nemá ďalšieho kandidáta
// a po ňom už nič neuspelo.
// Čas resetu z chybovej hlášky providera ("… resets 6:20pm (Europe/Bratislava)"), ako lokálny
// čas tohto PC (beží v tej istej zóne). Ak by už bol pred `referenceMs` (chyba prišla po ňom),
// ide o zajtrajšok. null = nedá sa prečítať.
function parseResetAt(detail, referenceMs) {
  const text = detail && detail.error ? String(detail.error) : "";
  const m = text.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") h += 12;
  const ref = new Date(referenceMs || now());
  const at = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, Number(m[2] || 0), 0, 0);
  if (at.getTime() < (referenceMs || now())) at.setDate(at.getDate() + 1);
  return at.getTime();
}

// Smie watchdog počas výpadku spustiť skúšobný ťah? {due, notBefore}
function outageProbe(outage, lastProbeAt) {
  if (!outage.outage) return { due: false, notBefore: 0 };
  const backoff = OUTAGE_REPROBE_MINUTES * 60_000;
  const resetAt = parseResetAt(outage.detail, outage.lastExhaustedAt) || 0;
  const notBefore = Math.max((outage.lastExhaustedAt || 0) + backoff, (lastProbeAt || 0) + backoff, resetAt);
  return { due: now() >= notBefore, notBefore };
}

function detectModelOutage(prev) {
  const files = newestLogFiles(2);
  // Predošlý zapamätaný stav — zotavenie musí mať kladný dôkaz (úspešný turn), nie len chýbajúci log.
  let lastSuccessAt = (prev && Number(prev.lastSuccessAt)) || 0;
  let lastExhaustedAt = (prev && Number(prev.lastExhaustedAt)) || 0;
  let detail = (prev && prev.detail) || null;
  let pinnedFailures = 0;
  if (!files.length) return { outage: lastExhaustedAt > lastSuccessAt, detail, lastExhaustedAt, lastSuccessAt, pinnedFailures, reason: "no log" };

  let text = "";
  for (const file of files) {
    try {
      text += tailFile(file, files.length > 1 ? 1_000_000 : 2_000_000) + "\n";
    } catch (e) {
      logLine(`log gateway nečitateľný (${path.basename(file)}): ${e.message}`);
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const isDecision = line.indexOf("model_fallback_decision") !== -1;
    const isTurn = line.indexOf("live session turn") !== -1;
    if (!isDecision && !isTurn) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const t = Date.parse(o.time || (o._meta && o._meta.date) || "");
    if (!t) continue;

    // Bežný dokončený turn CLI backendu ("… live session turn:", bez "failed").
    // Je to jediný dôkaz, že Claw normálne odpovedá — candidate_succeeded vzniká
    // len pri reálnom prepnutí modelu, takže bez tohto signálu vedel výpadok
    // zrušiť iba ďalší fallback (30.8. falošný poplach visel skoro hodinu).
    if (typeof o["1"] === "string") {
      if (/live session turn:/.test(o["1"]) && t > lastSuccessAt) lastSuccessAt = t;
      continue;
    }

    const d = o["1"] && typeof o["1"] === "object" ? o["1"] : null;
    if (!d || d.event !== "model_fallback_decision") continue;

    if (d.decision === "candidate_succeeded") {
      if (t > lastSuccessAt) lastSuccessAt = t;
      continue;
    }
    if (d.decision !== "candidate_failed") continue;

    // Agent s jediným pripnutým modelom (fallbacks: []) nemá reťazec, ktorý by
    // sa dal vyčerpať — OpenClaw to aj tak označí "chain_exhausted" a pošle
    // total:1 + fallbackConfigured:false. Zlyhanie takého volania nehovorí nič
    // o dostupnosti ostatných modelov; zaseknutú stavbu rieši kontrola A).
    const chainSize = typeof d.total === "number" ? d.total : null;
    if (d.fallbackConfigured === false || (chainSize !== null && chainSize <= 1)) {
      pinnedFailures++;
      continue;
    }

    const hasNext = Boolean(d.nextCandidateModel || d.nextCandidateProvider);
    const chainEnd =
      !hasNext || (typeof d.attempt === "number" && chainSize !== null && d.attempt >= chainSize);
    if (!chainEnd) continue;

    if (t > lastExhaustedAt) {
      lastExhaustedAt = t;
      const error = (d.errorPreview || d.fallbackStepFromFailureDetail || "").slice(0, 200);
      detail = {
        at: new Date(t).toISOString(),
        model: `${d.candidateProvider || "?"}/${d.candidateModel || "?"}`,
        requested: `${d.requestedProvider || "?"}/${d.requestedModel || "?"}`,
        error,
        cause: classifyFailure(error || d.reason),
      };
    }
  }

  const outage = lastExhaustedAt > 0 && lastExhaustedAt > lastSuccessAt;
  return {
    outage,
    detail,
    lastExhaustedAt,
    lastSuccessAt,
    pinnedFailures,
    logFile: files.length ? path.basename(files[files.length - 1]) : null,
  };
}

function modelOutageAlert(res) {
  if (!res.outage) return null;
  const error = (res.detail && res.detail.error) || "";
  const cause = (res.detail && res.detail.cause) || classifyFailure(error);
  const limitHit = cause.kind === "limit";
  const resetMatch =
    error.match(/resets\s+([^\n)]+?\))/i) || error.match(/resets\s+([0-9:apm ]+)/i);
  const lines = [
    limitHit
      ? "🚨 Všetky modely narazili na limit — Claw ti nedokáže odpovedať"
      : "🚨 Zlyhali všetky modely v reťazci — Claw ti nedokáže odpovedať",
    "",
    `Posledný pokus zlyhal: ${res.detail ? res.detail.model : "?"} (${minutesAgo(res.lastExhaustedAt)} min dozadu)`,
    `Príčina: ${cause.label}`,
  ];
  if (error) lines.push(`Hláška: ${error}`);
  if (limitHit && resetMatch) lines.push(`Reset limitu: ${resetMatch[1]}`);
  lines.push(
    "",
    "Vyskúšal som celý fallback reťazec, takže žiadny agent (main ani app-builder) teraz",
    "nevie prijať ani poslať správu. Rozrobené stavby sú uložené v run-state.md a git vetvách —",
    "nič sa nestratilo, po zotavení stačí napísať \"continue <projekt>\".",
    "",
    "(Watchdog píše priamo cez Telegram API, bez modelu.)"
  );
  return {
    key: "model-outage",
    fingerprint: res.detail ? res.detail.at : String(res.lastExhaustedAt),
    text: lines.join("\n"),
    recoveryKey: "model-outage",
  };
}

// ------------------------------------------------- C) gateway neodpovedá

async function probeGateway() {
  const cfg = readJson(CONFIG_FILE, null);
  const port = (cfg && cfg.gateway && cfg.gateway.port) || 18789;
  if (SKIP_GATEWAY) return { up: true, status: 0, port, skipped: true };
  const token = cfg && cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    // Aj 401/404 znamená, že server žije a odpovedá.
    return { up: true, status: res.status, port };
  } catch (e) {
    return { up: false, error: e.name === "AbortError" ? "timeout" : e.message, port };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- main

(async () => {
  const state = readJson(STATE_FILE, { alerts: {}, gatewayStrikes: 0, continues: {} });
  if (!state.alerts) state.alerts = {};
  if (!state.continues) state.continues = {};

  const overrides = Object.keys(process.env).filter((k) => k.startsWith("WATCHDOG_"));
  if (overrides.length && !TEST_MODE) logLine(`POZOR: v prostredí sú WATCHDOG_* premenné (${overrides.join(", ")}) — bez WATCHDOG_TEST=1 sa testovacie háky ignorujú`);

  let runs = scanRuns();
  const outage = detectModelOutage(state.modelOutage);
  const lastProbeAt = (state.modelOutage && Number(state.modelOutage.lastProbeAt)) || 0;
  const probe = outageProbe(outage, lastProbeAt);
  state.modelOutage = {
    lastExhaustedAt: outage.lastExhaustedAt || 0,
    lastSuccessAt: outage.lastSuccessAt || 0,
    detail: outage.detail || null,
    // --status len číta: skúšku „spotrebuje" (a zaloguje) iba skutočný cyklus; logLine píše aj na
    // stdout a rozbil by JSON výstup statusu.
    lastProbeAt: probe.due && !STATUS_ONLY ? now() : lastProbeAt,
  };
  // Výpadok blokuje continuator, KÝM nie je čas na skúšobný ťah — ten je jediný spôsob, ako
  // získať kladný dôkaz o zotavení, keď inak nikto nič nespúšťa.
  const outageBlocks = outage.outage && !probe.due;
  if (probe.due && !STATUS_ONLY) logLine(`výpadok modelov trvá ${humanAge(minutesAgo(outage.lastExhaustedAt))} — povoľujem skúšobný ťah (ďalší najskôr o ${OUTAGE_REPROBE_MINUTES} min)`);
  const gateway = await probeGateway();
  const busy = sessionBusy();

  // Ručné spustenie: node app-builder-watchdog.js --continue-now <projektDir> [--force]
  if (CONTINUE_NOW_IDX >= 0 && (!CONTINUE_NOW_DIR || CONTINUE_NOW_DIR.startsWith("--"))) {
    console.error("použitie: node app-builder-watchdog.js --continue-now <projektDir> [--force]");
    process.exit(2);
  }
  if (CONTINUE_NOW_DIR) {
    const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
    const target = norm(CONTINUE_NOW_DIR);
    const run =
      runs.find((r) => norm(r.dir) === target && r.source === "app-builder") ||
      runs.find((r) => norm(r.dir) === target);
    if (!run) {
      logLine(`continue-now: v ${target} nie je žiadny run-state`);
      process.exit(2);
    }
    if (!canContinueThroughReview(run)) {
      logLine(`continue-now: odmietnuté — review-gate:${run.project} ${run.reviewGate.code}; backend=${run.reviewGate.backend}. ${run.reviewGate.reason}`);
      process.exit(3); // --force obchádza zámok, nikdy review gate
    }
    const reg = DRY_RUN ? { ok: true, jobs: [] } : listJobs();
    const liveJob = reg.jobs.find((j) => j && (String(j.declarationKey || "").startsWith("auto-continue:") || String(j.name || "").startsWith("auto-continue: ")) && jobIsLive(j));
    if (!FORCE && (run.lock.fresh || busy.busy || liveJob)) {
      const why = liveJob ? `živý cron job ${String(liveJob.id).slice(0, 8)}` : run.lock.fresh ? "čerstvý lock.json" : busy.reason;
      logLine(`continue-now: odmietnuté — ${why} (použi --force)`);
      process.exit(3);
    }
    if (DRY_RUN) {
      logLine(`[dry-run] continue-now ${run.project}`);
      return;
    }
    const res = triggerContinue(run, 1, "ručné spustenie (--continue-now)");
    const st = state.continues[run.project] || { attempts: 0, triggers: [] };
    st.lastTriggerAt = now();
    st.triggers = (st.triggers || []).concat(res.ok ? [now()] : []);
    st.lastJobId = res.ok ? res.jobId : null;
    st.lastJobResult = res.ok ? null : `cli-error: ${res.error}`;
    st.lastFingerprint = progressFingerprint(run);
    state.continues[run.project] = st;
    saveState(state);
    logLine(res.ok ? `continue-now ${run.project}: cron job ${res.jobId || "(aktualizovaný)"}` : `continue-now ${run.project}: ZLYHALO ${res.error}`);
    console.log(JSON.stringify(res));
    process.exit(res.ok ? 0 : 1);
  }

  if (STATUS_ONLY) {
    // Príjemcu a token len overíme, nevypisujeme — status sa dá bezpečne zdieľať.
    let delivery;
    try {
      delivery = { chatId: maskChatId(chatId()), botToken: botToken() ? "nájdený" : "chýba" };
    } catch (e) {
      delivery = { error: e.message };
    }
    console.log(
      JSON.stringify(
        {
          delivery,
          runs,
          outage: Object.assign({}, outage, { probe: { due: probe.due, notBefore: probe.notBefore ? iso(probe.notBefore) : null, lastProbeAt: lastProbeAt ? iso(lastProbeAt) : null } }),
          gateway,
          sessionBusy: busy,
          continuator: {
            enabled: !CONTINUE_DISABLED,
            globalPause: fs.existsSync(GLOBAL_PAUSE_FILE),
            cli: OPENCLAW_CLI,
            backoffMinutes: CONTINUE_BACKOFF_MINUTES,
            dailyCap: DAILY_TRIGGER_CAP,
            state: state.continues,
          },
          state,
        },
        null,
        2
      )
    );
    return;
  }

  if (TEST_SEND) {
    await sendTelegram(
      "🐕 App Builder watchdog — testovacia správa.\n" +
        `Sledujem ${runs.length} projekt(ov), gateway ${gateway.up ? "beží" : "NEODPOVEDÁ"}, ` +
        `modely ${outage.outage ? "sú na limite" : "odpovedajú"}.\n` +
        "Túto správu poslal skript priamo cez Telegram API, bez akéhokoľvek modelu."
    );
    logLine("test message sent");
    return;
  }

  const alerts = [];

  const outageAlert = modelOutageAlert(outage);
  if (outageAlert) alerts.push(outageAlert);

  // Gateway počítame na strikes, aby reštart gateway nespôsobil falošný alarm.
  if (!gateway.up) {
    state.gatewayStrikes = (state.gatewayStrikes || 0) + 1;
    if (state.gatewayStrikes >= GATEWAY_STRIKES) {
      alerts.push({
        key: "gateway-down",
        fingerprint: `strikes-${state.gatewayStrikes >= GATEWAY_STRIKES ? "on" : "off"}`,
        text: [
          "🔌 OpenClaw gateway neodpovedá",
          "",
          `Port ${gateway.port} mlčí už ${state.gatewayStrikes} kontroly po sebe (${gateway.error}).`,
          "Kým je gateway dole, Telegram ani WhatsApp nefungujú a App Builder nič nespustí.",
          "",
          "Oprava na PC: spusti naplánovanú úlohu \"OpenClaw Gateway\" (Task Scheduler),",
          "prípadne \"openclaw gateway restart\" v priečinku s inštaláciou OpenClaw.",
          "",
          "(Watchdog beží mimo gateway, preto ti to vie napísať.)",
        ].join("\n"),
      });
    }
  } else if (state.gatewayStrikes) {
    if (state.gatewayStrikes >= GATEWAY_STRIKES) {
      alerts.push({
        key: "gateway-up",
        fingerprint: `recovered-${now()}`,
        text: "✅ OpenClaw gateway je opäť online — Telegram funguje normálne.",
        clears: "gateway-down",
        alwaysSend: true,
      });
    }
    state.gatewayStrikes = 0;
  }

  const continuatorOn = !CONTINUE_DISABLED;
  if (driveReviews(runs, { sessionBusy: busy, gatewayUp: gateway.up, modelOutage: outageBlocks })) runs = scanRuns();
  for (const a of stalledRunAlerts(runs, continuatorOn)) alerts.push(a);
  if (continuatorOn) {
    for (const a of continuator(runs, state, { sessionBusy: busy, gatewayUp: gateway.up, modelOutage: outageBlocks }))
      alerts.push(a);
    for (const a of closeSolutionFactory(runs)) alerts.push(a);
  }

  // Outbox: správy, ktoré agent nevedel doručiť.
  let outboxSent = 0;
  try {
    outboxSent = await flushOutbox(runs);
  } catch (e) {
    logLine(`outbox: ${e.message}`);
  }

  // Až PO flushi outboxu: čerstvo doručený riadok je platný dôkaz, že správa neskončila v prázdne.
  for (const a of lostReportAlerts(runs)) alerts.push(a);
  for (const a of reviewGateAlerts(runs)) alerts.push(a);

  // Zotavenie po výpadku modelov — pošli raz, keď to zjavne opäť ide.
  if (!outage.outage && state.alerts["model-outage"]) {
    alerts.push({
      key: "model-recovered",
      fingerprint: `recovered-${state.alerts["model-outage"].fingerprint}`,
      text: "✅ Modely opäť odpovedajú — Claw je späť v prevádzke. Rozrobené stavby vieš rozbehnúť príkazom \"continue <projekt>\".",
      clears: "model-outage",
      alwaysSend: true,
    });
  }

  // Jednorazové správy (eskalácia, info, pripomienka), ktoré sa minule nepodarilo poslať —
  // ich bookkeeping je už zapísaný, takže by sa nikdy neopakovali. Skúsime ich znova (max 24 h).
  const pending = (state.pendingAlerts || []).filter((p) => p && now() - (p.queuedAt || 0) < 24 * 60 * 60_000);
  state.pendingAlerts = [];
  for (const p of pending) alerts.unshift(Object.assign({}, p, { alwaysSend: true }));

  if (!alerts.length) {
    logLine(
      `ok — runs=${runs.length} stalled=0 gateway=${gateway.up ? "up" : "down"} models=${outage.outage ? "outage" : "ok"}` +
        (busy.busy ? " session=busy" : "") +
        (outboxSent ? ` outbox=${outboxSent}` : "")
    );
    saveState(state);
    return;
  }

  for (const alert of alerts) {
    if (alert.key.startsWith("review-gate:")) {
      // Bez raw príkazov/tokenov; príčina sa objaví aj v lokálnom logu, nielen na Telegrame.
      const gate = runs.find((r) => r.source === "app-builder" && `review-gate:${r.project}` === alert.key)?.reviewGate;
      if (gate) logLine(`${alert.key} blocked=${gate.code} backend=${gate.backend} required=${gate.requiredRoute}`);
    }
    const prev = state.alerts[alert.key];
    if (prev && !alert.alwaysSend) {
      // Nezmenený stav sa hlási raz — inak by watchdog dookola opakoval to isté.
      if (prev.fingerprint === alert.fingerprint) {
        logLine(`skip ${alert.key} (rovnaký stav už ohlásený)`);
        continue;
      }
      if (now() - prev.sentAt < COOLDOWN_MS) {
        logLine(`skip ${alert.key} (cooldown po predošlom alerte)`);
        continue;
      }
    }
    if (DRY_RUN) {
      logLine(`[dry-run] poslal by som ${alert.key}:\n${alert.text}`);
      continue;
    }
    try {
      await sendTelegram(alert.text);
      state.alerts[alert.key] = { fingerprint: alert.fingerprint, sentAt: now() };
      if (alert.clears) delete state.alerts[alert.clears];
      logLine(`sent ${alert.key}`);
      saveState(state); // write-through: zabitý proces nesmie spôsobiť opakovanie už poslaného
    } catch (e) {
      logLine(`FAILED ${alert.key}: ${e.message}`);
      // Opakovateľné alerty (stalled:*, abandoned:*, budget:*) sa prepočítajú v ďalšom cykle sami;
      // jednorazové (continue-info/failed/remind, sf-closed, frozen…) zaradíme do fronty.
      if (alert.alwaysSend || /^(continue-|sf-closed|frozen)/.test(alert.key)) {
        state.pendingAlerts = (state.pendingAlerts || [])
          .filter((p) => p.key !== alert.key)
          .concat([{ key: alert.key, fingerprint: alert.fingerprint, text: alert.text, clears: alert.clears, queuedAt: now() }])
          .slice(-PENDING_ALERT_MAX);
        saveState(state);
      }
    }
  }

  saveState(state);
})().catch((e) => {
  logLine(`watchdog crashed: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
