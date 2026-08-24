import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { invocationDescriptors } from './remote-contract.js'
import type {
  EvolutionSnapshot,
  RemoteResetRequest,
  RemoteResetResult,
  SetEnabledRequest,
} from './remote-contract.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'missherEvolution/snapshot': () => Promise<RemoteResult<EvolutionSnapshot>>
    'missherEvolution/setEnabled': (
      request: SetEnabledRequest,
    ) => Promise<RemoteResult<EvolutionSnapshot>>
    'missherEvolution/reset': (
      request: RemoteResetRequest,
    ) => Promise<RemoteResult<RemoteResetResult>>
  }

  interface TypertRemoteNamespaceMap {
    missherEvolution: {
      snapshot: () => Promise<RemoteResult<EvolutionSnapshot>>
      setEnabled: (request: SetEnabledRequest) => Promise<RemoteResult<EvolutionSnapshot>>
      reset: (request: RemoteResetRequest) => Promise<RemoteResult<RemoteResetResult>>
    }
  }
}

export const TYPERT_REMOTE = {
  package: 'dsh-missher-evolution',
  descriptors: invocationDescriptors,
} as const satisfies TypertRemoteContribution

export default TYPERT_REMOTE
