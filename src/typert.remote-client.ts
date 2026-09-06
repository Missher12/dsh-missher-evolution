import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { invocationDescriptors } from './remote-contract.js'
import type {
  RestoreRequest,
  ReviewRuleRequest,
  EvolutionSnapshot,
  RemoteResetRequest,
  RemoteResetResult,
  SetEnabledRequest,
} from './remote-contract.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'missherEvolution/restore': (request: RestoreRequest) => Promise<RemoteResult<EvolutionSnapshot>>
    'missherEvolution/reviewRule': (request: ReviewRuleRequest) => Promise<RemoteResult<EvolutionSnapshot>>
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
      restore: (request: RestoreRequest) => Promise<RemoteResult<EvolutionSnapshot>>
      reviewRule: (request: ReviewRuleRequest) => Promise<RemoteResult<EvolutionSnapshot>>
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
