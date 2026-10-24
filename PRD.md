# PRD — `agy` Plugin para Claude Code (`antigravity-cc`)

## 1. Visión del Producto
Plugin nativo para **Claude Code** (`/agy:*` + subagente autónomo `agy:agy-rescue`) que replica y amplía las capacidades de `openai/codex-plugin-cc`, conectando Claude Code con **Google Antigravity** en **modo dual**:
1. **Motor Primario (`desktop-live`):** Conexión directa por autodescubrimiento al proceso local `language_server.exe` de **Antigravity 2.0 Desktop** (`agentapi` + Connect RPC sobre HTTP/JSON), abriendo/enfocando conversaciones en vivo (`SmartFocusConversation`), esperando finalización real (`WaitForConversationFullyIdle`) y recolectando respuestas, razonamiento y diffs (`GetCascadeTrajectory`, `GetTrajectoryFileDiffs`).
2. **Motor Secundario (`cli-headless`):** Fallback automático al CLI oficial `agy` (`--print --output-format stream-json` + `--conversation <id>`) cuando la aplicación de escritorio esté cerrada.

## 2. Requerimientos Funcionales Atómicos

| ID | Módulo | Descripción Atómica | Validación / Test |
| :--- | :--- | :--- | :--- |
| **RF-01** | `lib/args.mjs` | Parseo de argumentos CLI y cadenas crudas `$ARGUMENTS` de slash commands (`--model`, `--background`, `--wait`, `--resume`, `--fresh`, `--handoff-only`). | `tests/test_args.mjs` |
| **RF-02** | `lib/state.mjs` & `lib/git.mjs` | Persistencia por workspace (`state.json`, `jobs/<id>.json`, `jobs/<id>.log`, `handoffs/`) e inspección `git status`/`git diff` para reviews. | `tests/test_state_git.mjs` |
| **RF-03** | `lib/claude-session-parser.mjs` | Localización automática del `.jsonl` activo de Claude Code (por `AGY_COMPANION_TRANSCRIPT_PATH` o escaneo inteligente de `~/.claude/projects/`) y compilación limpia del Handoff Markdown + detección del siguiente paso pendiente. | `tests/test_claude_session_parser.mjs` |
| **RF-04** | `lib/ls-discovery.mjs` | Autodescubrimiento multiplataforma (Windows PowerShell CIM/TCP y POSIX `ps`/`lsof`) del `language_server` activo de Antigravity 2.0, verificación `Heartbeat` y detección de `agy` CLI. | `tests/test_ls_discovery.mjs` |
| **RF-05** | `lib/agy-runtime.mjs` | Cliente Dual (`desktop-live` + `cli-headless`): resolución/creación de `projectId`, `new-conversation`, `send-message`, `SmartFocusConversation`, `WaitForConversationFullyIdle`, extracción de `PLANNER_RESPONSE`/`touchedFiles` y `CancelCascadeInvocation`. | `tests/test_agy_runtime.mjs` |
| **RF-06** | `agy-companion.mjs` & Hooks | CLI unificado (`setup`, `task`, `transfer`, `review`, `adversarial-review`, `status`, `result`, `cancel`), worker background desacoplado, `session-lifecycle-hook.mjs` (`SessionStart`/`SessionEnd`) y `stop-review-gate-hook.mjs` (`Stop`). | `tests/test_companion_cli.mjs` |
| **RF-07** | Manifiestos `.claude-plugin`, Commands, Subagent & Skills | Comandos `/agy:setup`, `/agy:rescue`, `/agy:transfer` (con ejecución automática del siguiente paso), `/agy:review`, `/agy:adversarial-review`, `/agy:status`, `/agy:result`, `/agy:cancel`, subagente `agy-rescue` y validación e instalación oficial vía `claude plugin`. | `claude plugin validate` + E2E real |
