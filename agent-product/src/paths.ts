import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

const SAFE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

export interface AgentStateRootOptions {
  adapterId: string
  instanceId?: string
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  home?: string
}

export function resolveAgentStateRoot(options: AgentStateRootOptions): string {
  const instanceId = options.instanceId ?? 'default'
  validateId(options.adapterId, 'adapter_id_invalid')
  validateId(instanceId, 'instance_id_invalid')

  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()

  if (platform === 'win32') {
    const base = validAbsolutePath(env.LOCALAPPDATA, win32)
    if (base === undefined) throw new TypeError('local_app_data_missing')
    return win32.join(base, 'Missher Evolution', 'agents', options.adapterId, instanceId)
  }

  const safeHome = validAbsolutePath(home, posix)
  if (safeHome === undefined) throw new TypeError('home_invalid')
  if (platform === 'darwin') {
    return posix.join(
      safeHome,
      'Library',
      'Application Support',
      'Missher Evolution',
      'agents',
      options.adapterId,
      instanceId,
    )
  }

  const configured = env.XDG_STATE_HOME
  const base = configured === undefined
    ? posix.join(safeHome, '.local', 'state')
    : validAbsolutePath(configured, posix)
  if (base === undefined) throw new TypeError('xdg_state_home_invalid')
  return posix.join(base, 'missher-evolution', 'agents', options.adapterId, instanceId)
}

function validateId(value: string, code: string): void {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(code)
}

function validAbsolutePath(
  value: string | undefined,
  pathApi: Pick<typeof posix, 'isAbsolute'>,
): string | undefined {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 4_096
    || CONTROL_CHARACTER.test(value)
    || !pathApi.isAbsolute(value)
  ) return undefined
  return value
}
