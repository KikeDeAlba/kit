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
- `envFor` en un perfil no builtin quita las credenciales de la shell por
  prefijo (`ANTHROPIC_*`, `OPENAI_*`, `AWS_BEARER_*`, `CLAUDE_CODE_USE_*`) y por
  nombre (`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY`, `GEMINI_API_KEY`,
  `GOOGLE_API_KEY`) para cualquier harness, también gemini, opencode y
  antigravity.
- Un `KIT_CONFIG_DIR` relativo se ignora y se usa la raíz por defecto; las rutas
  de perfil relativas hacen `PROFILES_INVALID`.
- `withFileLock` excluye entre procesos: crea el candado con `link` atómico, guarda
  un token propio, refresca su fecha mientras dura la sección crítica, roba un
  candado viejo renombrándolo y solo libera el suyo. En Windows, `rename` y `rm`
  reintentan ante `EPERM`, `EBUSY` y `EACCES`.
- `repairSharedLinks` trata como enlazado un home de perfil que resuelve al
  compartido y no mueve nada.
- `rules.baseBranch` solo acepta `A-Z`, `a-z`, `0-9`, `.`, `_`, `/` y `-`, además
  de las reglas de git.
