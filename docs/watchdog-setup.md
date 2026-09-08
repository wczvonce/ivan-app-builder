# Watchdog — inštalácia a ladenie

Watchdog a host review runner sú dva Node skripty bez ďalších npm závislostí. Nepotrebuje bežiaci model ani gateway, preto ho
spúšťa plánovač operačného systému, nie OpenClaw cron — cron by pri spadnutej gateway nebežal
a práve vtedy je watchdog potrebný najviac.

## Predpoklady

- Node.js 24 so vstavaným SQLite (testované prostredie host runnera).
- Na Windows: WSL2 distribúcia `Ubuntu-24.04` a aktuálny Codex CLI v
  `/home/forge/.local/bin/codex`, prihlásený cez ChatGPT. Host reviewer tam používa
  vynútený read-only sandbox.
- OpenClaw s nakonfigurovaným Telegram kanálom v `~/.openclaw/openclaw.json`.
- Spoločne skopírované `scripts/app-builder-watchdog.js` a `scripts/app-builder-review.js` do `~/.openclaw/scripts/`.
- Pre Phase 7 prihlásený Codex cez ChatGPT a Claude Code cez predplatné, plus nainštalovaný acpx.
- Aktuálne workspace pravidlá a skill podľa [review-runner.md](review-runner.md).

## Overenie pred nasadením

```bash
node app-builder-watchdog.js --status
```

Vypíše, koho a čím by upozorňoval (`chatId` je zámerne maskované), aké behy vidí, či je gateway
hore a či je fallback reťazec v poriadku. Potom jedna reálna správa:

```bash
node app-builder-watchdog.js --test
```

## Windows — naplánovaná úloha

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
                                   -Argument "$HOME\.openclaw\scripts\app-builder-watchdog.js"
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
                                    -RepetitionInterval (New-TimeSpan -Minutes 5)
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                         -StartWhenAvailable -MultipleInstances IgnoreNew `
                                         -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName "OpenClaw-AppBuilder-Watchdog" `
                       -Action $action -Trigger @($every5, $atLogon) `
                       -Settings $settings -Principal $principal -Force
```

Kontrola, že úloha naozaj beží:

```powershell
Get-ScheduledTaskInfo -TaskName "OpenClaw-AppBuilder-Watchdog" |
  Select-Object LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns
```

`LastTaskResult` musí byť `0`. Priebeh sa zapisuje aj do `app-builder-watchdog.log` vedľa skriptu.

## Linux / macOS

Ekvivalent cez cron používateľa (nie cez OpenClaw cron):

```cron
*/10 * * * * /usr/bin/node "$HOME/.openclaw/scripts/app-builder-watchdog.js" >/dev/null 2>&1
```

## Premenné prostredia

Všetky sú voliteľné; bez nich sa hodnoty načítajú z `openclaw.json` a zo štandardných ciest.

| Premenná | Význam |
|---|---|
| `WATCHDOG_BOT_TOKEN` | Telegram bot token namiesto `channels.telegram.botToken` |
| `WATCHDOG_CHAT_ID` | príjemca namiesto prvého z `channels.telegram.execApprovals.approvers` |
| `WATCHDOG_PROJECT_ROOTS` | priečinky s projektmi, oddelené `;` |
| `WATCHDOG_OPENCLAW_LOG_DIR` | priečinok s `openclaw-YYYY-MM-DD.log` |
| `WATCHDOG_STATE_FILE` | súbor so stavom odoslaných upozornení |
| `WATCHDOG_LOG_FILE` | vlastný log watchdogu |

Testy tieto premenné využívajú na to, aby bežali proti syntetickým dátam v dočasnom priečinku
a nedotkli sa produkčného stavu ani Telegramu:

```bash
node app-builder-watchdog.test.js
```

## Prahové hodnoty

Sú konštanty na začiatku skriptu:

| Konštanta | Predvolené | Význam |
|---|---|---|
| `STALL_MINUTES` | 45 | nezmenený `run-state.md` rozrobeného behu |
| `WAITING_STALL_MINUTES` | 90 | to isté, keď je stav `BLOCKED`/`WAITING` |
| `MAX_STALE_HOURS` | 12 | nad túto hranicu ide o opustený projekt, nie zaseknutý beh |
| `COOLDOWN_MS` | 1 h | najkratší odstup medzi upozorneniami na ten istý stav |
| `GATEWAY_STRIKES` | 2 | koľkokrát po sebe musí sonda zlyhať |

## Prečo skill vyžaduje riadok `Status:`

Watchdog rozlišuje mŕtvy beh od hotového podľa riadku `Status:` v `.app-builder/run-state.md`
(`PLANNING`, `IMPLEMENTING`, `VERIFYING`, `REVIEW`, `BLOCKED`, `WAITING`, `DONE`, `ABORTED`).
Keď riadok chýba, watchdog sa opatrne oprie o `next action` a pri nejasnosti radšej mlčí — falošné
poplachy by ho znehodnotili rýchlejšie než občasné zmeškané upozornenie.
