# Changelog

## 0.8.0 (sin publicar)

- Nuevos módulos `profiles`, `settings`, `harness` y `catalog`, más
  `schemas/catalog.v1.json` y `schemas/profiles.v1.json` en el paquete.
- `writeFileAtomic` y `withFileLock` exportados desde la raíz y desde
  `@kikedealba/kit/atomic`. Las escrituras atómicas siguen symlinks (también
  colgantes), usan un temporal con nombre aleatorio y conservan el modo del
  archivo existente.
- Los comandos que corre kit (`claude plugin …`, `claude mcp …`, `agy plugin …`)
  usan `ctx.env`.
- `KIT_ANTIGRAVITY_HOME` cambia el home de Antigravity.
- Los hijos headless reciben `DEN_PROFILE` (solo esa variable de `DEN_*`).
- Adaptadores de agentes movidos desde bita. **Cambio de comportamiento:** sin
  `baseEnv` ya no ponen `BITA_CHILD` ni quitan `BITA_WRAPPER_ID`,
  `BITA_HARNESS` ni `BITA_SESSION_PROJECT`; bita debe pasar su `childEnv()` como
  `baseEnv`. Los avisos de flags descartados ya no llevan el prefijo `bita:`.
- `envFor` en un perfil no builtin, con `claude`, `codex` o `all`, quita solo
  las credenciales de la cuenta del agente: `ANTHROPIC_*`, `OPENAI_*`,
  `AZURE_OPENAI_*`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_OAUTH_*`,
  `CLAUDE_CODE_API_KEY*`, `GOOGLE_GENAI_*`, `AWS_BEARER_TOKEN_BEDROCK`,
  `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` y
  `CLOUD_ML_REGION` (`PROFILE_SECRET_ENV`, `PROFILE_SECRET_ENV_PREFIXES`,
  `isProfileSecretEnv`). `GITHUB_TOKEN`, `NPM_TOKEN` y las credenciales `AWS_*`
  de trabajo pasan. Con gemini, opencode y antigravity aplica la semántica del
  builtin y no quita nada.
- `harnessEnv` sin perfil se comporta como el builtin: quita `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME` y `DEN_PROFILE` heredados.
- `settings.json` de Claude deja de ser symlink: cada perfil recibe una copia
  filtrada (sin `apiKeyHelper`, `awsCredentialExport`, `awsAuthRefresh`,
  `otelHeadersHelper` ni credenciales en `env`) con su hash en `.den-shared.json`.
  Nuevos estados `generated`, `stale` y `drifted`, `syncSharedCopies(n)`,
  `filterSharedClaudeSettings`, `SHARED_COPIES` y el campo `strategy` en
  `SharedLinkSpec`. Codex `config.toml` ya no se comparte. El filtro también
  quita `gcpAuthRefresh` (claves sin distinguir mayúsculas) y, en `env`,
  `OTEL_*HEADERS*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` y `DEN_PROFILE`. Un
  compartido inválido da `invalid-shared` en inspect; sync y repair lanzan
  `SHARED_COPY_INVALID` antes de tocar nada. Hooks, `statusLine` y
  `fileSuggestion` se copian tal cual.
- Homes de perfil repetidos o iguales al compartido: la lectura no falla,
  `addProfile` lanza `PROFILE_HOME_CONFLICT`, `profileHomeConflicts(n)` los lista
  e inspect da `home-conflict`; sync y repair lanzan `PROFILE_HOME_SHARED` si un
  home resuelve al compartido (antes repair lo trataba como enlazado).
- `removeProfile` devuelve `logoutRequired`, `true` solo en macOS.
- Transcripciones confinadas al home: Claude a `projects/`, Codex a `sessions/` y
  `archived_sessions/`, Gemini a `tmp/`. `sessionId` validado con
  `SESSION_ID_PATTERN` (`^\w[\w-]*$`), también en opencode antes de
  `session export`.
- El resumen de opencode usa `--agent plan` y un `opencode.json` que niega
  `bash`, `edit`, `webfetch` y `write` (`OPENCODE_SUMMARY_CONFIG`).
- `session.summary.<h>.model` usa `MODEL_PATTERN` (ahora exportado y con `/`,
  `#` y `:`); `harness.<h>.extraArgs` rechaza saltos de línea y NUL. La raíz de
  configuración se crea con `0700` (`ensureKitConfigRoot`).
- `upsertMemoryBlock` con un `begin` sin `end` reemplaza desde ahí hasta el final
  en vez de duplicar el bloque y avisa por el callback opcional `onWarning`.
- Un `KIT_CONFIG_DIR` relativo se ignora y se usa la raíz por defecto; las rutas
  de perfil relativas hacen `PROFILES_INVALID`.
- `withFileLock` excluye entre procesos: crea el candado con `link` atómico, guarda
  un token propio, refresca su fecha mientras dura la sección crítica, roba un
  candado viejo renombrándolo y solo libera el suyo. En Windows, `rename` y `rm`
  reintentan ante `EPERM`, `EBUSY` y `EACCES`.
- `rules.baseBranch` solo acepta `A-Z`, `a-z`, `0-9`, `.`, `_`, `/` y `-`, además
  de las reglas de git.
