# Ivan App Builder v1.3.2 — OpenClaw skill

```text
Telegram
  → OpenClaw + Codex (otázky, potvrdená špecifikácia, plán, kontrola)
  → Claude Code cez oficiálny ACPX (programovanie)
  → testy/build/smoke test
  → nezávislý Codex review
  → opravné kolá s limitom (3 na úlohu, 8 na celý beh)
  → výsledok do Telegramu
```

## Čo sa stane po jednej vete v Telegrame

Napíšeš napríklad:

```text
Chcem aplikáciu na správu apartmánov. Potrebujem rezervácie,
upratovanie, náklady, fotografie a doklady.
```

Skill nezačne okamžite hádať a programovať. Najprv:

1. zopakuje, ako tvoju predstavu pochopil;
2. položí 4–7 najdôležitejších otázok;
3. podľa odpovedí sa dopýta iba na nejasnosti, ktoré menia funkcie, používateľov, práva, dáta, integrácie, cenu alebo bezpečnosť;
4. rozdelí požiadavky na **prvú verziu**, **neskôr** a **mimo rozsahu**;
5. pošle úplný súhrn aplikácie, acceptance criteria a prvý funkčný krok;
6. vyžiada si potvrdenie `SCHVAĽUJEM` (stačí aj jednoznačné „áno, sedí“ / „môžeš začať“);
7. až potom vytvorí projekt a spustí Claude Code.

Ak niečo nevieš, ponúkne možnosti a odporučí praktický predvolený variant. Nemá ťa skúšať z databáz či frameworkov. Ak počas vývoja objaví nejasnosť, ktorá by zmenila potvrdené správanie, zastaví sa a opýta sa. Drobné bezpečné technické detaily rozhodne sám a uvedie v reporte.

Aplikáciu následne nestavia jedným nekontrolovaným promptom. Rozdelí potvrdené MVP na spustiteľné funkčné časti. Claude Code programuje; OpenClaw/Codex kontroluje diff, testy a reálne správanie a vracia Claudeovi konkrétne opravy.

## Režimy kontroly a limity opráv (v1.3+)

- Agent si podľa rizika sám vyberie režim **FAST** (malá bezpečná zmena), **STANDARD** (bežná feature, default) alebo **DEEP** (nová aplikácia, auth/platby/citlivé dáta, riskantné migrácie). Pri neistote volí vyšší; pri náraste rizika eskaluje. Používateľ môže režim vyžiadať slovami („urob to rýchlo“ / „dôkladne to skontroluj“), ale bezpečnostne kritickú zmenu agent v FAST režime nevykoná.
- Webové aplikácie majú povinný browser/UI smoke test (hlavný flow, desktop aj mobilná šírka, screenshot ako dôkaz); bez neho sa web v režime DEEP nesmie vyhlásiť za plne overený.
- Opravné kolá sú limitované: 3 na úlohu a 8 na celý beh — potom agent zastane a pýta si rozhodnutie; súhlas pridá len malý ďalší budget (+3).
- Mobilné aplikácie (natívne aj cross-platform: React Native/Expo/Flutter/Capacitor/Ionic) sa overujú v reálnom virtuálnom zariadení — Android Emulator, prípadne iOS Simulator na macOS. Úzky browser viewport nestačí. Bez dostupného emulátora sa výsledok označí ako čiastočne overený a nikdy sa nefabrikuje (v1.3.1).
- Beh si priebežne píše stav do `.app-builder/run-state.md` vrátane riadku `Status:`. Na tomto PC ho každých 10 minút číta nezávislý watchdog (`OpenClaw-AppBuilder-Watchdog`), ktorý ti napíše na Telegram, keď sa stavba zasekne, keď narazia na limit všetky modely alebo keď spadne gateway — píše priamo cez Telegram API, takže funguje aj vtedy, keď žiadny agent nedokáže odpovedať (v1.3.2).

## Obsah balíka

- `SKILL.md` — orchestrácia, režimy kontroly a tvrdá potvrdzovacia brána
- `references/discovery-interview.md` — adaptívny produktový rozhovor
- `references/discovery-smoke-test.md` — poinštalačný test potvrdzovacej brány
- `references/claude-worker-prompt.md` — zadanie pre Claude Code
- `references/review-rubric.md` — nezávislá kontrola Codexom
- `references/project-contract.md` — pravidlá potvrdenej špecifikácie
- `references/setup-and-recovery.md` — inštalácia a obnova
- `references/telegram-report.md` — otázky, potvrdenie, reporty a eskalácia budgetu
- `templates/APP_SPEC.template.md` — produktová špecifikácia
- `templates/TASKS.template.md` — projektové úlohy
- `config/app-builder.example.json5` — konfiguračný fragment
- `PROMPT-PRE-CLAUDE-CODE.md` — prompt na bezpečnú inštaláciu
- `CHANGELOG.md` — história verzií
- `MANIFEST.txt` — zoznam súborov balíka
- `CHECKSUMS.sha256` — kontrolné súčty súborov

## Inštalácia

```bash
openclaw skills install ./ivan-app-builder-v1.3.2 --global
openclaw gateway restart
openclaw skills list
```

Odporúčané je mať samostatného OpenClaw agenta alebo Telegram topic `APP BUILDER`, ktorý používa natívny Codex ako nadradeného agenta a Claude Code cez oficiálny ACPX.

Oficiálne runtime komponenty:

```bash
openclaw plugins install @openclaw/codex
openclaw models auth login --provider openai
openclaw config set plugins.entries.codex.enabled true

openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true

claude auth status
openclaw gateway restart
```

Potom over:

```text
/status
/codex status
/acp doctor
```

## Použitie

Pri dedikovanom App Builder agentovi stačí prirodzená veta. Explicitne môžeš použiť:

```text
/ivan-app-builder new /srv/projects/apartment-manager —
Chcem aplikáciu na správu apartmánov s rezerváciami,
upratovaním, nákladmi, fotografiami a dokladmi.
```

Očakávaná prvá odpoveď sú otázky, nie kód.

## Bez tvojho súhlasu neurobí

- nezačne novú aplikáciu pred potvrdením produktového súhrnu;
- merge do hlavnej vetvy;
- deploy;
- produkčnú migráciu;
- zmenu secrets, DNS alebo platieb;
- force-push alebo mazanie dát.

ACP Claude beží na hostiteľovi. Plnoautomatický zápis povoľ až v oddelenom vývojovom účte, VM alebo serveri bez produkčných tajomstiev. Skill obmedzuje `cwd` a Git worktree, ale nenahrádza izoláciu operačného systému.

## Host review gate (1.6.3)

Phase 7 teraz vykonáva externý runner, nie rodičovský model. Nainštaluj oba skripty podľa
[review-runner.md](references/review-runner.md) a doplň [workspace pravidlá](references/host-workspace-rules.md).
DONE vyžaduje platné testy, nezávislú review aktuálneho kódu a host completion. GPT fallback
začína Fable; slabší same-family fallback sa vždy prizná.
