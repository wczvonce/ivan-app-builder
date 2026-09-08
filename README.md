# Ivan App Builder

OpenClaw skill, ktorý z jednej vety v Telegrame postaví aplikáciu — ale až po tom, čo sa doptá
a nechá si zadanie potvrdiť. K nemu patrí watchdog, ktorý beží mimo agentov a ozve sa aj vtedy,
keď žiadny model nedokáže odpovedať.

```text
Telegram
  → OpenClaw orchestrátor (otázky, potvrdená špecifikácia, plán)
  → Claude Code cez oficiálny ACPX (programovanie)
  → testy / build / smoke test (web aj mobil, so screenshotmi)
  → host runner: GPT-6 Astra Codex review; pri GPT backende povinne Fable
  → opravné kolá s limitom (3 na úlohu, 8 na celý beh)
  → výsledok do Telegramu
```

Kľúčové pravidlo: **kým nie je zadanie potvrdené, nevznikne ani riadok kódu.** Skill najprv
zopakuje, ako požiadavku pochopil, položí 4–7 otázok, rozdelí rozsah na prvú verziu / neskôr /
mimo rozsahu a počká na výslovné schválenie.

## Čo je v repozitári

| Cesta | Obsah |
|---|---|
| `skill/` | samotný skill v1.6.3 — `SKILL.md`, referencie, šablóny, konfiguračný fragment |
| `scripts/app-builder-watchdog.js` | watchdog nezávislý od agentov aj od gateway |
| `scripts/app-builder-watchdog.test.js` | regresné testy a integrácia s host review (nič neposielajú) |
| `scripts/app-builder-review.js` | vykonanie testov, nezávislej review a brány DONE |
| `scripts/app-builder-review.test.js` | testy review, fallbackov, opráv a platnosti schválenia |
| `docs/review-runner.md` | workflow, inštalácia a obmedzenia host gate |
| `docs/watchdog-setup.md` | inštalácia watchdogu na Windows a ladenie |

## Skill

Inštalácia do OpenClaw:

```bash
openclaw skills install ./skill --global
openclaw gateway restart
openclaw skills list
```

Podrobnosti — režimy kontroly, overovanie mobilných aplikácií, limity opravných kôl,
potvrdzovacia brána — sú v [`skill/README-SK.md`](skill/README-SK.md) a v
[`skill/SKILL.md`](skill/SKILL.md).

Na tomto hoste je orchestrátor Claude s povoleným GPT fallbackom; implementuje samostatný
Claude Code worker. Review spúšťa externý host runner podľa
[`docs/review-runner.md`](docs/review-runner.md). Inštaluj runner aj watchdog spoločne.
Konfiguračný fragment v `skill/config/` je starší príklad schémy; nenahrádzaj ním živý config.
Modely a runtime over podľa skutočne nainštalovanej verzie OpenClaw.

## Watchdog

Každá notifikácia zvnútra agenta závisí od toho, či vôbec nejaký model dokáže odpovedať. Keď
narazí na limit celý fallback reťazec alebo spadne gateway, hotová aj zaseknutá stavba ostane
ticho — presne to sa raz stalo a používateľ sa o dokončenej aplikácii dozvedel až o štyri hodiny
neskôr, keď sa sám spýtal. Watchdog túto dieru zatvára: beží ako naplánovaná úloha operačného
systému a Telegram volá priamo cez Bot API, takže nepotrebuje ani model, ani gateway.

Hlási tri stavy, každý raz, plus správu, keď sa vec zotaví:

1. **Zaseknutá stavba** — `.app-builder/run-state.md` sa 45 minút nepohol (90 minút, keď beh čaká
   na rozhodnutie používateľa). Súbory staršie ako 12 hodín ignoruje, to už nie je zaseknutý beh,
   ale opustený projekt.
2. **Vyčerpaný fallback reťazec** — posledné rozhodnutie o fallbacku nemá ďalšieho kandidáta
   a nič po ňom neuspelo. V správe je aj čas resetu vytiahnutý z chybovej hlášky providera.
3. **Nedostupná gateway** — HTTP sonda zlyhá dvakrát po sebe.

```bash
node scripts/app-builder-watchdog.js --status    # čo vidí, ako JSON
node scripts/app-builder-watchdog.js --dry-run   # rozhodne, ale nič nepošle
node scripts/app-builder-watchdog.js --test      # pošle jednu reálnu správu
node scripts/app-builder-watchdog.test.js        # testy detekcie
```

Nastavenie ako naplánovanej úlohy je v [`docs/watchdog-setup.md`](docs/watchdog-setup.md).

## Bezpečnosť

V repozitári nie sú žiadne prístupové údaje. Watchdog si Telegram token aj príjemcu berie
z `~/.openclaw/openclaw.json` (`channels.telegram.botToken`, resp. prvý zo
`channels.telegram.execApprovals.approvers`), prípadne z premenných prostredia
`WATCHDOG_BOT_TOKEN` a `WATCHDOG_CHAT_ID`.

Skill spúšťa Claude Code so zápisom na hostiteľskom počítači. Plne automatický zápis
(`permissionMode=approve-all`) zapínaj až v oddelenom vývojovom účte, vo virtuálnom stroji alebo
na stroji bez produkčných tajomstiev. Skill obmedzuje pracovný priečinok a používa Git worktree,
ale nenahrádza izoláciu na úrovni operačného systému.
