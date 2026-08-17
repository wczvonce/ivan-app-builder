# Prompt pre Claude Code: bezpečná inštalácia Ivan App Builder

Skopíruj nasledujúci prompt do Claude Code na počítači/serveri, kde beží OpenClaw. Priečinok `ivan-app-builder` musí byť na tom počítači dostupný.

```text
Chcem bezpečne nainštalovať lokálny OpenClaw skill „ivan-app-builder“ a pripraviť oficiálnu kombináciu OpenClaw native Codex + ACPX pre Claude Code.

Dôležité pravidlá:
- Najprv iba skontroluj stav; nič neprepisuj naslepo.
- Zisti aktuálnu verziu OpenClawu a použi jej živú config schému (`openclaw config schema` alebo presný schema lookup), nie zastarané domnienky.
- Pred zmenou vytvor časovo označenú zálohu `~/.openclaw/openclaw.json` a ukáž mi plánovaný diff.
- Použi iba oficiálne pluginy `@openclaw/codex` a `@openclaw/acpx`.
- Použi `config/app-builder.example.json5` iba ako merge fragment a porovnaj ho so živou schémou. Nikdy ním nenahrádzaj celú konfiguráciu.
- Nežiadaj odo mňa, aby som vložil token alebo heslo do chatu či súboru. OAuth login spustím interaktívne.
- Nemeň Telegram binding ani môjho hlavného agenta bez môjho výslovného súhlasu.
- Nezapínaj `permissionMode=approve-all` automaticky. Najprv mi vysvetli riziko, skontroluj, či ide o oddelený vývojový účet/VM bez produkčných tajomstiev, a vyžiadaj si explicitné schválenie.
- Nezapínaj ACP plugin-tools ani OpenClaw-tools MCP bridge.
- Nevytváraj verejnú službu ani nezdieľaj moje Claude/OpenAI prihlasovanie.

Postup:
1. Over `openclaw --version`, `openclaw doctor`, stav Gateway a cestu ku konfigurácii.
2. Over `git`, `claude auth status` a prítomnosť priečinka so skillom.
3. Skontroluj, či sú pluginy Codex a ACPX už nainštalované/aktivované.
4. Ak chýbajú, priprav presné oficiálne príkazy, potom ich po mojom schválení vykonaj:
   - `openclaw plugins install @openclaw/codex`
   - `openclaw models auth login --provider openai` (interaktívne nechaj na mňa)
   - `openclaw config set plugins.entries.codex.enabled true`
   - `openclaw plugins install @openclaw/acpx`
   - `openclaw config set plugins.entries.acpx.enabled true`
5. Skontroluj `config/app-builder.example.json5`. Navrhni bezpečný merge pre samostatného `app-builder` agenta: native Codex cez model-scoped `agentRuntime.id: "codex"`, profil `coding`, skill allowlist, `sandbox.mode="off"` iba na izolovanom OS používateľovi/VM a `acp.allowedAgents=["claude"]`. Ukáž mi presný diff a nič nemerguj bez schválenia.
6. Nainštaluj lokálny skill z presnej cesty príkazom `openclaw skills install <PATH>/ivan-app-builder-v1.2.0 --global`, iba ak `SKILL.md` prejde kontrolou, deklaruje verziu minimálne `1.2.0`, odkazuje na `references/discovery-interview.md` a cesta je správna.
7. Spusti `openclaw config validate` a reštartuj Gateway až po schválených zmenách.
8. Over:
   - `openclaw skills list`
   - health Gateway
   - native Codex stav
   - ACPX cez `/acp doctor` alebo zodpovedajúci CLI/gateway test
   - že nainštalovaný `SKILL.md` obsahuje povinný `Product discovery and explicit confirmation` a verziu aspoň `1.2.0`
   - bezpečný discovery dry-run podľa `references/discovery-smoke-test.md`: pri požiadavke typu „Chcem aplikáciu na správu apartmánov“ musí agent najprv položiť doplňujúce otázky a nesmie ešte vytvoriť repozitár ani spustiť Claude ACP session
   - až potom jednorazový bezpečný Claude ACP smoke test v dočasnom prázdnom Git repozitári, ktorý vytvorí iba jednoduchý textový súbor a následne sa odstráni
9. Na konci mi daj presný súhrn: zmenené súbory, config diff, verzie, výsledok discovery dry-runu, testy, čo ešte vyžaduje login alebo moje rozhodnutie.

Ak sa živá dokumentácia alebo config schéma líši od uvedených príkazov, zastav sa, ukáž rozdiel a použi aktuálnu oficiálnu schému. Nerob kompatibilitné obchádzky cez neoverené komunitné pluginy.
```
