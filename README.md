# kit

El contrato común de las herramientas `@kikedealba`: **den** (el punto de
entrada), **bita** (tiempo), **nursery** (subagentes y reglas), **gaze**
(memoria por proyecto), **atl** (Atlassian), **inkwell** (documentación),
**recap** (reuniones), **tally** (horas en Jira) y **Den** (la app de
escritorio).

Ninguna herramienta depende de otra. Todas dependen solo de `kit`, y por medio de
él se encuentran cuando están instaladas juntas: una herramienta que no está
simplemente no aparece, y lo que dependía de ella falla con un error claro y una
pista de cómo instalarla.

`kit` es una librería sin dependencias de ejecución. Trae además una CLI pequeña
para ver qué hay instalado.

## Requisitos

Node 24 o superior. Funciona en macOS, Windows y Linux.

## Las piezas

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
`~/.gemini/config` (se cambia con `homes.antigravity` o, desde 0.8, con la
variable `KIT_ANTIGRAVITY_HOME`; `homes.antigravity` gana). Desinstalar corre
`agy plugin uninstall <herramienta>`.

Los plugins de `agy` no admiten hooks ni servidores MCP, así que los servidores MCP
se escriben directo en `<homes.antigravity>/mcp_config.json`, sin pasar por
`agy mcp`. Cada servidor queda bajo `mcpServers.<nombre>` como
`{ command, args, env?, disabled: false, _kit: "<herramienta>" }` o, si es remoto,
`{ serverUrl, headers?, disabled: false, _kit: "<herramienta>" }`. `_kit` marca la
entrada como propia: `agy` lo conserva al reescribir el archivo. Si ya hay una
entrada con el mismo nombre sin esa marca, no se pisa y el paso sale `skipped`
con el conflicto en `detail`. La excepción es una entrada sin marca idéntica a la
que kit escribiría (de una instalación anterior): se adopta y se le pone la
marca. Las demás claves del archivo se conservan, la
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

El prompt va por stdin en todos los agentes, así que no cuenta para el límite de
la línea de comandos, un prompt que empieza con `-` no se toma como flag y no
queda visible en la lista de procesos (`ps`). A `agy` le llega como una línea
NDJSON `{"event":"user","message":{"content":"<prompt>"}}` con `--input-format
stream-json` y `-p=` vacío; la respuesta sale del evento `result`. Ojo: `agy`
recorta por su cuenta los mensajes de más de unos 190 KB (avisa con
`<truncated N bytes>`), venga el prompt por donde venga.

| Agente | Invocación | `access: 'read'` (por omisión) | `access: 'write'` | Respuesta |
|---|---|---|---|---|
| claude | `claude -p --output-format json [--model m]` | `--strict-mcp-config --tools Read,Grep,Glob --permission-mode plan --setting-sources user` | `--permission-mode acceptEdits` | `result`, `session_id` |
| codex | `codex exec --json -C <cwd> --skip-git-repo-check [-m m] -` | `--sandbox read-only` | `--sandbox workspace-write` | último `item.completed` con `agent_message`; id en `thread.started` |
| gemini | `gemini -o json [-m m]` | `--approval-mode plan`, sin `GEMINI_CLI_TRUST_WORKSPACE` | `--approval-mode auto_edit` y `GEMINI_CLI_TRUST_WORKSPACE=true` | `response`, `session_id` |
| antigravity | `agy --input-format stream-json --output-format stream-json [--model m] … -p=` | `--mode plan` | `--dangerously-skip-permissions` | `result.response`, `result.conversation_id` del evento `result` |
| opencode | `opencode run --format json [-m proveedor/modelo]` | `--agent plan` | agente por omisión | `part.text` de los eventos `text`, unidos; `sessionID` |

`extraArgs` va después de los flags de acceso (en agy, antes de `-p=`). En agy
cuenta la respuesta: si `response` trae texto y `status` no es `ERROR`, la corrida es buena aunque traiga
`error` o `denied_actions`. Sin texto útil, falla con `FAILED` y el mensaje sale
de `error`, de `status` o de las acciones denegadas. Cuenta el último evento
`result`; si su `response` viene vacío, se usan los `text_delta` de los pasos
`agent_response` de ese turno. Si el stream acaba sin `result` pero con deltas y
`agy` sale con 0, se devuelve ese texto parcial. Un evento `error` hace fallar
con `FAILED` y su mensaje, salvo que el `result` traiga una respuesta útil.

`tools` fija la lista exacta de herramientas de claude y reemplaza el
`--tools Read,Grep,Glob` de lectura (claude suma los `--tools` repetidos, así que
kit no manda el suyo). Va como `--strict-mcp-config --tools <a,b>`, de modo que
tampoco se cargan los servidores MCP del usuario. Con `tools: []` no queda
ninguna: kit manda `--strict-mcp-config --tools Read,Grep,Glob --disallowedTools
Read,Grep,Glob`, que el evento `init` de claude reporta como `tools: []`. Los
demás agentes ignoran `tools`. Sin `tools`, la lectura deja solo `Read,Grep,Glob`
y nunca carga los servidores MCP del usuario (`--strict-mcp-config`), porque esos
servidores pueden escribir. La escritura sin `tools` usa las herramientas y los
MCP que tenga el usuario.

`maxOutputBytes` (8 MiB por omisión, `HEADLESS_DEFAULT_MAX_OUTPUT_BYTES`) limita
el stdout del hijo: si lo pasa, kit mata el árbol de procesos y lanza `FAILED`.
También acota stderr, pero ahí no falla: guarda solo los últimos `maxOutputBytes`
bytes.

El hijo no hereda todo el entorno. `headlessEnv(agent, env)` filtra con una lista
blanca común, y bita, recap e inkwell pueden usarla para lo mismo:

- `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`/`TMP`/`TEMP`, `LANG`, `LC_*`,
  `TERM`, `XDG_*`, `NVM_*`, `DEN_PROFILE` (desde 0.8, para que el perfil llegue
  a las herramientas anidadas; el resto de `DEN_*` no pasa) y `KIT_HEADLESS`.
- Proxy y certificados: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` (también en
  minúsculas), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` y
  `REQUESTS_CA_BUNDLE`.
- Windows: `USERPROFILE`, `USERNAME`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`,
  `LOCALAPPDATA`, `PROGRAMDATA`, `ALLUSERSPROFILE`, `ProgramFiles`,
  `ProgramFiles(x86)`, `ProgramW6432`, `CommonProgramFiles`, `SystemRoot`,
  `SystemDrive`, `WINDIR`, `ComSpec`, `PATHEXT`, `PROCESSOR_ARCHITECTURE` y
  `NUMBER_OF_PROCESSORS`. En Windows los nombres se comparan sin distinguir
  mayúsculas, también al quitar variables como `GEMINI_CLI_TRUST_WORKSPACE`.

A eso se suman solo los prefijos del agente que corre:

| Agente | Prefijos | Condicionales |
|---|---|---|
| claude | `ANTHROPIC_`, `CLAUDE_` | `AWS_*` si `CLAUDE_CODE_USE_BEDROCK`; `GOOGLE_*` y `CLOUD_ML_REGION` si `CLAUDE_CODE_USE_VERTEX` |
| codex | `OPENAI_`, `CODEX_` | |
| gemini | `GEMINI_`, `GOOGLE_` | `GOOGLE_APPLICATION_CREDENTIALS` solo si `GOOGLE_GENAI_USE_VERTEXAI` |
| antigravity | `ANTIGRAVITY_`, `GEMINI_` | |
| opencode | `OPENCODE_` | |

Así claude no ve `OPENAI_API_KEY` ni codex `ANTHROPIC_API_KEY`. opencode solo
recibe `OPENCODE_*`: sus credenciales salen de `opencode auth login` o se pasan en
`env`. Lo que el llamador pase en `env` se agrega encima del filtro y gana, así que
puede reintroducir cualquier variable, incluso una que el filtro quitó; esa
decisión es de quien llama. Al final se fija `KIT_HEADLESS=1`, que los hooks de bita y
gaze respetan para no registrar esa sesión, y se pone la carpeta del binario al
principio del `PATH`.

El tiempo límite por omisión es de 10 minutos. Al vencer, o al abortar con
`signal`, se mata el árbol de procesos: en unix el hijo corre en su propio grupo
y se manda `SIGTERM` y luego `SIGKILL` al grupo; en Windows se usa
`%SystemRoot%\System32\taskkill.exe /T /F`. En unix, mientras haya hijos vivos
(`liveHeadlessGroups` los lista), kit escucha `exit`, `SIGINT`, `SIGTERM` y
`SIGHUP` del proceso padre y mata sus grupos. Si nadie más escucha esa señal, se
quita su manejador y la vuelve a mandar al padre, que termina como lo haría sin
kit. Al terminar el último hijo quita todos los manejadores. Un `SIGKILL` al padre
no se puede atrapar.

Los fallos lanzan `HeadlessError` con un `code`, además de `exitCode`, `stdout`
y `stderr`:

| `code` | Cuándo |
|---|---|
| `UNAVAILABLE` | No se encontró el binario o no se pudo lanzar. |
| `FAILED` | Salió con código distinto de cero, el agente reportó un error en su JSON, se abortó, su stdout pasó de `maxOutputBytes`, `cwd` no existe o el prompt trae saltos de línea y debe ir como argumento a un `.cmd`. |
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

#### Entorno de los comandos y escrituras atómicas

Desde 0.8, los comandos que kit corre por su cuenta (`claude plugin …`,
`claude mcp …`, `agy plugin …`) usan `ctx.env` de `InstallOptions`, no
`process.env`. Así, `installIntegration({ ctx: platformContext({ env: envFor(perfil, 'all', process.env) }) })`
instala plugins y servidores MCP en el `CLAUDE_CONFIG_DIR` del perfil. Si se pasa
`exec`, kit lo usa tal cual.

Toda escritura atómica de kit (`writeJsonFile`, `registerTool`, el almacén de
credenciales en archivo, `profiles.json` y `settings.json`) resuelve antes el
destino con `realpath` y crea el temporal (con nombre aleatorio) junto al archivo
real. Un symlink (por ejemplo, `CLAUDE.md` de un perfil que apunta a
`~/.claude/CLAUDE.md`) sigue en pie y se actualiza el archivo al que apunta;
un symlink colgante tampoco se reemplaza: se escribe en su destino. Sin `mode`
explícito se conserva el modo del archivo que ya existía.

`writeFileAtomic(archivo, contenido, { mode?, dirMode? })` y
`withFileLock(archivo, fn, { timeoutMs?, staleMs?, retryMs? })` se exportan
desde la raíz y desde `@kikedealba/kit/atomic`. El candado es `<archivo>.lock`,
creado de forma atómica con un token propio que solo su dueño borra. Mientras
dura la sección crítica se refresca su fecha; uno de más de 30 s o de un proceso
muerto se roba renombrándolo, y solo se borra si sigue siendo el mismo.
`profiles.json` y `settings.json` se leen y escriben dentro de ese candado, así
que cambios en paralelo no se pierden.

#### Procesos, notificaciones y Windows

`spawnSpec(comando, args, ctx)` devuelve `{ command, args, windowsVerbatimArguments }`
listo para `spawn`. En Windows un `.cmd` o `.bat` se envuelve en
`%SystemRoot%\System32\cmd.exe /d /s /c` con cada argumento entre comillas y los
metacaracteres escapados, así un argumento con `&`, `|` o comillas no se
interpreta como comando. Un argumento con saltos de línea lanza un error, porque
`cmd.exe` corta ahí la línea. En los demás casos devuelve el comando tal cual.

`run` usa `spawnSpec`. Esto cambia su comportamiento en Windows respecto a 0.6:
antes corría los `.cmd`/`.bat` con `shell: true` y sin escapar, y ahora pasan
por `%SystemRoot%\System32\cmd.exe` (no por `ComSpec`) con los argumentos
escapados. Un argumento con saltos de línea ahora lanza un error en vez de
cortarse. `whichSync` es la versión síncrona de `which`, y las dos aceptan
un cuarto argumento con carpetas que se buscan después de `defaultSearchDirs`.

`notify(título, cuerpo)` (nuevo en 0.7) muestra una notificación del sistema y devuelve `true` o
`false`, nunca lanza. El título se recorta a 256 caracteres y el cuerpo a 2000. En
macOS usa `osascript` con el texto por `argv` después de `--`, en Linux
`notify-send` con `<`, `>` y `&` escapados, y en Windows un toast de PowerShell
con `-EncodedCommand`. El texto va en base64 dentro del script y no se salta la
política de ejecución (`-ExecutionPolicy` no se toca). `notifyCommand` da el
comando sin ejecutarlo.

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

### 6. Perfiles (`@kikedealba/kit/profiles`)

Un perfil es una cuenta. Separa el login de Claude Code y de Codex: cada perfil
no builtin tiene su propio `CLAUDE_CONFIG_DIR` y `CODEX_HOME`. Gemini, Antigravity
y opencode usan una sola cuenta en esta versión.

Todo vive bajo la raíz de configuración `<configHome>/kikedealba`
(`XDG_CONFIG_HOME` o `~/.config`; `%APPDATA%` en Windows). `KIT_CONFIG_DIR`
reemplaza la raíz completa, pensado para pruebas. `kitConfigRoot(ctx)` la
devuelve.

`<raíz>/profiles.json` (esquema en `schemas/profiles.v1.json`):

```json
{
  "$schema": "https://raw.githubusercontent.com/KikeDeAlba/kit/main/schemas/profiles.v1.json",
  "version": 1,
  "default": "personal",
  "profiles": {
    "personal": { "builtin": true },
    "trabajo": {
      "claude": "~/.config/kikedealba/profiles/trabajo/claude",
      "codex": "~/.config/kikedealba/profiles/trabajo/codex",
      "createdAt": "2026-11-08T17:00:00.000Z"
    }
  },
  "dirs": [{ "path": "~/dev/empresa", "profile": "trabajo" }]
}
```

- Nombres: `^[a-z][a-z0-9-]{0,31}$`. Hay exactamente un perfil `builtin`, sin
  `claude` ni `codex`, y `default` apunta a un perfil que existe.
- Las rutas bajo `$HOME` se guardan como `~/…` y se expanden al leer. `dirs`
  guarda la ruta ya resuelta con `realpath`.
- Si el archivo no existe, equivale a un único perfil builtin llamado `default`.
  No se crea hasta la primera escritura. Se escribe de forma atómica con modo
  `0600`; la raíz de configuración (`kikedealba/` o `KIT_CONFIG_DIR`),
  `profiles/<n>/`, `claude/` y `codex/` se crean con `0700`.
- Un archivo inválido lanza `ProfileError` con código `PROFILES_INVALID`.
- Un home de perfil que sea `~/.claude` o `~/.codex`, o que repita la carpeta de
  otro perfil (o la suya entre `claude` y `codex`), no hace fallar la lectura: un
  `profiles.json` viejo se sigue leyendo, y el builtin y `removeProfile` siguen
  funcionando. `addProfile` lo rechaza con `PROFILE_HOME_CONFLICT`,
  `profileHomeConflicts(n)` lo lista (`{ harness, home, conflictsWith }`,
  comparando con `realpath`) e `inspectSharedLinks` marca esas entradas como
  `home-conflict`. En macOS y Windows las rutas se comparan sin distinguir
  mayúsculas.

```ts
import { profiles } from '@kikedealba/kit'

const { profile, source } = await profiles.resolveProfile({ cwd: process.cwd() })
const env = profiles.envFor(profile, 'claude', process.env)
```

`resolveProfile({ cwd, explicit })` busca en este orden: `explicit`,
`DEN_PROFILE` del entorno, el prefijo más largo de `dirs` (por segmentos) que
contenga `realpath(cwd)` y, al final, `default`. Si `explicit` o `DEN_PROFILE`
nombran un perfil que no existe, lanza `PROFILE_NOT_FOUND`; nunca cae en
silencio al default.

`envFor(perfil, harness | 'all', baseEnv)` es pura y devuelve una copia:

1. Quita las variables de sesión de los agentes (`withoutHarnessSession`:
   `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `GEMINI_CLI`,
   `OPENCODE`, `ANTIGRAVITY_*` de sesión, etc.).
2. Siempre quita `CLAUDE_CONFIG_DIR` y `CODEX_HOME` heredados.
3. En un perfil no builtin, con `claude`, `codex` o `all`, quita solo las
   credenciales de la cuenta del agente, sin importar mayúsculas: los prefijos de
   `PROFILE_SECRET_ENV_PREFIXES` (`ANTHROPIC_*`, que incluye `ANTHROPIC_VERTEX_*`,
   `OPENAI_*`, `AZURE_OPENAI_*`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_OAUTH_*`,
   `CLAUDE_CODE_API_KEY*` y `GOOGLE_GENAI_*`) y los nombres de
   `PROFILE_SECRET_ENV` (`AWS_BEARER_TOKEN_BEDROCK`, `CODEX_API_KEY`,
   `CODEX_ACCESS_TOKEN`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` y
   `CLOUD_ML_REGION`). `isProfileSecretEnv(nombre)` aplica la misma regla. No hay
   patrones por subcadena: `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` o `AWS_PROFILE` pasan, porque la
   sesión los necesita para trabajar. El builtin las conserva, y con `gemini`,
   `opencode` o `antigravity` también (esos agentes no cambian de cuenta con el
   perfil).
4. En un perfil no builtin define `CLAUDE_CONFIG_DIR` (con `claude` o `all`) y
   `CODEX_HOME` (con `codex` o `all`).
5. Siempre define un único `DEN_PROFILE` (quita antes cualquier variante con
   otras mayúsculas).

Con `gemini`, `antigravity` u `opencode` no define ningún home;
`profileSupports(harness)` devuelve `false` para que quien llama avise de que
esos agentes usan una sola cuenta. Las rutas de perfil y `KIT_CONFIG_DIR` deben
ser absolutas: una ruta de perfil relativa es `PROFILES_INVALID` y un
`KIT_CONFIG_DIR` relativo se ignora.

| Función | Qué hace |
|---|---|
| `listProfiles()` / `getProfile(n)` | Lee el archivo |
| `addProfile(n)` | Registra el perfil y crea sus carpetas con `0700`. Idempotente: `created: false` si ya existía |
| `removeProfile(n, { purge })` | Falla con `PROFILE_BUILTIN` o `PROFILE_IS_DEFAULT`; quita sus `dirs` y solo borra la carpeta con `purge`. Devuelve `{ removed, purged, unmapped, logoutRequired }` |
| `setDefaultProfile(n)` | Cambia el default |
| `renameBuiltinProfile(n)` | Da nombre al perfil builtin (el asistente de den usa `personal`) |
| `mapDir(dir, n)` / `unmapDir(dir)` | Asocia o suelta un directorio |
| `profileHomes(n)` | `{ root, claude, codex }` bajo `<raíz>/profiles/<n>` |
| `inspectSharedLinks(n)` / `repairSharedLinks(n)` | Revisa y repara los enlaces y copias compartidos |
| `syncSharedCopies(n)` | Regenera las copias filtradas que faltan o quedaron viejas; no toca una editada |
| `authStatus(perfil)` | Corre `claude auth status --json` con el entorno del perfil |

Enlaces compartidos. Un perfil enlaza con `~/.claude` y `~/.codex`:
`CLAUDE.md`, `skills/`, `agents/`, `commands/` y `AGENTS.md` (`SHARED_LINKS`).
Nunca se enlazan `plugins/`, `projects/`, `.claude.json`, `.credentials.json`,
`todos/`, `auth.json`, `sessions/` ni `history.jsonl`. `config.toml` de Codex
**ya no se comparte**: cada perfil tiene el suyo, porque no hay un parser TOML
fiable para filtrarlo.

`settings.json` de Claude no es un symlink sino una copia filtrada
(`SHARED_COPIES`): kit escribe `<perfil>/claude/settings.json` desde
`~/.claude/settings.json` sin `apiKeyHelper`, `awsCredentialExport`,
`awsAuthRefresh`, `gcpAuthRefresh` ni `otelHeadersHelper`
(`CLAUDE_SETTINGS_SECRET_KEYS`, sin distinguir mayúsculas), y sin las claves de
`env` que cumplen `isProfileSecretEnv`, las `OTEL_*HEADERS*` ni
`CLAUDE_CONFIG_DIR`, `CODEX_HOME` o `DEN_PROFILE`
(`filterSharedClaudeSettings` hace ese filtro). El hash de
lo escrito queda en `<perfil>/claude/.den-shared.json`, fuera del settings. Si
el compartido no existe, la copia es `{}`; si no es un objeto JSON válido,
`inspectSharedLinks` da `invalid-shared` y `syncSharedCopies` y
`repairSharedLinks` lanzan `SHARED_COPY_INVALID` antes de tocar nada.

> **Aviso:** todo lo demás del `settings.json` compartido se copia tal cual, también
> `hooks`, `statusLine` y `fileSuggestion`. Son comandos tuyos y en el perfil
> corren con la cuenta del perfil.

`inspectSharedLinks` da el estado de cada entrada:

| Estado | Qué significa | Sano |
|---|---|---|
| `linked` | symlink al compartido | sí |
| `copied` | en Windows, archivo copiado en vez de enlazado | sí |
| `generated` | copia filtrada al día | sí |
| `missing` | no existe | no |
| `foreign` | symlink a otro lado (también un `settings.json` enlazado de versiones anteriores) | no |
| `replaced` | Claude Code o Codex lo cambió por algo propio | no |
| `stale` | el compartido cambió desde la última copia: hay que regenerar | no |
| `drifted` | el perfil editó su copia | no |
| `invalid-shared` | `~/.claude/settings.json` no es un objeto JSON válido | no |
| `home-conflict` | el home del perfil es el compartido o el de otro perfil | no |

`HEALTHY_LINK_STATES` lista los sanos. `syncSharedCopies(n)` regenera las copias
`missing`, `stale` o `foreign` y deja una `drifted` como está; den y nursery la
llaman tras cambiar el compartido. `repairSharedLinks` no fusiona nada:

1. Crea el destino compartido de un enlace si falta (vacío para archivos,
   carpeta para directorios). Nunca reescribe uno que ya existe.
2. Si un enlace fue reemplazado o una copia está `drifted` o `replaced`, mueve
   lo del perfil a `<nombre>.backup-<timestamp>` (copia y borra si está en otro
   volumen) y devuelve esa ruta en `backup`, para que `den doctor` la muestre.
3. Quita un enlace `foreign`, vuelve a enlazar y regenera las copias. Los estados
   sanos no se tocan.

Si el home `claude` o `codex` de un perfil resuelve (por ejemplo, con un
symlink) al home compartido, `syncSharedCopies` y `repairSharedLinks` lanzan
`PROFILE_HOME_SHARED` sin mover nada; si choca con el de otro perfil (o entre su
`claude` y su `codex`), lanzan `PROFILE_HOME_CONFLICT`, también sin tocar nada.

`removeProfile(n, { purge: true })` borra la carpeta del perfil pero no puede
borrar la entrada del Llavero de macOS sin `claude`: en macOS devuelve
`logoutRequired: true` cuando el perfil tenía home de Claude; en Linux y Windows,
`false`. Den corre
`claude auth logout` con `envFor(perfil, 'claude', …)` antes de llamar a
`removeProfile` con `purge`.

`authStatus` devuelve `{ loggedIn, authMethod, email, orgName,
subscriptionType, configDirectory }`, o `null` si `claude` no está o no responde
JSON. Lee la respuesta también cuando `claude` sale con código 1 (sin sesión).

### 7. Configuración (`@kikedealba/kit/settings`)

`<raíz>/settings.json` guarda solo los valores distintos del default, anidados
por namespace:

```json
{ "version": 1,
  "agents": { "maxParallel": 4, "developer": { "model": "sonnet" } },
  "rules": { "gitflow": false },
  "harness": { "claude": { "skipPermissions": false } } }
```

| Clave | Tipo | Default | Dueño | Validación |
|---|---|---|---|---|
| `agents.maxParallel` | integer | 10 | nursery | 1–20 |
| `agents.enabled` | string[] | los 10 roles más los agentes de usuario | nursery | roles conocidos, no vacío |
| `agents.<role>.model` | string | el del frontmatter de origen | nursery | `MODEL_PATTERN`: `^[a-z0-9][a-z0-9.\-\[\]/#:]*$` |
| `agents.<role>.maxTurns` | integer | el del frontmatter | nursery | 1–500 |
| `agents.<role>.effort` | enum | el del frontmatter | nursery | `low`, `medium`, `high`, `xhigh`, `max` |
| `rules.noAiTrace`, `noComments`, `language`, `worktrees`, `gitflow`, `delegation` | boolean | true | nursery | — |
| `rules.baseBranch` | string | `develop` | nursery | nombre de rama git válido, solo `[A-Za-z0-9._/-]` |
| `harness.default` | enum | `claude` | den | `HARNESS_IDS` |
| `harness.<h>.skipPermissions` | boolean | true | den | — |
| `harness.<h>.extraArgs` | string[] | [] | den | sin `--`, sin saltos de línea ni NUL; por lo demás libre (es config del propio usuario) |
| `session.summary.<h>.model` | string | `defaultSummaryModel` del adaptador | bita | `MODEL_PATTERN` |
| `session.minDurationSec` | integer | 60 | bita | 0–3600 |
| `tools.<t>.enabled` | boolean | true | den | `kit` no se puede apagar |

`<role>` es uno de los 10 roles de nursery (`NURSERY_ROLES`) o un agente de
usuario de `<raíz>/agents/<n>.md`. Para los roles de nursery, `agents.<role>.*`
sin definir vale `undefined`: "lo que diga la fuente". Para un agente de usuario,
el default sale de su frontmatter. Las claves de `nursery` tienen
`refresh: 'nursery'`; el resto, `'none'`.

```ts
import { settings } from '@kikedealba/kit'

await settings.setSetting('agents.maxParallel', '4')
await settings.getSetting<number>('agents.maxParallel')
```

- `parseSettingValue(clave, texto)`: boolean acepta `true|false|1|0`, integer en
  base 10, string[] como lista separada por comas o arreglo JSON.
- `setSetting` acepta el valor ya tipado o como texto. Si queda igual al default,
  borra la clave del archivo. Devuelve `{ key, previous, value, refresh }`.
- `unsetSetting` vuelve al default. `listSettings` expande todos los patrones con
  `source: 'user' | 'default'` y su dueño. `checkSettings` devuelve
  `{ ok, errors }` para un doctor.
- Errores (`SettingsError`): `UNKNOWN_KEY`, `INVALID_VALUE` y `SETTINGS_INVALID`
  (archivo corrupto; `setSetting` se niega a sobrescribirlo).
- `onChange(prefijo, handler)` avisa dentro del proceso cuando un valor cambia de
  verdad. Los manejadores corren en orden y aislados: si uno falla, los demás
  corren igual, el valor ya quedó guardado y el error vuelve en
  `change.warnings`; `setSetting` no se rechaza. Entre procesos, el refresco lo
  orquesta den.

### 8. Adaptadores de agentes (`@kikedealba/kit/harness`)

Los adaptadores de bita (`claude`, `opencode`, `codex`, `gemini`, `antigravity`)
viven aquí desde 0.8: argumentos de lanzamiento, lectura de transcripciones,
resumen de sesión y `afterExit`.

```ts
import { harness } from '@kikedealba/kit'

const adapter = harness.getAdapter('claude')
const plan = adapter.launchArgs(userArgs, await harness.launchOptionsFor('claude'))
const turns = await adapter.extractTranscript({ ...ref, profile: 'trabajo' }, baseEnv)
```

- `adapter.profiles` dice si el agente admite perfiles (`claude` y `codex`).
- `launchArgs(args, { skipPermissions, extraArgs })`: con `skipPermissions: false`
  no agrega el flag por defecto (`--allow-dangerously-skip-permissions`,
  `--dangerously-bypass-approvals-and-sandbox`, `--approval-mode=yolo`, `--auto`,
  `--dangerously-skip-permissions`). `extraArgs` va tal cual antes de los
  argumentos del usuario; si ya trae el flag por defecto, no se repite. Sin opciones equivale a `{ skipPermissions: true,
  extraArgs: [] }`. `launchOptionsFor(id)` las lee de `harness.<id>.*`.
- `extractTranscript(ref, baseEnv?)` y `summarize({ …, profile, baseEnv? })`
  calculan su entorno con `harnessEnv(id, profile, baseEnv)`: quitan las
  variables de sesión y, si hay perfil, aplican `envFor`. Sin perfil
  (`null` o `undefined`) se comportan como el perfil builtin: quitan
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME` y `DEN_PROFILE` heredados y no definen
  ninguno. Para quien consume kit (bita, den, nursery), `profile: null`
  significa el perfil builtin, no "lo que haya en el entorno".
- Las transcripciones se confinan al home: Claude a `projects/`, Codex a
  `sessions/` y `archived_sessions/`, Gemini a `tmp/` de `~/.gemini`. El
  `realpath` del archivo (también el de un `transcriptPath` explícito) debe
  quedar ahí dentro y el `sessionId` debe cumplir `SESSION_ID_PATTERN`
  (`^\w[\w-]*$`, sin guion inicial); opencode lo valida antes de
  `session export`. Si no, devuelven `[]`.
- El resumen de opencode corre con `--agent plan` y un `opencode.json` temporal
  (`OPENCODE_SUMMARY_CONFIG`) que niega `bash`, `edit`, `webfetch` y `write`. Un perfil que ya no
  existe hace que `summarize` devuelva `{ ok: false }`; un nombre vacío se
  rechaza. **Cambio respecto a bita 1.9:** sin `baseEnv`, los adaptadores parten
  de `process.env` sin las variables de sesión, pero ya no ponen `BITA_CHILD` ni
  quitan `BITA_WRAPPER_ID`, `BITA_HARNESS` o `BITA_SESSION_PROJECT`. Quien llama
  (bita) pasa su `childEnv()` como `baseEnv`.
- El binario se busca primero en `KIT_HARNESS_BIN_<ID>`, luego en
  `BITA_HARNESS_BIN_<ID>` (las dos con ruta absoluta) y luego con
  `findAgentBinarySync`.
- Los avisos de flags sin equivalente ya no llevan el prefijo `bita:`; quien los
  imprime pone el suyo.

### 9. Catálogo (`@kikedealba/kit/catalog`)

La lista canónica de herramientas, en orden de instalación: kit, nursery, bita,
gaze, inkwell, recap, tally y atl.

```ts
import { catalog } from '@kikedealba/kit'

for (const tool of catalog.CATALOG) console.log(tool.name, tool.package, tool.setup, tool.agentsFlag)
```

Cada entrada trae `name`, `package`, `bin`, `description`, `homepage`, `setup`
y `uninstall` (argumentos del binario), `agentsFlag` (si su `setup` acepta
`--agents`) y `optional`. `DEN_APP` apunta a las releases de Den.app. El paquete
incluye la misma lista en `schemas/catalog.v1.json`
(`@kikedealba/kit/schemas/catalog.v1.json`), que Den.app lee al compilar.

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
