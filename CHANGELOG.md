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
