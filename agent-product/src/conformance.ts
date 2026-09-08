import { distillExperience } from './experience.js'
import { capture, selectRules, sha256, trialArm } from './lifecycle.js'
import { createEmptyState } from './state.js'
import type { CaptureEvent, EvolutionState } from './types.js'

export const CAUSAL_PROTOCOL = Object.freeze({
  version: 1, controlPercent: 20, minTreatmentSuccesses: 3, minControlOpportunities: 2,
  minObservedUplift: 0.15, maxTrialsPerTurn: 1, assignmentEpoch: 'instructionHash',
  statisticalSignificanceClaim: false,
})

/** Portable non-production vectors; custom engines can replay the exact trace. */
export function lifecycleConformanceVectors() {
  const experience = distillExperience({ prompt: '修复 Windows 命令，使用 npm.cmd 并检查退出码，运行测试。', projectKey: 'conformance' })
  return {
    protocol: CAUSAL_PROTOCOL,
    experience,
    cases: [
      { name: 'positive_uplift', arms: ['treatment', 'treatment', 'treatment', 'control', 'control'], outcomes: ['success', 'success', 'success', 'success', 'failure'], expectedStatus: 'active' },
      { name: 'no_controls', arms: ['treatment', 'treatment', 'treatment'], outcomes: ['success', 'success', 'success'], expectedStatus: 'trial' },
      { name: 'no_uplift', arms: ['treatment', 'treatment', 'treatment', 'control', 'control'], outcomes: ['success', 'success', 'success', 'success', 'success'], expectedStatus: 'trial' },
    ],
  } as const
}

export function runConformance(): { ok: boolean, checks: string[], protocolVersion: number } {
  const vectors = lifecycleConformanceVectors()
  const checks: string[] = []
  const baseEvent = (index: number): CaptureEvent => ({
    schemaVersion: 1, taskHash: sha256(`conformance-${index}`), sessionHash: sha256(`session-${index}`),
    occurredAt: 1_000 + index, taskType: vectors.experience.taskType,
    outcome: 'success', correction: false, complexity: 'low', workflowSteps: ['shell'],
    workflowSignature: sha256('shell'), errorKind: 'none', injectedRuleIds: [], preference: null,
    experience: vectors.experience, outcomeEvidence: { quality: 'verified', signals: ['verification_passed'] },
  })
  let baseline: EvolutionState = createEmptyState(0)
  for (let i = 0; i < 3; i++) baseline = capture(baseline, baseEvent(i)).state
  if (baseline.rules[0]?.status === 'trial') checks.push('candidate_to_trial')
  const rule = baseline.rules[0]
  if (rule === undefined) return { ok: false, checks, protocolVersion: 1 }
  for (const vector of vectors.cases) {
    let state = structuredClone(baseline)
    for (let i = 0; i < vector.arms.length; i++) {
      const arm = vector.arms[i]!, outcome = vector.outcomes[i]!
      const event: CaptureEvent = { ...baseEvent(10 + i), outcome,
        injectedRuleIds: arm === 'treatment' ? [rule.id] : [],
        experimentAssignments: [{ ruleId: rule.id, arm, instructionHash: rule.instructionHash }],
        outcomeEvidence: outcome === 'success' ? { quality: 'verified', signals: ['verification_passed'] } : { quality: 'contradicted', signals: ['verification_failed'] },
      }
      state = capture(state, event).state
      const replay = capture(state, event).state
      if (JSON.stringify(replay) !== JSON.stringify(state)) return { ok: false, checks, protocolVersion: 1 }
    }
    if (state.rules.find(item => item.id === rule.id)?.status === vector.expectedStatus) checks.push(vector.name)
  }
  const selection = selectRules(baseline, { taskType: 'coding', experience: vectors.experience, experimentKey: 'fixture', now: 1_005, maxRules: 4 })
  if (selection.experimentAssignments?.[0]?.arm === trialArm(rule.id, 'fixture')) checks.push('deterministic_assignment')
  if (selection.experimentAssignments?.[0]?.instructionHash === rule.instructionHash) checks.push('instruction_epoch')
  if (selectRules(baseline, { taskType: 'coding', experience: distillExperience({ prompt: '', projectKey: 'unrelated' }), experimentKey: 'fixture', now: 1_005, maxRules: 4 }).rules.length === 0) checks.push('scope_isolation')
  return { ok: checks.length === 7, checks, protocolVersion: 1 }
}
