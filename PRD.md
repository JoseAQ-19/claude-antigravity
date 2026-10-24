# PRD — `agy` Plugin para Claude Code (`claude-antigravity-bridge` / `antigravity-live`)

## 1. Visión del Producto
Plugin nativo Open Source para **Claude Code** (`/agy:*` + subagente autónomo `agy:agy-rescue` + skill universal `skills.sh`) que replica y supera las capacidades de `openai/codex-plugin-cc`, conectando Claude Code con **Google Antigravity** en **modo dual**:
1. **Motor Primario (`desktop-live`):** Conexión directa por autodescubrimiento al proceso local `language_server` de **Antigravity 2.0 Desktop** (`agentapi` + Connect RPC sobre HTTP/JSON), abriendo/enfocando conversaciones en vivo (`SmartFocusConversation`), esperando finalización real (`WaitForConversationFullyIdle`) y recolectando respuestas, razonamiento y diffs (`GetCascadeTrajectory`, `GetTrajectoryFileDiffs`).
2. **Motor Secundario (`cli-headless`):** Fallback automático al CLI oficial `agy` (`--print --output-format stream-json` + `--conversation <id>`) cuando la aplicación de escritorio esté cerrada o si un endpoint interno falla antes de iniciar sesión.

## 2. Requerimientos Funcionales Atómicos

| ID | Módulo | Descripción Atómica | Validación / Test |
| :--- | :--- | :--- | :--- |
| **RF-01** | `lib/args.mjs` | Parseo de argumentos CLI y cadenas crudas `$ARGUMENTS` de slash commands (`--model`, `--background`, `--wait`, `--resume`, `--fresh`, `--handoff-only`). | `tests/test_args.mjs` |
| **RF-02** | `lib/state.mjs` & `lib/git.mjs` | Persistencia por workspace (`state.json`, `jobs/<id>.json`, `jobs/<id>.log`, `handoffs/`) e inspección `git status`/`git diff` para reviews. | `tests/test_state_git.mjs` |
| **RF-03** | `lib/claude-session-parser.mjs` | Localización automática del `.jsonl` activo de Claude Code (por `AGY_COMPANION_TRANSCRIPT_PATH` o escaneo inteligente de `~/.claude/projects/`) y compilación limpia del Handoff Markdown + detección del siguiente paso pendiente. | `tests/test_claude_session_parser.mjs` |
| **RF-04** | `lib/ls-discovery.mjs` | Autodescubrimiento multiplataforma (Windows PowerShell CIM/TCP y POSIX `ps` + `lsof` / fallback Linux `ss -tlnp`) del `language_server` activo de Antigravity 2.0, verificación `Heartbeat` y detección de `agy` CLI. | `tests/test_ls_discovery.mjs` |
| **RF-05** | `lib/agy-runtime.mjs` | Cliente Dual (`desktop-live` + `cli-headless`) con degradación elegante ante cambios de Connect RPC (`404/501`), fallback `git status` para archivos tocados, guardián de timeout en CLI y cancelación limpia. | `tests/test_agy_runtime.mjs` |
| **RF-06** | `agy-companion.mjs` & Hooks | CLI unificado (`setup`, `task`, `transfer`, `review`, `adversarial-review`, `status`, `result`, `cancel`), worker background desacoplado, `session-lifecycle-hook.mjs` (`SessionStart`/`SessionEnd`) y `stop-review-gate-hook.mjs` (`Stop`). | `tests/test_companion_cli.mjs` |
| **RF-07** | Manifiestos `.claude-plugin`, Commands, Subagent & Skills | Comandos `/agy:*`, subagente `agy-rescue` y marketplace libre de colisiones (`antigravity-live`), validados e instalados vía `claude plugin`. | `claude plugin validate` + E2E real |
| **RF-08** | Distribución Omnicanal (`skills.sh`) | Skill universal `skills/antigravity-bridge/SKILL.md` compatible con `npx skills add` sin penalizar el presupuesto de tokens de `plugins/agy`. | `tests/test_release_readiness.mjs` |
| **RF-09** | Suite CI Hermética + Sanitización | Separación estricta entre `npm test` (100 % hermético/mockeado para CI Linux/macOS/Windows, cero rutas personales) y `npm run test:live` (E2E real contra Antigravity 2.0 Desktop), más validador `scripts/verify-release.mjs` y `.github/workflows/ci.yml`. | `tests/test_release_readiness.mjs` |
| **RF-10** | Gobernanza Open Source | `LICENSE` (Apache-2.0), `NOTICE` (atribución + disclaimer de marcas Google/Anthropic), `SECURITY.md` (garantía Zero-OAuth-Scraping), `CONTRIBUTING.md`, `CHANGELOG.md`, plantillas GitHub y `README.md` de producción (EN/ES). | `npm run verify` |
