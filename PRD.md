# PRD — `claude-antigravity` (`/agy:*` Plugin & Multimodal Bridge for Claude Code)

## 1. Visión del Producto
Plugin Open Source de referencia (`JoseAQ-19/claude-antigravity`, comandos `/agy:*` + subagente `agy:agy-rescue` + skill universal `skills.sh`) que conecta **Claude Code** con **Google Antigravity 2.0 Desktop IDE** y el **CLI `agy`** en modo dual bidireccional:
1. **Motor Primario (`desktop-live`):** Conexión directa por autodescubrimiento al proceso local `language_server` de **Antigravity 2.0 Desktop** (`agentapi` + Connect RPC sobre HTTP/JSON), abriendo/enfocando conversaciones en vivo, importando trayectorias de vuelta, consultando cuotas reales y controlando pasos (`Fork`/`Revert`).
2. **Motor Secundario (`cli-headless`):** Fallback automático al CLI oficial `agy` (`--print --output-format stream-json` + `--conversation <id>`) y lectura local de `~/.gemini/antigravity/brain` cuando la app de escritorio está cerrada.

## 2. Requerimientos Funcionales Atómicos

| ID | Módulo | Descripción Atómica | Validación / Test |
| :--- | :--- | :--- | :--- |
| **RF-01** | `lib/args.mjs` | Parseo de argumentos CLI y cadenas `$ARGUMENTS` de slash commands. | `tests/test_args.mjs` |
| **RF-02** | `lib/state.mjs` & `lib/git.mjs` | Persistencia por workspace e inspección `git status`/`git diff` preservando columnas iniciales y rutas UTF-8. | `tests/test_state_git.mjs` |
| **RF-03** | `lib/claude-session-parser.mjs` | Localización del `.jsonl` activo de Claude Code y compilación de `/agy:transfer` con ejecución automática del siguiente paso. | `tests/test_claude_session_parser.mjs` |
| **RF-04** | `lib/ls-discovery.mjs` | Autodescubrimiento multiplataforma (Windows PowerShell CIM/TCP, macOS Apple Silicon/Intel `ps -axww` + `lsof`, Linux `ss -tlnp`). | `tests/test_ls_discovery.mjs` |
| **RF-05** | `lib/agy-runtime.mjs` | Cliente Dual (`desktop-live` + `cli-headless`) con degradación elegante `404/501`, fallback `git status` y timeout anti-ConPTY. | `tests/test_agy_runtime.mjs` |
| **RF-06** | `agy-companion.mjs` & Hooks | CLI unificado, worker background, `session-lifecycle-hook.mjs` (con deduplicación `CLAUDE_ENV_FILE`) y `stop-review-gate-hook.mjs`. | `tests/test_companion_cli.mjs` |
| **RF-07** | `/agy:pull` (`lib/agy-inspector.mjs`) | Teletransporte inverso en vivo (`Antigravity 2.0 → Claude Code`) vía `GetAllCascadeTrajectories` + `ConvertTrajectoryToMarkdown` + fallback offline `transcript.jsonl`. | `tests/test_inspector_rpc.mjs` |
| **RF-08** | `/agy:review-plan` (`lib/media-plan-memory.mjs`) | Autodetección de planes (`~/.claude/plans`, `PLAN.md`, `PRD.md` o `.jsonl`) y auditoría arquitectónica/YAGNI pre-código. | `tests/test_media_plan_memory.mjs` |
| **RF-09** | `--worktree` & `/agy:race` (`lib/worktree.mjs`) | Ejecución paralela sin colisiones en `git worktree` temporal aislado, generación/aplicación de parches y modo competición Claude vs Antigravity. | `tests/test_worktree.mjs` |
| **RF-10** | `/agy:media` (`lib/media-plan-memory.mjs`) | Percepción multimodal nativa (vídeo `.mp4`/`.mov`, audio `.mp3`/`.wav`, PDF e imágenes) con correlación de código y archivo de transcripción fuera del contexto de Claude. | `tests/test_media_plan_memory.mjs` |
| **RF-11** | `/agy:quota` (`lib/agy-inspector.mjs`) | HUD en tiempo real de modelos disponibles, barras de cuota restante (`GetCascadeModelConfigData`), tiempos de reinicio y tier de cuenta (privacidad por defecto). | `tests/test_inspector_rpc.mjs` |
| **RF-12** | `/agy:undo` & `/agy:fork` (`lib/agy-inspector.mjs`) | Control quirúrgico de conversaciones vía `GetRevertPreview` / `RevertToCascadeStep` (+ fallback git) y bifurcación `ForkConversation`. | `tests/test_inspector_rpc.mjs` |
| **RF-13** | `/agy:sync-memory` (`lib/media-plan-memory.mjs`) | Sincronización bidireccional no destructiva con backup entre `CLAUDE.md` y `AGENTS.md` / `GEMINI.md` / `.agents/rules/`. | `tests/test_media_plan_memory.mjs` |
| **RF-14** | Gobernanza, Naming & Release (`claude-antigravity`) | Identidad libre de colisiones `JoseAQ-19/claude-antigravity` (`agy@claude-antigravity`), CI multi-OS, `Apache-2.0` y `README.md` insignia. | `tests/test_release_readiness.mjs` |
