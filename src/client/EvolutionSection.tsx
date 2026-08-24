import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  EvolutionSnapshot,
  RemoteResetRequest,
  RemoteResetResult,
  SetEnabledRequest,
} from '../remote-contract.js'
import type { EvolutionKey } from './locales.js'
import styles from './EvolutionSection.module.css'

export interface EvolutionSectionProps {
  snapshot: () => Promise<RemoteResult<EvolutionSnapshot>>
  setEnabled: (request: SetEnabledRequest) => Promise<RemoteResult<EvolutionSnapshot>>
  reset: (request: RemoteResetRequest) => Promise<RemoteResult<RemoteResetResult>>
  t: (key: EvolutionKey) => string
}

export function EvolutionSection(props: Partial<EvolutionSectionProps>): ReactNode {
  const { snapshot, setEnabled, reset, t } = props
  if (snapshot === undefined || setEnabled === undefined || reset === undefined || t === undefined) return null
  return <Loaded snapshot={snapshot} setEnabled={setEnabled} reset={reset} t={t} />
}

function Loaded({ snapshot, setEnabled, reset, t }: EvolutionSectionProps): ReactNode {
  const [view, setView] = useState<EvolutionSnapshot>()
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<EvolutionKey>()
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const current = generation.current + 1
    generation.current = current
    setLoading(true)
    const result = await snapshot().catch(() => undefined)
    if (generation.current !== current) return
    setLoading(false)
    if (result?.ok !== true) {
      setLoadFailed(true)
      return
    }
    setLoadFailed(false)
    setNotice(undefined)
    setView(result.value)
  }, [snapshot])

  useEffect(() => {
    void load()
    return () => { generation.current += 1 }
  }, [load])

  const toggle = (enabled: boolean): void => {
    if (view === undefined || pending) return
    setPending(true)
    setNotice(undefined)
    void setEnabled({ enabled, expectedRevision: view.revision })
      .then((result) => {
        if (result.ok) setView(result.value)
        else setNotice('operationConflict')
      })
      .catch(() => { setNotice('operationConflict') })
      .finally(() => { setPending(false) })
  }

  const resetState = (): void => {
    if (view === undefined || pending || !acknowledged || confirmation !== 'RESET') return
    setPending(true)
    setNotice(undefined)
    void reset({ confirmation: 'RESET', expectedRevision: view.revision })
      .then((result) => {
        if (!result.ok) {
          setNotice('operationConflict')
          return
        }
        setView(result.value.snapshot)
        setAcknowledged(false)
        setConfirmation('')
        setNotice('resetDone')
      })
      .catch(() => { setNotice('operationConflict') })
      .finally(() => { setPending(false) })
  }

  if (view === undefined && loading) return <p className={styles['state']}>{t('loading')}</p>
  if (view === undefined && loadFailed) {
    return (
      <div className={styles['state']}>
        <p role="alert">{t('loadFailed')}</p>
        <button type="button" onClick={() => { void load() }}>{t('retry')}</button>
      </div>
    )
  }
  if (view === undefined) return null

  const healthKey = {
    healthy: 'healthy',
    degraded: 'degraded',
    state_unavailable: 'unavailable',
    lock_busy: 'lockBusy',
  }[view.health] as EvolutionKey
  const metrics: Array<[EvolutionKey, number]> = [
    ['captures', view.counters.captures],
    ['candidate', view.counters.candidate],
    ['trial', view.counters.trial],
    ['active', view.counters.active],
    ['weeklyInjections', view.counters.weeklyInjections],
  ]

  return (
    <section className={styles['section']} aria-busy={loading || pending}>
      <header className={styles['header']}>
        <div>
          <h2>{t('title')}</h2>
          <p>{t('subtitle')}</p>
        </div>
        <button type="button" className={styles['secondary']} onClick={() => { void load() }}>
          {t('refresh')}
        </button>
      </header>

      <div className={styles['controlRow']}>
        <label className={styles['toggle']}>
          <input
            type="checkbox"
            checked={view.enabled}
            disabled={pending}
            onChange={event => { toggle(event.currentTarget.checked) }}
          />
          <span>{t('enabled')}</span>
        </label>
        <span className={styles['health']} data-health={view.health}>{t(healthKey)}</span>
      </div>

      {notice === undefined ? null : <p className={styles['notice']} role="status">{t(notice)}</p>}

      <div className={styles['metrics']}>
        {metrics.map(([key, value]) => (
          <div className={styles['metric']} key={key}>
            <span>{t(key)}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div className={styles['rules']}>
        <h3>{t('rules')}</h3>
        {view.rules.length === 0
          ? <p className={styles['empty']}>{t('empty')}</p>
          : view.rules.map(rule => (
            <article className={styles['rule']} key={rule.id}>
              <div className={styles['badges']}>
                <span>{t(`status_${rule.status}`)}</span>
                <span>{t(`category_${rule.category}`)}</span>
                <span>{t(`task_${rule.taskType}`)}</span>
              </div>
              <p>{rule.instruction}</p>
              <small>{`${t('successFailure')}: ${rule.successes} / ${rule.failures}`}</small>
            </article>
          ))}
      </div>

      <div className={styles['reset']}>
        <h3>{t('resetTitle')}</h3>
        <p>{t('resetDescription')}</p>
        <label>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={event => { setAcknowledged(event.currentTarget.checked) }}
          />
          <span>{t('resetAcknowledgement')}</span>
        </label>
        <label className={styles['confirm']}>
          <span>{t('resetInput')}</span>
          <input
            type="text"
            value={confirmation}
            autoComplete="off"
            spellCheck={false}
            onChange={event => { setConfirmation(event.currentTarget.value) }}
          />
        </label>
        <button
          type="button"
          className={styles['danger']}
          disabled={pending || !acknowledged || confirmation !== 'RESET'}
          onClick={resetState}
        >
          {t('resetAction')}
        </button>
      </div>
    </section>
  )
}

