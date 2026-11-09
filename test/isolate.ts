import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['KIT_REGISTRY_DIR'] ??= mkdtempSync(join(tmpdir(), 'kit-test-registry-'))
process.env['KIT_CONFIG_DIR'] ??= mkdtempSync(join(tmpdir(), 'kit-test-config-'))
process.env['KIT_NO_EVENTS'] = '1'
