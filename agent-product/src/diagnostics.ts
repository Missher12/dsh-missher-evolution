import type { EvolutionState } from './types.js'
import { methodDiagnostics } from './improvement.js'

/** Evidence availability is not a measurement of task improvement. */
export function learningDiagnostics(state: EvolutionState) {
  const live = state.rules.filter(rule => rule.status !== 'retired')
  const trials = live.filter(rule => rule.status === 'trial')
  const lessons = live.flatMap(rule => rule.correctionLesson === undefined ? [] : [rule.correctionLesson])
  const checks = live.flatMap(rule => rule.verificationChecks === undefined ? [] : [rule.verificationChecks])
  const checkSum = (key: Exclude<keyof NonNullable<typeof checks[number]>, 'lastPassedAt'>) => checks.reduce((sum, item) => sum + item[key], 0)
  return {
    captures: state.counters.captures,
    active: live.filter(rule => rule.status === 'active').length,
    candidates: live.filter(rule => rule.status === 'candidate').length,
    trials: trials.length,
    unscoped: live.filter(rule => rule.scope === undefined || rule.scope.kind === 'global').length,
    legacyUnverified: live.filter(rule => rule.origin !== 'observed').length,
    waitingTreatment: trials.filter(rule => (rule.evaluation?.treatmentSuccesses ?? 0) < 3).length,
    waitingControl: trials.filter(rule => (rule.evaluation?.controlOpportunities ?? 0) < 2).length,
    negativeTreatment: trials.filter(rule => (rule.evaluation?.treatmentFailures ?? 0) > 0).length,
    inconclusive: live.reduce((sum, rule) => sum + (rule.evaluation?.inconclusiveOutcomes ?? 0), 0),
    utilityMeasured: false as const,
    correctionReminders: live.filter(rule => rule.status === 'guardrail' && rule.correctionLesson !== undefined).length,
    correctionUses: lessons.reduce((sum, lesson) => sum + lesson.reminders, 0),
    verifiedCorrectionReuses: lessons.reduce((sum, lesson) => sum + lesson.verifiedReuses, 0),
    repeatedCorrections: lessons.reduce((sum, lesson) => sum + lesson.repeatCorrections, 0),
    failedCorrectionReuses: lessons.reduce((sum, lesson) => sum + lesson.failedReuses, 0),
    inconclusiveCorrectionReuses: lessons.reduce((sum, lesson) => sum + lesson.inconclusive, 0),
    verification: { plans: checkSum('plans'), passed: checkSum('passed'), failed: checkSum('failed'),
      insufficient: checkSum('insufficient'), unsupported: checkSum('unsupported'), stale: checkSum('stale'),
      errors: checkSum('errors'), attempts: checkSum('attempts'), failedAttempts: checkSum('failedAttempts'),
      repaired: checkSum('repaired'), firstPass: checkSum('firstPass') },
    admission: { ...(state.admissionCounters ?? {}) },
    improvement: methodDiagnostics(state),
  }
}
