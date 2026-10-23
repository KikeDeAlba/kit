# kit

El contrato común de las herramientas `@kikedealba`: **bita** (tiempo), **atl**
(Atlassian), **inkwell** (documentación), **recap** (reuniones) y **Den** (la app
de escritorio).

Ninguna herramienta depende de otra. Todas dependen solo de `kit`, y por medio de
él se encuentran cuando están instaladas juntas: una herramienta que no está
simplemente no aparece, y lo que dependía de ella falla con un error claro y una
pista de cómo instalarla.

`kit` es una librería sin dependencias de ejecución. Trae además una CLI pequeña
para ver qué hay instalado.

## Requisitos

Node 24 o superior. Funciona en macOS, Windows y Linux.

## Las cinco piezas

### 1. Registro de herramientas instaladas

Cada herramienta, al correr su `setup`, deja un manifiesto en el registro:

| Sistema | Ruta |
|---|---|
| macOS / Linux | `${XDG_CONFIG_HOME:-~/.config}/kikedealba/tools.d/<herramienta>.json` |
| Windows | `%APPDATA%\kikedealba\tools.d\<herramienta>.json` |

`KIT_REGISTRY_DIR` cambia la ruta (útil en pruebas).

```json
{
  "manifestVersion": 1,
  "name": "atl",
  "version": "1.0.0",
  "bin": ["/usr/local/bin/node", "/usr/local/lib/node_modules/@kikedealba/atl/dist/bin/atl.js"],
  "envelope": 1,
  "capabilities": ["jira.issue.write", "confluence.page.write"],
  "emits": [],
  "subscribes": [],
  "mcp": { "stdio": ["atl", "mcp"], "http": "http://127.0.0.1:7781/mcp" },
  "install": "npm install -g @kikedealba/atl"
}
```

- `bin` es la línea de comando completa para invocarla, con rutas absolutas.
  Quien la llama no depende del `PATH`.
- `capabilities` son cadenas `dominio.objeto.acción`. Se pregunta por capacidad,
  no por versión, siempre que se pueda.

```ts
import { findTool, invokeTool, requireTool } from '@kikedealba/kit'

const atl = await findTool('atl', { capability: 'confluence.page.write' })
if (atl) {
  const { envelope } = await invokeTool(atl, ['confluence', 'page', 'update', '123', '--md', 'page.md'])
}

const recap = await requireTool('recap', 'npm install -g @kikedealba/recap', { minVersion: '1.0.0' })
```

`requireTool` lanza `ToolMissingError` con `code` = `<HERRAMIENTA>_MISSING` y la
pista de instalación.

### 2. Sobre JSON

Todo comando con `--json` imprime **una sola línea** con este sobre:

```json
{ "schemaVersion": 3, "ok": true, "command": "ls", "generatedAt": "2026-10-10T12:00:00.000Z", "data": {} }
{ "schemaVersion": 3, "ok": false, "command": "ls", "generatedAt": "…", "error": { "code": "NOT_FOUND", "message": "…", "hint": "…" } }
```

`schemaVersion` es la versión de los datos de cada herramienta; la forma del
sobre es la misma para todas.

Toda herramienta responde `capabilities --json`:

```json
{ "schemaVersion": 1, "ok": true, "command": "capabilities", "generatedAt": "…",
  "data": { "name": "atl", "version": "1.0.0", "envelope": 1, "capabilities": ["…"], "emits": [] } }
```

### 3. Eventos entre herramientas

Una herramienta declara en `emits` los eventos que dispara. Otra se suscribe
desde **su propio** manifiesto, sin tocar la configuración de la primera:

```json
"subscribes": [
  {
    "tool": "bita",
    "events": ["start", "stop", "cancel", "amend"],
    "filter": { "kind": ["remote-meeting", "in-person-meeting"] },
    "command": ["/abs/node", "/abs/recap.js", "bita-hook"]
  }
]
```

El emisor llama a `fireEvents`, que lee los suscriptores del registro, aplica el
filtro y lanza cada comando desacoplado, con el documento del evento por stdin y
`KIT_EVENT` / `KIT_EVENT_SOURCE` en el entorno. `KIT_NO_EVENTS=1` los apaga; así
una herramienta que responde a un evento no dispara otro en cadena.

### 4. Integración con agentes de código

`agents.installIntegration` instala skills, comandos, subagentes, memoria global, hooks y servidores MCP en
los agentes que encuentre: **Claude Code, opencode, Codex, Gemini CLI y Antigravity CLI** (`agy`), más
los servidores MCP de **Claude Desktop**.

| | Claude Code | opencode | Codex | Gemini CLI | Antigravity CLI |
|---|---|---|---|---|---|
| Skill | `~/.claude/skills/<n>` | `~/.config/opencode/skills/<n>` | `~/.agents/skills/<n>` | extensión `skills/<n>` | plugin `skills/<n>` |
| Comandos | `~/.claude/commands/*.md` | `~/.config/opencode/commands/*.md` | `~/.codex/prompts/*.md` | extensión `commands/*.toml` | no soportado (`skipped`) |
| Hooks | `settings.json` | plugin | `~/.codex/hooks.json` | extensión `hooks/hooks.json` | no soportado |
| MCP | `claude mcp add --scope user` | `opencode.json` | `config.toml` | `gemini-extension.json` | `~/.gemini/config/mcp_config.json` |
| Subagentes | `~/.claude/agents/<n>.md` | `~/.config/opencode/agents/<n>.md` | `~/.codex/agents/<n>.toml` | extensión `agents/<n>.md` | plugin `agents/<n>.md` |
| Memoria | `~/.claude/CLAUDE.md` | `~/.config/opencode/AGENTS.md` | `~/.codex/AGENTS.md` | `~/.gemini/GEMINI.md` | `~/.gemini/GEMINI.md` (mismo bloque que Gemini) |

Para Gemini se escribe una extensión completa en
`~/.gemini/extensions/<herramienta>/`. Gemini se detecta por el binario `gemini` o
por la carpeta `~/.gemini/extensions`; `~/.gemini` sola ya no basta porque
Antigravity también la crea.

Para Antigravity kit genera un plugin en
`<XDG_DATA_HOME>/kikedealba/agents/antigravity/<herramienta>/` (se borra y se
regenera en cada instalación) con `plugin.json`, `agents/`, `skills/` (de
`skills` y `userSkills`, con el frontmatter reducido a `name` y `description`) y
`rules/<herramienta>.md` si la integración trae `antigravity.rules` (se escribe con
`trigger: always_on`). Luego lo instala con `agy`:

1. `agy plugin list --json`; si ya está y su carpeta es idéntica, sale `present`.
2. `agy plugin validate <raíz> --strict --json`; si falla, sale `failed` y no se
   instala.
3. `agy plugin install <raíz>`.

Sin `agy` en el `PATH` el plugin se genera igual y el paso sale `unavailable` con
el comando a correr. Antigravity se detecta por el binario `agy` o por
`~/.gemini/config` (se cambia con `homes.antigravity`). Desinstalar corre
`agy plugin uninstall <herramienta>`.

Los plugins de `agy` no admiten hooks ni servidores MCP, así que los servidores MCP
se escriben directo en `<homes.antigravity>/mcp_config.json`, sin pasar por
`agy mcp`. Cada servidor queda bajo `mcpServers.<nombre>` como
`{ command, args, env?, disabled: false, _kit: "<herramienta>" }` o, si es remoto,
`{ serverUrl, headers?, disabled: false, _kit: "<herramienta>" }`. `_kit` marca la
entrada como propia: `agy` lo conserva al reescribir el archivo. Si ya hay una
entrada con el mismo nombre sin esa marca, no se pisa y el paso sale `skipped`
con el conflicto en `detail`. Las demás claves del archivo se conservan, la
escritura es atómica, conserva el modo del archivo (o `0600` si es nuevo) y deja
`mcp_config.json.backup`. Un archivo vacío cuenta como `{}`; uno con JSON
inválido no se toca y el paso sale `failed`. `uninstallIntegration` quita solo
las entradas con la marca de la herramienta.

#### Binarios de los agentes

`detectAgents` y la instalación buscan cada binario con `findAgentBinary`
(`findAgentBinarySync` en la versión síncrona), que no se queda en el `PATH`.
Esto importa cuando la herramienta corre desde un hook o una app de escritorio y
no hereda el `PATH` de la terminal. El orden de búsqueda es este:

1. `override`, si se pasa. Si no es ejecutable devuelve `null` y no sigue buscando.
2. El `PATH` y luego `defaultSearchDirs`.
3. Los gestores de Node, con `toolchainSearchDirs`: `NVM_BIN`,
   `~/.nvm/versions/node/*/bin` de la versión más nueva a la más vieja, el alias
   `default` de fnm, Volta, `NPM_CONFIG_PREFIX`, `~/.npm-global/bin`, pnpm, Bun y
   `~/.local/bin`. En Windows también `%APPDATA%\npm` y `%LOCALAPPDATA%\Volta\bin`.
4. Las carpetas propias de cada agente, con `agentSearchDirs`:
   `~/.gemini/antigravity-cli/bin` (agy), `~/.opencode/bin` y `~/.claude/local`.

#### Agentes sin interfaz (headless)

`runHeadless` corre un prompt en cualquiera de los agentes de `HEADLESS_AGENTS`
y devuelve el texto de la respuesta, más el id de sesión si lo hay:

```ts
import { agents } from '@kikedealba/kit'

const picked = await agents.pickHeadlessAgent(config.agent ?? 'claude')
if (!picked) throw new Error('no hay ningún agente instalado')
if (picked.fallback) console.warn(`usando ${picked.agent}`)
const { text, sessionId } = await agents.runHeadless({ agent: picked.agent, bin: picked.bin, prompt, cwd, access: 'read' })
```

El prompt va por stdin en todos los agentes salvo `agy`, que no lo lee y lo recibe
como `--print=<prompt>`, así un prompt que empieza con `-` no se toma como flag.

| Agente | Invocación | `access: 'read'` (por omisión) | `access: 'write'` | Respuesta |
|---|---|---|---|---|
| claude | `claude -p --output-format json [--model m]` | `--tools Read,Grep,Glob --permission-mode plan --setting-sources user` | `--permission-mode acceptEdits` | `result`, `session_id` |
| codex | `codex exec --json -C <cwd> --skip-git-repo-check [-m m] -` | `--sandbox read-only` | `--sandbox workspace-write` | último `item.completed` con `agent_message`; id en `thread.started` |
| gemini | `gemini -o json [-m m]` | `--approval-mode plan`, sin `GEMINI_CLI_TRUST_WORKSPACE` | `--approval-mode auto_edit` y `GEMINI_CLI_TRUST_WORKSPACE=true` | `response`, `session_id` |
| antigravity | `agy --print=<prompt> --output-format json [--model m]` | sin flags extra | `--dangerously-skip-permissions` | `response`, `conversation_id` |
| opencode | `opencode run --format json [-m proveedor/modelo]` | `--agent plan` | agente por omisión | `part.text` de los eventos `text`, unidos; `sessionID` |

`extraArgs` va después de los flags de acceso. Si `agy` deja `response` vacío y
reporta `denied_actions`, la corrida falla con `FAILED`.

El hijo no hereda todo el entorno. `headlessEnv(agent, env)` filtra con una lista
blanca común, y bita, recap e inkwell pueden usarla para lo mismo:

- `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`/`TMP`/`TEMP`, `LANG`, `LC_*`,
  `TERM`, `XDG_*`, `NVM_*` y `KIT_HEADLESS`.
- Proxy y certificados: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` (también en
  minúsculas), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` y
  `REQUESTS_CA_BUNDLE`.
- Windows: `USERPROFILE`, `USERNAME`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`,
  `LOCALAPPDATA`, `PROGRAMDATA`, `SystemRoot`, `SystemDrive`, `WINDIR`, `ComSpec` y
  `PATHEXT`.

A eso se suman solo los prefijos del agente que corre:

| Agente | Prefijos | Condicionales |
|---|---|---|
| claude | `ANTHROPIC_`, `CLAUDE_` | `AWS_*` si `CLAUDE_CODE_USE_BEDROCK`; `GOOGLE_*` y `CLOUD_ML_REGION` si `CLAUDE_CODE_USE_VERTEX` |
| codex | `OPENAI_`, `CODEX_` | |
| gemini | `GEMINI_`, `GOOGLE_` | `GOOGLE_APPLICATION_CREDENTIALS` solo si `GOOGLE_GENAI_USE_VERTEXAI` |
| antigravity | `ANTIGRAVITY_`, `GEMINI_` | |
| opencode | `OPENCODE_` | |

Así claude no ve `OPENAI_API_KEY` ni codex `ANTHROPIC_API_KEY`. Las claves de
proveedor que use opencode hay que pasarlas en `env`: lo que se pase ahí se
agrega encima y gana. Al final se fija `KIT_HEADLESS=1`, que los hooks de bita y
gaze respetan para no registrar esa sesión, y se pone la carpeta del binario al
principio del `PATH`.

El tiempo límite por omisión es de 10 minutos. Al vencer, o al abortar con
`signal`, se mata el árbol de procesos: en unix el hijo corre en su propio grupo
y se manda `SIGTERM` y luego `SIGKILL` al grupo; en Windows se usa
`%SystemRoot%\System32\taskkill.exe /T /F`.

Los fallos lanzan `HeadlessError` con un `code`, además de `exitCode`, `stdout`
y `stderr`:

| `code` | Cuándo |
|---|---|
| `UNAVAILABLE` | No se encontró el binario o no se pudo lanzar. |
| `FAILED` | Salió con código distinto de cero, el agente reportó un error en su JSON, se abortó, `cwd` no existe o el prompt trae saltos de línea y debe ir como argumento a un `.cmd`. |
| `TIMEOUT` | Se venció `timeoutMs`. |
| `PARSE` | Salió bien pero su salida no trae la respuesta. |
| `PROMPT_TOO_LONG` | El sistema rechazó la línea de comandos (`E2BIG`), o en Windows la línea ya escapada para `cmd.exe` pasa de 8191 caracteres. |

`parseHeadlessOutput(agent, stdout)` y `headlessInvocation(agent, opciones)`
están expuestos para probar sin lanzar procesos. `isHeadlessAgent` valida un id;
uno desconocido hace fallar `runHeadless` con `UNAVAILABLE`. El mensaje de error
toma la primera línea de stderr que contenga «Error», o la última si no hay. `pickHeadlessAgent(preferido)`
devuelve el preferido si está instalado. Si no, devuelve el primero disponible
de `order` (claude va primero) con `fallback: true` para que quien llama avise.

#### Subagentes

`subagents` recibe archivos en el formato de Claude Code: frontmatter con `name`,
`description`, `tools`, `model`, `effort` y `maxTurns`, y el cuerpo es el prompt.
En Claude se enlazan tal cual (o renderizados si tienen bloques `::: agent`). En
los demás agentes kit los convierte:

| Campo | opencode | Codex | Gemini CLI | Antigravity CLI |
|---|---|---|---|---|
| `description` | `description`, con `mode: subagent` | `description` | `description`, con `kind: local` | `description`, con `model: inherit` |
| `tools` | `permission` con `deny` para edit, bash, webfetch y websearch que no estén | `[features] shell_tool = false` si no hay `Bash` | `tools` con los nombres de Gemini | `tools: [...]` con los nombres de Antigravity |
| `effort` | — | `model_reasoning_effort` (`max` pasa a `xhigh`) | — | — |
| `maxTurns` | `steps` | — | `max_turns` | — |
| cuerpo | cuerpo | `developer_instructions` | cuerpo | cuerpo |

En Antigravity `Read` pasa a `view_file` y `list_dir`, `Grep` a `grep_search`,
`Glob` a `find_by_name`, `LS` a `list_dir`, `Bash` a `run_command`, `Edit` a
`replace_file_content`, `MultiEdit` a `multi_replace_file_content`, `Write` a
`write_to_file`, `WebFetch` a `read_url_content` y `WebSearch` a `search_web`. Lo
demás (`Skill`, `Agent`, `Task`, `TodoWrite`...) se descarta. Si `tools` no
viene, viene vacío o incluye `*`, se escribe la lista completa (`view_file`,
`list_dir`, `grep_search`, `find_by_name`, `run_command`, `replace_file_content`,
`multi_replace_file_content`, `write_to_file`, `read_url_content`, `search_web`),
porque sin la clave `agy` deja al subagente sin escribir ni ejecutar. Si `tools`
trae valores y ninguno existe en Antigravity, la conversión falla y el plugin no
se instala.

`model` solo se respeta en Claude. En los demás se hereda el modelo de la sesión,
porque los alias de Claude no existen ahí.

#### Memoria global

`memory` es un markdown que se escribe como bloque administrado en la memoria
global de cada agente, entre `<!-- kit:<herramienta>:begin -->` y
`<!-- kit:<herramienta>:end -->`. Lo demás del archivo no se toca: instalar de nuevo
reemplaza solo el bloque, y desinstalar lo quita. Antes de cambiar un archivo
existente se deja una copia en `<archivo>.backup`. Admite bloques `::: agent`.

Gemini y Antigravity comparten `~/.gemini/GEMINI.md`: los dos escriben el mismo
bloque, renderizado como `gemini` (`renderMemory`), así que la segunda instalación
sale `present`. Al desinstalar uno, el bloque se queda (`skipped`, "still used by")
mientras el otro siga instalado; lo quita el último. `memoryFile(agent, homes)` da
la ruta de la memoria de cada agente.

Hay una sola skill por herramienta. Lo que aplica solo a algunos agentes va en
bloques:

```md
::: agent codex opencode
Esto solo lo leen Codex y opencode.
:::

::: agent !gemini
Esto lo leen todos menos Gemini.
:::
```

Si la skill no tiene bloques se enlaza tal cual; si los tiene, se genera una copia
por agente.

`userSkills` son skills que solo dispara el usuario (`disable-model-invocation:
true`). En Claude Code viajan dentro del plugin; en opencode, Codex y Gemini kit
las convierte en comando, igual que `commands`. Como el comando es una copia del
`SKILL.md`, la skill no debe depender de otros archivos de su directorio.

En opencode, si hay un plugin que reejecuta los hooks y comandos de Claude Code
(por ejemplo `plugins/claude-compat`), kit no instala lo que se duplicaría:

- el plugin de opencode, si los hooks de la herramienta siguen en
  `~/.claude/settings.json`;
- cada comando que siga en `~/.claude/commands`.

Lo marca como `skipped` y borra la copia que había dejado antes. Las skills se
instalan siempre, y también los comandos que salen de `userSkills`, porque el
relay no los ve. `claudeCompat: false` desactiva esta detección y `true` omite el
plugin y los comandos sin revisar. El valor por defecto es `'auto'`.

#### Claude Desktop

El agente `claude-desktop` solo recibe servidores MCP, y solo los de
`claudeDesktop.mcp`. El `mcp` genérico nunca llega ahí, así que una herramienta
puede tener MCP en Claude Desktop y quedarse en skill y CLI en los demás agentes.
Si la herramienta no define `claudeDesktop`, el paso sale como `skipped`.

| Sistema | Archivo |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | no existe; el paso sale como `unavailable` |

Se detecta si existe la carpeta `Claude`. kit fusiona `mcpServers.<nombre>` y
respeta el resto del archivo (por ejemplo `preferences`); crea el archivo solo si
la carpeta ya existe. Un servidor stdio queda como `{ command, args, env: { PATH } }`,
con el directorio del `node` que corre la instalación al frente del `PATH`, porque
las apps gráficas no heredan el `PATH` de la terminal. Un servidor http queda como
`{ type: 'http', url, headers }`. Desinstalar quita solo las entradas de la
herramienta. Hay que reiniciar Claude Desktop para que los cargue.

`EDIT_TOOL_MATCHERS` da el matcher de las herramientas de edición de cada agente.
Sirve para que un hook `PostToolUse` no corra tras cada herramienta.

#### Plugins de Claude Code

En Claude Code cada herramienta se instala como plugin. El marketplace es su
propio repo de GitHub, con `.claude-plugin/plugin.json` y `marketplace.json`.

```ts
import { agents } from '@kikedealba/kit'

const spec = { marketplace: 'KikeDeAlba/bita-cli', marketplaceName: 'bita', plugin: 'bita' }
await agents.installClaudePlugin(spec)
await agents.removeLegacyClaude(integration)
await agents.installIntegration(integration, { agents: ['opencode', 'codex', 'gemini'] })
```

`installClaudePlugin` corre lo siguiente:

1. `claude plugin marketplace add <marketplace>`, si el marketplace no estaba.
2. `claude plugin marketplace update <marketplaceName>`.
3. `claude plugin install <plugin>@<marketplaceName> --scope user` si el plugin
   es nuevo, o `claude plugin update` si ya estaba.

Para saber qué hay instalado usa `claude plugin list --json`. Si no puede leerlo,
intenta instalar y después actualiza. Si `claude` no está en el PATH, devuelve un
paso `unavailable` con los comandos para correrlos a mano.
`uninstallClaudePlugin` quita el plugin y deja el marketplace, porque otro plugin
puede compartirlo.

`removeLegacyClaude` quita lo que kit 0.2 dejaba suelto en `~/.claude`:

- los enlaces de skills y comandos, solo si apuntan al paquete de la herramienta
  o a la copia que kit generó;
- los hooks y permisos de la integración en `settings.json`;
- sus servidores MCP (`claude mcp remove --scope user`), salvo con `skipMcp`.

Hay que pasarle la integración tal como la instaló la versión anterior. Si los
hooks cambiaron, los viejos no se reconocen.

Una herramienta que ya trae plugin debe llamar a `installIntegration` sin
`claude` en `agents`. Si no, vuelve a escribir en `~/.claude` lo que el plugin ya
trae y Claude Code lo carga dos veces.

#### Procesos, notificaciones y Windows

`spawnSpec(comando, args, ctx)` devuelve `{ command, args, windowsVerbatimArguments }`
listo para `spawn`. En Windows un `.cmd` o `.bat` se envuelve en
`%SystemRoot%\System32\cmd.exe /d /s /c` con cada argumento entre comillas y los
metacaracteres escapados, así un argumento con `&`, `|` o comillas no se
interpreta como comando. Un argumento con saltos de línea lanza un error, porque
`cmd.exe` corta ahí la línea. En los demás casos devuelve el comando tal cual. `run` lo usa en vez de
`shell: true`. `whichSync` es la versión síncrona de `which`, y las dos aceptan
un cuarto argumento con carpetas que se buscan después de `defaultSearchDirs`.

`notify(título, cuerpo)` muestra una notificación del sistema y devuelve `true` o
`false`, nunca lanza. El título se recorta a 256 caracteres y el cuerpo a 2000. En
macOS usa `osascript` con el texto por `argv` después de `--`, en Linux
`notify-send` con `<`, `>` y `&` escapados, y en Windows un toast de PowerShell
con `-EncodedCommand`.
`notifyCommand` da el comando sin ejecutarlo.

### 5. Credenciales

`credentialStore()` elige el almacén del sistema:

| Sistema | Almacén |
|---|---|
| macOS | Llavero (`/usr/bin/security`) |
| Windows | Administrador de credenciales (advapi32 vía PowerShell) |
| Linux | Secret Service (`secret-tool`); si no está, archivo `0600` |

`KIT_CREDENTIALS=file` fuerza el archivo. `resolveSecret` revisa primero una
variable de entorno, para CI. El secreto nunca viaja como argumento de línea de
comandos, salvo en macOS, donde `security` no admite otra vía.

## CLI

```sh
kit ls            # herramientas registradas
kit doctor        # verifica que cada una responda capabilities --json
kit events bita   # quién escucha los eventos de bita
kit agents        # agentes de código encontrados
```

## Pruebas de conformidad

Cada herramienta corre esto en su CI:

```ts
import { assertConformance } from '@kikedealba/kit/conformance'

await assertConformance([process.execPath, 'src/bin/atl.ts'], manifest)
```

Revisa que el manifiesto sea válido, que `capabilities --json` imprima un sobre
correcto que coincida con el manifiesto, y que un comando desconocido falle con
un sobre de error y código distinto de cero.
