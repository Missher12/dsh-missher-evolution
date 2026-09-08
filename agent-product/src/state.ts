import type { EvolutionState } from './types.js'

export function createEmptyState(now: number, enabled = true): EvolutionState {
  return {
    schemaVersion: 1,
    revision: 0,
    enabled,
    createdAt: now,
    updatedAt: now,
    lastMaintenanceAt: null,
    lastBackupId: null,
    health: 'healthy',
    counters: {
      captures: 0,
      injections: 0,
      rejectedCaptures: 0,
      maintenanceRuns: 0,
      weekStartedAt: now,
      weeklyInjections: 0,
    },
    recentTaskHashes: [],
    rules: [],
  }
}
