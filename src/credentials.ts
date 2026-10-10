import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { configHome, platformContext, run, which, type PlatformContext } from './platform.ts'

export const CREDENTIALS_BACKEND_ENV_VAR = 'KIT_CREDENTIALS'

export type BackendName = 'macos-keychain' | 'windows-credential-manager' | 'secret-service' | 'file'

export interface CredentialStore {
  readonly backend: BackendName
  get(service: string, account: string): Promise<string | null>
  set(service: string, account: string, secret: string): Promise<void>
  delete(service: string, account: string): Promise<boolean>
}

export class CredentialError extends Error {
  readonly code = 'CREDENTIAL_STORE_FAILED'
  constructor(message: string) {
    super(message)
    this.name = 'CredentialError'
  }
}

export type Runner = (command: string, args: readonly string[], input?: string) => Promise<string>

const defaultRunner: Runner = async (command, args, input) =>
  (await run(command, args, { timeoutMs: 20_000, ...(input !== undefined ? { input } : {}) })).stdout

function failure(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr
  if (typeof stderr === 'string' && stderr.trim().length > 0) return stderr.trim().split('\n')[0] ?? ''
  return error instanceof Error ? error.message : String(error)
}

export function macosKeychain(runner: Runner = defaultRunner): CredentialStore {
  const security = '/usr/bin/security'
  const notFound = (error: unknown) => (error as { code?: unknown }).code === 44 || /could not be found/i.test(failure(error))
  return {
    backend: 'macos-keychain',
    async get(service, account) {
      try {
        const value = (await runner(security, ['find-generic-password', '-s', service, '-a', account, '-w'])).trim()
        return value.length > 0 ? value : null
      } catch (error) {
        if (notFound(error)) return null
        throw new CredentialError(`Could not read ${service} from the Keychain: ${failure(error)}`)
      }
    },
    async set(service, account, secret) {
      try {
        await runner(security, ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret])
      } catch (error) {
        throw new CredentialError(`Could not save ${service} in the Keychain: ${failure(error)}`)
      }
    },
    async delete(service, account) {
      try {
        await runner(security, ['delete-generic-password', '-s', service, '-a', account])
        return true
      } catch (error) {
        if (notFound(error)) return false
        throw new CredentialError(`Could not remove ${service} from the Keychain: ${failure(error)}`)
      }
    },
  }
}

const WINDOWS_CRED_TYPE = `
Add-Type -Namespace Kit -Name Cred -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredDeleteW(string target, int type, int flags);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr buffer);
'@
`

function windowsScript(action: 'get' | 'set' | 'delete'): string {
  const body = {
    get: `$p=[IntPtr]::Zero
if (-not [Kit.Cred]::CredReadW($target, 1, 0, [ref]$p)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 3 }; exit 2 }
$c=[Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][Kit.Cred+CREDENTIAL])
$s=[Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize / 2)
[Kit.Cred]::CredFree($p)
[Console]::Out.Write($s)`,
    set: `$secret=[Console]::In.ReadToEnd()
$bytes=[Text.Encoding]::Unicode.GetBytes($secret)
$c=New-Object Kit.Cred+CREDENTIAL
$c.Type=1; $c.TargetName=$target; $c.UserName=$account; $c.Persist=2
$c.CredentialBlobSize=$bytes.Length
$c.CredentialBlob=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $c.CredentialBlob, $bytes.Length)
$ok=[Kit.Cred]::CredWriteW([ref]$c, 0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($c.CredentialBlob)
if (-not $ok) { exit 2 }`,
    delete: `if (-not [Kit.Cred]::CredDeleteW($target, 1, 0)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 3 }; exit 2 }`,
  }[action]
  return `$ErrorActionPreference='Stop'\n$target=$env:KIT_CRED_TARGET\n$account=$env:KIT_CRED_ACCOUNT\n${WINDOWS_CRED_TYPE}\n${body}`
}

export function windowsCredentialManager(
  exec: (script: string, env: NodeJS.ProcessEnv, input?: string) => Promise<string> = async (script, env, input) =>
    (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, timeoutMs: 30_000, ...(input !== undefined ? { input } : {}) })).stdout,
): CredentialStore {
  const env = (service: string, account: string) => ({ KIT_CRED_TARGET: `${service}:${account}`, KIT_CRED_ACCOUNT: account })
  const exitCode = (error: unknown) => (error as { code?: unknown }).code
  return {
    backend: 'windows-credential-manager',
    async get(service, account) {
      try {
        const value = await exec(windowsScript('get'), env(service, account))
        return value.length > 0 ? value : null
      } catch (error) {
        if (exitCode(error) === 3) return null
        throw new CredentialError(`Could not read ${service} from the Credential Manager: ${failure(error)}`)
      }
    },
    async set(service, account, secret) {
      try {
        await exec(windowsScript('set'), env(service, account), secret)
      } catch (error) {
        throw new CredentialError(`Could not save ${service} in the Credential Manager: ${failure(error)}`)
      }
    },
    async delete(service, account) {
      try {
        await exec(windowsScript('delete'), env(service, account))
        return true
      } catch (error) {
        if (exitCode(error) === 3) return false
        throw new CredentialError(`Could not remove ${service} from the Credential Manager: ${failure(error)}`)
      }
    },
  }
}

export function secretService(secretTool: string, runner: Runner = defaultRunner): CredentialStore {
  return {
    backend: 'secret-service',
    async get(service, account) {
      try {
        const value = (await runner(secretTool, ['lookup', 'service', service, 'account', account])).replace(/\n$/, '')
        return value.length > 0 ? value : null
      } catch (error) {
        if ((error as { code?: unknown }).code === 1) return null
        throw new CredentialError(`Could not read ${service} from the Secret Service: ${failure(error)}`)
      }
    },
    async set(service, account, secret) {
      try {
        await runner(secretTool, ['store', `--label=${service} (${account})`, 'service', service, 'account', account], secret)
      } catch (error) {
        throw new CredentialError(`Could not save ${service} in the Secret Service: ${failure(error)}`)
      }
    },
    async delete(service, account) {
      const existing = await this.get(service, account)
      if (existing === null) return false
      try {
        await runner(secretTool, ['clear', 'service', service, 'account', account])
        return true
      } catch (error) {
        throw new CredentialError(`Could not remove ${service} from the Secret Service: ${failure(error)}`)
      }
    },
  }
}

export function fileStore(file: string): CredentialStore {
  const load = async (): Promise<Record<string, string>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
    } catch {
      return {}
    }
  }
  const save = async (values: Record<string, string>) => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  }
  const key = (service: string, account: string) => `${service}\u0000${account}`
  return {
    backend: 'file',
    async get(service, account) {
      return (await load())[key(service, account)] ?? null
    },
    async set(service, account, secret) {
      const values = await load()
      values[key(service, account)] = secret
      await save(values)
    },
    async delete(service, account) {
      const values = await load()
      if (!(key(service, account) in values)) return false
      delete values[key(service, account)]
      await save(values)
      return true
    },
  }
}

export function credentialsFile(ctx: PlatformContext = platformContext()): string {
  return path.join(configHome(ctx), 'kikedealba', 'credentials.json')
}

export async function credentialStore(ctx: PlatformContext = platformContext()): Promise<CredentialStore> {
  const forced = ctx.env[CREDENTIALS_BACKEND_ENV_VAR]
  if (forced === 'file') return fileStore(credentialsFile(ctx))
  if (ctx.platform === 'darwin') return macosKeychain()
  if (ctx.platform === 'win32') return windowsCredentialManager()
  const secretTool = await which('secret-tool', ctx)
  if (secretTool) return secretService(secretTool)
  return fileStore(credentialsFile(ctx))
}

export async function resolveSecret(
  service: string,
  account: string,
  options: { envVar?: string; store?: CredentialStore; ctx?: PlatformContext } = {},
): Promise<string | null> {
  const ctx = options.ctx ?? platformContext()
  if (options.envVar) {
    const value = ctx.env[options.envVar]
    if (value) return value
  }
  const store = options.store ?? (await credentialStore(ctx))
  return store.get(service, account)
}
