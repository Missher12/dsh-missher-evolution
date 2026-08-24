import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import TYPERT_REMOTE from '../typert.remote-client.js'
import type {} from '../typert.remote-client.js'
import type {
  EvolutionSnapshot,
  RemoteResetRequest,
  RemoteResetResult,
  SetEnabledRequest,
} from '../remote-contract.js'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { EvolutionSection, type EvolutionSectionProps } from './EvolutionSection.js'
import './contract.js'
import { en, zh } from './locales.js'

const NS = 'settings.evolution'

export const inject = ['slots', 'locale', 'remote']

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  // Harness >=0.2.0 client runtimes gate `ctx.remote.<namespace>` property
  // access behind a `remote.<namespace>` inject declaration. A bundle that
  // mounts its own contribution cannot inject its own namespace (the inject
  // resolves before apply runs), so resolve the mounted namespace service
  // directly after $mount instead.
  const remote = ctx.get('remote.missherEvolution') as {
    snapshot: () => Promise<RemoteResult<EvolutionSnapshot>>
    setEnabled: (request: SetEnabledRequest) => Promise<RemoteResult<EvolutionSnapshot>>
    reset: (request: RemoteResetRequest) => Promise<RemoteResult<RemoteResetResult>>
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'missher-evolution: client dictionaries')
  const t = ctx.locale.bind(NS) as EvolutionSectionProps['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'evolution',
    order: 13,
    label: () => t('nav'),
    locale: NS,
    inject: (): EvolutionSectionProps => ({
      snapshot: () => remote.snapshot(),
      setEnabled: request => remote.setEnabled(request),
      reset: request => remote.reset(request),
      t,
    }),
  }, EvolutionSection))
  return unmountRemote
}

export { EvolutionSection } from './EvolutionSection.js'
export type { EvolutionSectionProps } from './EvolutionSection.js'
