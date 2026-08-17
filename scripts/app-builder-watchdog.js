// App Builder watchdog — model-free bezpečnostná sieť.
//
// Beží ako naplánovaná úloha Windows (nie OpenClaw cron), takže funguje aj vtedy,
// keď je gateway mŕtva alebo keď narazili na limit VŠETKY modely naraz a žiadny
// agent nedokáže poslať správu. Telegram volá priamo cez bot API — bez LLM.
//
// Kontroly:
//   A) rozrobená stavba appky sa prestala hýbať (.app-builder/run-state.md)
//   B) fallback reťazec modelov je vyčerpaný (nikto neobslúžil poslednú správu)
//   C) OpenClaw gateway neodpovedá
//
// Použitie: node app-builder-watchdog.js [--dry-run|--status|--test]

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const OPENCLAW_DIR = path.join(HOME, ".openclaw");
const CONFIG_FILE = path.join(OPENCLAW_DIR, "openclaw.json");
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

const STALL_MINUTES = 45; // rozrobený beh bez zmeny run-state.md
const WAITING_STALL_MINUTES = 90; // beh, ktorý čaká na Ivanovo rozhodnutie
const MAX_STALE_HOURS = 12; // starší run-state = dávno opustený projekt, nie zaseknutý beh
const COOLDOWN_MS = 60 * 60 * 1000; // po zmene stavu neposielať častejšie ako raz za hodinu
const GATEWAY_STRIKES = 2; // koľko behov po sebe musí gateway mlčať

// run-state statusy, pri ktorých je beh uzavretý a nič nečakáme
const TERMINAL_STATUSES = ["DONE", "ABORTED", "CANCELLED", "CANCELED", "MERGED", "DELIVERED"];
// statusy, kde loptička je u Ivana (agent už písal, len to mohlo zapadnúť)
const WAITING_STATUSES = ["BLOCKED", "WAITING", "AWAITING", "ESCALATED", "PAUSED"];

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const STATUS_ONLY = args.includes("--status");
const TEST_SEND = args.includes("--test");

// ---------------------------------------------------------------- utility

function logLine(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 200_000) {
      const keep = fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-500).join("\n");
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

function maskChatId(id) {
  return id.length > 6 ? `${id.slice(0, 3)}***${id.slice(-3)}` : "***";
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${botToken()}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId(), text, disable_notification: false }),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

function minutesAgo(ms) {
  return Math.round((Date.now() - ms) / 60000);
}

function humanAge(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ------------------------------------------------- A) rozrobené stavby

// Skill negarantuje pole `Status:` (prvé behy ho nemali), preto klasifikujeme
// tolerantne: bez jasného signálu radšej mlčíme, než by sme budili falošný alarm.
function classifyRun(status, nextAction) {
  const done = (s) => TERMINAL_STATUSES.some((t) => s.startsWith(t));
  if (status) {
    const up = status.toUpperCase();
    if (done(up)) return "terminal";
    if (WAITING_STATUSES.some((w) => up.includes(w))) return "waiting";
    return "active";
  }
  // Bez statusu sa opierame o "next action": žiadny ďalší krok = uzavretý beh.
  if (!nextAction || /^(none|n\/a|nič|ziadn|žiadn)/i.test(nextAction)) return "terminal";
  return "active";
}

function scanRuns() {
  const runs = [];
  for (const root of PROJECT_ROOTS) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (_) {
      continue;
    }
    for (const dir of entries) {
      const stateFile = path.join(root, dir.name, ".app-builder", "run-state.md");
      let text;
      let mtimeMs;
      try {
        text = fs.readFileSync(stateFile, "utf8");
        mtimeMs = fs.statSync(stateFile).mtimeMs;
      } catch (_) {
        continue;
      }
      const statusMatch = text.match(/^[-*]?\s*(?:run )?status:\s*(.+)$/im);
      const nextMatch = text.match(/^[-*]?\s*Next action:\s*(.+)$/im);
      const status = statusMatch ? statusMatch[1].trim() : null;
      const nextAction = nextMatch ? nextMatch[1].trim() : null;
      runs.push({
        project: dir.name,
        dir: path.join(root, dir.name),
        stateFile,
        status,
        nextAction,
        phase: classifyRun(status, nextAction),
        ageMinutes: minutesAgo(mtimeMs),
        mtimeMs,
      });
    }
  }
  return runs;
}

function stalledRunAlerts(runs) {
  const alerts = [];
  for (const run of runs) {
    if (run.phase === "terminal") continue;
    const waiting = run.phase === "waiting";
    const limit = waiting ? WAITING_STALL_MINUTES : STALL_MINUTES;
    if (run.ageMinutes < limit) continue;
    // Nad hornou hranicou už nejde o zaseknutý beh, ale o opustený projekt.
    if (run.ageMinutes > MAX_STALE_HOURS * 60) continue;

    const key = `stalled:${run.project}`;
    const fingerprint = `${run.status || "no-status"}@${Math.floor(run.mtimeMs / 1000)}`;
    const head = waiting
      ? `⏸️ App Builder čaká na tvoje rozhodnutie — ${run.project}`
      : `🛑 App Builder sa nehýbe — ${run.project}`;
    const lines = [
      head,
      "",
      `Stav: ${run.status || "(run-state neuvádza status)"}`,
      `Bez zmeny už: ${humanAge(run.ageMinutes)}`,
    ];
    if (run.nextAction) lines.push(`Ďalší krok podľa run-state: ${run.nextAction}`);
    lines.push(
      "",
      `Projekt: ${run.dir}`,
      "Rozrobená práca je v poriadku (git vetva + run-state.md).",
      `Pokračovanie: napíš do Telegramu "continue ${run.dir}".`,
      "",
      "(Toto píše watchdog priamo, mimo agentov — takže to príde aj keď majú modely limit.)"
    );
    alerts.push({ key, fingerprint, text: lines.join("\n") });
  }
  return alerts;
}

// ------------------------------------- B) vyčerpaný fallback reťazec

function newestLogFile() {
  try {
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => /^openclaw-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files.length ? path.join(LOG_DIR, files[0].f) : null;
  } catch (_) {
    return null;
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

// Reťazec je vyčerpaný, keď posledný candidate_failed nemá ďalšieho kandidáta
// a po ňom už nič neuspelo.
function detectModelOutage() {
  const file = newestLogFile();
  if (!file) return { outage: false, reason: "no log" };

  let lastSuccessAt = 0;
  let lastExhaustedAt = 0;
  let detail = null;

  for (const line of tailFile(file).split(/\r?\n/)) {
    if (!line.trim() || line.indexOf("model_fallback_decision") === -1) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const d = o["1"] && typeof o["1"] === "object" ? o["1"] : null;
    if (!d || d.event !== "model_fallback_decision") continue;
    const t = Date.parse(o.time || (o._meta && o._meta.date) || "");
    if (!t) continue;

    if (d.decision === "candidate_succeeded") {
      if (t > lastSuccessAt) lastSuccessAt = t;
      continue;
    }
    if (d.decision !== "candidate_failed") continue;

    const hasNext = Boolean(d.nextCandidateModel || d.nextCandidateProvider);
    const chainEnd =
      !hasNext ||
      (typeof d.attempt === "number" && typeof d.total === "number" && d.attempt >= d.total);
    if (!chainEnd) continue;

    if (t > lastExhaustedAt) {
      lastExhaustedAt = t;
      detail = {
        at: new Date(t).toISOString(),
        model: `${d.candidateProvider || "?"}/${d.candidateModel || "?"}`,
        requested: `${d.requestedProvider || "?"}/${d.requestedModel || "?"}`,
        error: (d.errorPreview || d.fallbackStepFromFailureDetail || "").slice(0, 200),
      };
    }
  }

  const outage = lastExhaustedAt > 0 && lastExhaustedAt > lastSuccessAt;
  return {
    outage,
    detail,
    lastExhaustedAt,
    lastSuccessAt,
    logFile: path.basename(file),
  };
}

function modelOutageAlert(res) {
  if (!res.outage) return null;
  const resetMatch = (res.detail && res.detail.error || "").match(/resets\s+([^\n)]+?\))/i)
    || (res.detail && res.detail.error || "").match(/resets\s+([0-9:apm ]+)/i);
  const lines = [
    "🚨 Všetky modely narazili na limit — Claw ti nedokáže odpovedať",
    "",
    `Posledný pokus zlyhal: ${res.detail ? res.detail.model : "?"} (${minutesAgo(res.lastExhaustedAt)} min dozadu)`,
  ];
  if (res.detail && res.detail.error) lines.push(`Hláška: ${res.detail.error}`);
  if (resetMatch) lines.push(`Reset limitu: ${resetMatch[1]}`);
  lines.push(
    "",
    "Celý fallback reťazec je vyčerpaný, takže žiadny agent (main ani app-builder) teraz",
    "nevie prijať ani poslať správu. Rozrobené stavby sú uložené v run-state.md a git vetvách —",
    "nič sa nestratilo, po resete stačí napísať \"continue <projekt>\".",
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
  const state = readJson(STATE_FILE, { alerts: {}, gatewayStrikes: 0 });
  if (!state.alerts) state.alerts = {};

  const runs = scanRuns();
  const outage = detectModelOutage();
  const gateway = await probeGateway();

  if (STATUS_ONLY) {
    // Príjemcu a token len overíme, nevypisujeme — status sa dá bezpečne zdieľať.
    let delivery;
    try {
      delivery = { chatId: maskChatId(chatId()), botToken: botToken() ? "nájdený" : "chýba" };
    } catch (e) {
      delivery = { error: e.message };
    }
    console.log(JSON.stringify({ delivery, runs, outage, gateway, state }, null, 2));
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
        fingerprint: `recovered-${Date.now()}`,
        text: "✅ OpenClaw gateway je opäť online — Telegram funguje normálne.",
        clears: "gateway-down",
        alwaysSend: true,
      });
    }
    state.gatewayStrikes = 0;
  }

  for (const a of stalledRunAlerts(runs)) alerts.push(a);

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

  if (!alerts.length) {
    logLine(
      `ok — runs=${runs.length} stalled=0 gateway=${gateway.up ? "up" : "down"} models=${outage.outage ? "outage" : "ok"}`
    );
    if (!DRY_RUN) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return;
  }

  for (const alert of alerts) {
    const prev = state.alerts[alert.key];
    if (prev && !alert.alwaysSend) {
      // Nezmenený stav sa hlási raz — inak by watchdog dookola opakoval to isté.
      if (prev.fingerprint === alert.fingerprint) {
        logLine(`skip ${alert.key} (rovnaký stav už ohlásený)`);
        continue;
      }
      if (Date.now() - prev.sentAt < COOLDOWN_MS) {
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
      state.alerts[alert.key] = { fingerprint: alert.fingerprint, sentAt: Date.now() };
      if (alert.clears) delete state.alerts[alert.clears];
      logLine(`sent ${alert.key}`);
    } catch (e) {
      logLine(`FAILED ${alert.key}: ${e.message}`); // stav neukladám → skúsi znova
    }
  }

  if (!DRY_RUN) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
})().catch((e) => {
  logLine(`watchdog crashed: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
