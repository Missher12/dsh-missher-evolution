import type { PluginConfig, ResolvedConfig } from './types.js'

export const DEFAULT_CONFIG: Readonly<ResolvedConfig> = Object.freeze({
  enabled: true,
  maintenanceIntervalHours: 24,
  maxInjectedRules: 4,
})

export function normalizeConfig(input: unknown): ResolvedConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_CONFIG }
  }
  const config = input as PluginConfig
  return {
    enabled: typeof config.enabled === 'boolean' ? config.enabled : DEFAULT_CONFIG.enabled,
    maintenanceIntervalHours:
      Number.isInteger(config.maintenanceIntervalHours)
      && (config.maintenanceIntervalHours as number) >= 6
      && (config.maintenanceIntervalHours as number) <= 168
        ? config.maintenanceIntervalHours as number
        : DEFAULT_CONFIG.maintenanceIntervalHours,
    maxInjectedRules:
      Number.isInteger(config.maxInjectedRules)
      && (config.maxInjectedRules as number) >= 1
      && (config.maxInjectedRules as number) <= 4
        ? config.maxInjectedRules as number
        : DEFAULT_CONFIG.maxInjectedRules,
  }
}
