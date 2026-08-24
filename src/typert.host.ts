import {
  EvolutionSnapshotSchema,
  ResetRequestSchema,
  ResetResultSchema,
  SetEnabledRequestSchema,
  invocationDescriptors,
} from './remote-contract.js'

export const TYPERT = {
  package: 'dsh-missher-evolution',
  face: 'host',
  schemas: [
    { name: 'EvolutionSnapshot', schema: EvolutionSnapshotSchema },
    { name: 'SetEnabledRequest', schema: SetEnabledRequestSchema },
    { name: 'RemoteResetRequest', schema: ResetRequestSchema },
    { name: 'RemoteResetResult', schema: ResetResultSchema },
  ],
  invocations: invocationDescriptors,
  model: {
    services: [{
      tags: [],
      description: 'Privacy-bounded evolution settings service.',
      key: 'missherEvolution',
      exportName: 'MissherEvolutionRemote',
      members: [
        { kind: 'method', name: 'snapshot', signature: 'snapshot(): Promise<EvolutionSnapshot>' },
        { kind: 'method', name: 'setEnabled', signature: 'setEnabled(request: SetEnabledRequest): Promise<EvolutionSnapshot>' },
        { kind: 'method', name: 'reset', signature: 'reset(request: RemoteResetRequest): Promise<RemoteResetResult>' },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
} as const

export default TYPERT

