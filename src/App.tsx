import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  CalendarRange,
  Check,
  Clock3,
  Cpu,
  Database,
  Download,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  Wallet,
  X,
  Zap,
} from 'lucide-react'
import './App.css'

const EarningsChart = lazy(() => import('./EarningsChart'))
const DailyBarChart = lazy(() => import('./DailyBarChart'))
const MonthlyBarChart = lazy(() => import('./MonthlyBarChart'))

type Snapshot = {
  recordedAt: string
  cumulativeAtomic: string
  pendingAtomic: string
  paidAtomic: string
  totalHashes: string
  lastHashSeconds: number
}

type ActiveWorker = {
  name: string
  hashrate: number
  lastShare: number
  totalHashes?: number
}

type DailyRecord = {
  dayKey: string
  earnedAtomic: string
  sampleCount: number
  gapCount: number
  finalized: boolean
}

type MonthRecord = {
  monthKey: string
  label: string
  fullMonth: string
  earned: number
  earnedAtomic: string
  daysCount: number
  sampleCount: number
  isCurrent: boolean
}

type FiatRates = {
  usd: number
  inr: number
}

type DashboardData = {
  settings: { address: string; timeZone: string } | null
  latest: Snapshot | null
  snapshots: Snapshot[]
  workers?: ActiveWorker[]
  days: DailyRecord[]
  fiat?: FiatRates | null
  collector: { lastPollAt: string | null; lastError: string | null; isPolling: boolean }
  serverTime: string
}

type WindowChoice = 'hour' | 'day' | 'today' | 'month' | 'custom'
type FiatPref = 'both' | 'usd' | 'inr'

const atomicScale = 1_000_000_000_000n
const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const appStartedAt = Date.now()

function formatXmr(value: string | bigint, digits = 8) {
  const amount = BigInt(value)
  const negative = amount < 0n
  const absolute = negative ? -amount : amount
  const whole = absolute / atomicScale
  const fraction = (absolute % atomicScale).toString().padStart(12, '0').slice(0, digits)
  return `${negative ? '-' : ''}${whole.toLocaleString()}.${fraction}`
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

function formatHashrate(h: number) {
  if (!h || h <= 0) return '0 H/s'
  if (h >= 1_000_000) return `${(h / 1_000_000).toFixed(2)} MH/s`
  if (h >= 1_000) return `${(h / 1_000).toFixed(1)} KH/s`
  return `${h.toLocaleString()} H/s`
}

function formatFiat(
  atomic: string | bigint,
  fiat?: FiatRates | null,
  pref: FiatPref = 'both',
  perHour = false
): string | null {
  if (!fiat || (!fiat.usd && !fiat.inr)) return null
  const xmr = Number(BigInt(atomic)) / Number(atomicScale)
  if (xmr < 0) return null

  const usd = xmr * (fiat.usd || 0)
  const inr = xmr * (fiat.inr || 0)

  const formatVal = (val: number, symbol: string) => {
    if (val === 0) return `${symbol}0.00`
    if (val < 0.01) return `${symbol}${val.toFixed(4)}`
    return `${symbol}${val.toLocaleString(symbol === '₹' ? 'en-IN' : 'en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }

  const suffix = perHour ? '/hr' : ''
  const usdStr = `${formatVal(usd, '$')}${suffix}`
  const inrStr = `${formatVal(inr, '₹')}${suffix}`

  if (pref === 'usd') return usdStr
  if (pref === 'inr') return inrStr
  return `${usdStr} · ${inrStr}`
}

function localDayKey(timestamp: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function zonedMidnight(dayKey: string, timeZone: string) {
  const [year, month, day] = dayKey.split('-').map(Number)
  const target = Date.UTC(year, month - 1, day)
  let guess = target
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess))
    const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]))
    const represented = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second)
    guess += target - represented
  }
  return guess
}

function zonedMonthStart(dayKey: string, timeZone: string) {
  const [year, month] = dayKey.split('-').map(Number)
  const monthDayKey = `${year}-${String(month).padStart(2, '0')}-01`
  return zonedMidnight(monthDayKey, timeZone)
}

function localInput(timestamp: number) {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}

function cumulativeAt(samples: Snapshot[], timestamp: number) {
  if (!samples.length) return null
  let previous = samples[0]
  if (timestamp <= Date.parse(previous.recordedAt)) return BigInt(previous.cumulativeAtomic)
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index]
    const previousTime = Date.parse(previous.recordedAt)
    const currentTime = Date.parse(current.recordedAt)
    if (timestamp <= currentTime) {
      const duration = BigInt(Math.max(1, currentTime - previousTime))
      const elapsed = BigInt(Math.max(0, timestamp - previousTime))
      const difference = BigInt(current.cumulativeAtomic) - BigInt(previous.cumulativeAtomic)
      if (difference <= 0n) return BigInt(previous.cumulativeAtomic)
      return BigInt(previous.cumulativeAtomic) + difference * elapsed / duration
    }
    previous = current
  }
  return BigInt(previous.cumulativeAtomic)
}

function intervalAmount(samples: Snapshot[], from: number, to: number) {
  const start = cumulativeAt(samples, from)
  const end = cumulativeAt(samples, to)
  return start === null || end === null || end < start ? 0n : end - start
}

async function requestJson<T>(url: string, options: RequestInit = {}, accessKey = ''): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(accessKey ? { 'X-Dashboard-Key': accessKey } : {}),
      ...options.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || (response.status === 401 ? 'Enter the dashboard password to continue.' : `Request failed (${response.status})`))
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function App() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [choice, setChoice] = useState<WindowChoice>('day')
  const [customFrom, setCustomFrom] = useState(() => localInput(appStartedAt - 60 * 60 * 1000))
  const [customTo, setCustomTo] = useState(() => localInput(appStartedAt))
  const [fiatPref, setFiatPref] = useState<FiatPref>(() => (localStorage.getItem('orelog_fiat_pref') as FiatPref) || 'both')
  const [historyView, setHistoryView] = useState<'daily' | 'monthly'>('daily')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [addressInput, setAddressInput] = useState('')
  const [timeZoneInput, setTimeZoneInput] = useState(defaultTimeZone)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [clock, setClock] = useState(appStartedAt)
  const [dialogTab, setDialogTab] = useState<'settings' | 'data'>('settings')
  const [exportScope, setExportScope] = useState<'all' | 'today' | 'date'>('today')
  const [exportDateInput, setExportDateInput] = useState(() => new Date().toISOString().slice(0, 10))
  const [deleteScope, setDeleteScope] = useState<'today' | 'date' | 'all'>('today')
  const [deleteDateInput, setDeleteDateInput] = useState(() => new Date().toISOString().slice(0, 10))
  const [deleting, setDeleting] = useState(false)

  const cycleFiatPref = () => {
    setFiatPref((current) => {
      const next = current === 'both' ? 'usd' : current === 'usd' ? 'inr' : 'both'
      localStorage.setItem('orelog_fiat_pref', next)
      return next
    })
  }

  const handleExport = (scope: 'all' | 'today' | 'date', date?: string) => {
    const params = new URLSearchParams({ scope })
    if (scope === 'date' && date) params.set('date', date)
    window.open(`/api/export?${params.toString()}`, '_blank')
  }

  const handleDelete = async (scope: 'all' | 'today' | 'date', date?: string) => {
    const label = scope === 'all' ? 'ALL historical earnings data' : scope === 'today' ? "today's collected data" : `data for ${date}`
    if (!window.confirm(`Are you sure you want to permanently delete ${label}?`)) return
    setDeleting(true)
    setError('')
    try {
      await requestJson('/api/data', {
        method: 'DELETE',
        body: JSON.stringify({ scope, date }),
      })
      setNotice(`Deleted ${label} successfully.`)
      await refresh()
      window.setTimeout(() => setNotice(''), 6000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete data.')
    } finally {
      setDeleting(false)
    }
  }

  const refresh = useCallback(async (startAt?: number, endAt?: number) => {
    try {
      const params = new URLSearchParams()
      if (startAt) params.set('from', String(startAt))
      if (endAt) params.set('to', String(endAt))
      const result = await requestJson<DashboardData>(`/api/data?${params}`)
      setData(result)
      setAddressInput((current) => current || result.settings?.address || '')
      setTimeZoneInput(result.settings?.timeZone || defaultTimeZone)
      setError(result.collector.lastError || '')
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Unable to load dashboard data.'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshLatestPeriod = useEffectEvent(() => {
    void refresh()
  })

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const initial = window.setTimeout(refreshLatestPeriod, 0)
    const timer = window.setInterval(refreshLatestPeriod, 60_000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [])

  // Trigger server-side poll
  useEffect(() => {
    const poll = () => fetch('/api/poll').catch(() => {})
    poll()
    const timer = window.setInterval(poll, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const timeZone = data?.settings?.timeZone || timeZoneInput || defaultTimeZone
  const latestAt = data?.latest ? Date.parse(data.latest.recordedAt) : 0
  const latestAge = latestAt ? Math.max(0, Math.floor((clock - latestAt) / 1000)) : null
  const minerAge = data?.latest?.lastHashSeconds
    ? Math.max(0, Math.floor(clock / 1000) - data.latest.lastHashSeconds)
    : null
  const minerOnline = minerAge !== null && minerAge < 10 * 60

  const windowRange = useMemo(() => {
    const end = latestAt || clock
    if (choice === 'hour') return { from: end - 60 * 60 * 1000, to: end }
    if (choice === 'today') return { from: zonedMidnight(localDayKey(end, timeZone), timeZone), to: end }
    if (choice === 'month') return { from: zonedMonthStart(localDayKey(end, timeZone), timeZone), to: end }
    if (choice === 'custom') {
      const from = Date.parse(customFrom) || end - 60 * 60 * 1000
      const to = Math.min(Date.parse(customTo) || end, end)
      return { from: Math.min(from, to), to: Math.max(from, to) }
    }
    return { from: end - 24 * 60 * 60 * 1000, to: end }
  }, [choice, customFrom, customTo, latestAt, clock, timeZone])

  const refreshSelectedRange = useEffectEvent(() => {
    if (data?.latest) void refresh(windowRange.from, windowRange.to)
  })

  useEffect(() => {
    const timer = window.setTimeout(refreshSelectedRange, 0)
    return () => window.clearTimeout(timer)
  }, [choice, customFrom, customTo, data?.latest?.recordedAt])

  const intervalEarned = useMemo(
    () => intervalAmount(data?.snapshots || [], windowRange.from, windowRange.to),
    [data?.snapshots, windowRange.from, windowRange.to]
  )
  const oneHourEarned = data?.latest && data.snapshots.length
    ? intervalAmount(data.snapshots, latestAt - 60 * 60 * 1000, latestAt)
    : 0n
  const dayKey = localDayKey(latestAt || clock, timeZone)
  const todayRecord = data?.days.find((day) => day.dayKey === dayKey)
  const todayEarned = BigInt(todayRecord?.earnedAtomic || '0')
  
  const currentMonthKey = dayKey.slice(0, 7) // "YYYY-MM"
  const currentMonthName = useMemo(() => {
    const [year, month] = currentMonthKey.split('-').map(Number)
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()
  }, [currentMonthKey])

  const thisMonthEarned = useMemo(() => {
    if (!data?.days?.length) return 0n
    return data.days
      .filter((day) => day.dayKey.startsWith(currentMonthKey))
      .reduce((acc, day) => acc + BigInt(day.earnedAtomic || '0'), 0n)
  }, [data?.days, currentMonthKey])

  const monthlyRecords = useMemo<MonthRecord[]>(() => {
    if (!data?.days?.length) return []
    const map = new Map<string, { earnedAtomic: bigint; sampleCount: number; daysCount: number }>()

    for (const day of data.days) {
      const mKey = day.dayKey.slice(0, 7)
      const existing = map.get(mKey) || { earnedAtomic: 0n, sampleCount: 0, daysCount: 0 }
      existing.earnedAtomic += BigInt(day.earnedAtomic || '0')
      existing.sampleCount += day.sampleCount || 0
      existing.daysCount += 1
      map.set(mKey, existing)
    }

    const result: MonthRecord[] = []
    for (const [mKey, val] of map.entries()) {
      const [year, month] = mKey.split('-').map(Number)
      const date = new Date(Date.UTC(year, month - 1, 1))
      const label = date.toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
      const fullMonth = date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      result.push({
        monthKey: mKey,
        label,
        fullMonth,
        earnedAtomic: val.earnedAtomic.toString(),
        earned: Number(val.earnedAtomic) / Number(atomicScale),
        daysCount: val.daysCount,
        sampleCount: val.sampleCount,
        isCurrent: mKey === currentMonthKey,
      })
    }

    return result.sort((a, b) => b.monthKey.localeCompare(a.monthKey))
  }, [data?.days, currentMonthKey])

  const hourlyRate = windowRange.to > windowRange.from
    ? Number(intervalEarned) / Number(atomicScale) / ((windowRange.to - windowRange.from) / 3_600_000)
    : 0
  const hourlyRateAtomic = BigInt(Math.max(0, Math.round(hourlyRate * Number(atomicScale))))

  const activeWorkers = useMemo(() => data?.workers || [], [data?.workers])
  const onlineWorkersCount = useMemo(() => {
    return activeWorkers.filter((worker) => {
      const workerAge = worker.lastShare > 0 ? Math.max(0, Math.floor(clock / 1000) - worker.lastShare) : null
      return (workerAge !== null && workerAge < 600) || worker.hashrate > 0
    }).length
  }, [activeWorkers, clock])

  const chartData = useMemo(() => {
    const samples = data?.snapshots || []
    const baseCombined = cumulativeAt(samples, windowRange.from)
    if (baseCombined === null) return []
    
    const points: Array<{ at: number; earned: number }> = [
      { at: windowRange.from, earned: 0 }
    ]

    for (const sample of samples) {
      const timestamp = Date.parse(sample.recordedAt)
      if (timestamp < windowRange.from || timestamp > windowRange.to) continue
      
      const valCombined = BigInt(sample.cumulativeAtomic) - baseCombined
      points.push({ 
        at: timestamp, 
        earned: Number(valCombined > 0n ? valCombined : 0n) / Number(atomicScale) 
      })
    }
    
    if (points.length === 1 && data?.latest) {
      const valCombined = intervalAmount(samples, windowRange.from, windowRange.to)
      points.push({ 
        at: windowRange.to, 
        earned: Number(valCombined) / Number(atomicScale) 
      })
    }
    return points
  }, [data?.snapshots, data?.latest, windowRange.from, windowRange.to])

  const saveSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const response = await requestJson<{ reset: boolean }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ address: addressInput, timeZone: timeZoneInput }),
      })
      setSettingsOpen(false)
      setNotice(response.reset ? 'Wallet or timezone changed. A new earnings log has started.' : 'Miner connected. Logging starts from the first pool snapshot.')
      await refresh()
      window.setTimeout(() => setNotice(''), 7000)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save settings.')
    } finally {
      setSaving(false)
    }
  }

  const chooseWindow = (next: WindowChoice) => {
    setChoice(next)
    if (next === 'custom') {
      setCustomTo(localInput(latestAt || Date.now()))
      setCustomFrom(localInput((latestAt || Date.now()) - 60 * 60 * 1000))
    }
  }

  const activePeriodName =
    choice === 'hour'
      ? 'Last hour'
      : choice === 'day'
      ? 'Last 24 hours'
      : choice === 'today'
      ? 'Today'
      : choice === 'month'
      ? `This month (${currentMonthName})`
      : 'Selected interval'

  const formattedLatest = data?.latest
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(data.latest.recordedAt))
    : 'Waiting for first snapshot'
  const refreshWindow = () => {
    setLoading(true)
    void refresh(windowRange.from, windowRange.to)
  }

  if (!loading && !data?.settings) {
    return (
      <main className="setup-screen">
        <header className="topbar setup-topbar">
          <Brand />
          <span className="topbar-note"><ShieldCheck size={15} /> Read-only pool connection</span>
        </header>
        <section className="setup-content">
          <div className="setup-index">01 / CONNECT</div>
          <h1>Start your<br /><span>earnings log.</span></h1>
          <p className="setup-copy">Connect a miner address to begin measuring credited XMR. Collection starts with the first pool snapshot; prior earnings are not included in interval totals.</p>
          <form className="setup-form" onSubmit={saveSettings}>
            <label className="field-label" htmlFor="setup-address">Monero wallet address</label>
            <input id="setup-address" autoComplete="off" spellCheck={false} value={addressInput} onChange={(event) => setAddressInput(event.target.value)} placeholder="4... or 8..." required />
            <label className="field-label" htmlFor="setup-timezone">Daily log timezone</label>
            <input id="setup-timezone" value={timeZoneInput} onChange={(event) => setTimeZoneInput(event.target.value)} placeholder="Europe/London" required />
            <div className="setup-footnote"><Clock3 size={15} /> Days close at midnight in this timezone.</div>
            {error && <p className="form-error">{error}</p>}
            <button className="button button-primary" type="submit" disabled={saving}>{saving ? <RefreshCw className="spin" size={16} /> : <Activity size={16} />} {saving ? 'Connecting…' : 'Connect miner'}</button>
          </form>
        </section>
        <footer className="setup-footer"><span>SUPPORTXMR · XMR TRACKER</span><span>COLLECTION INTERVAL 60 SEC</span></footer>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        <div className="pool-label"><span className="pool-pip" /> SUPPORTXMR <span className="topbar-divider">/</span> MONERO</div>
        
        {data?.fiat?.usd ? (
          <button
            type="button"
            className="fiat-ticker-pill"
            onClick={cycleFiatPref}
            title={`Click to switch currency format (USD / INR / Both)`}
          >
            <span className="fiat-ticker-dot" />
            <span>1 XMR ≈ {fiatPref === 'inr' ? `₹${data.fiat.inr.toLocaleString('en-IN')}` : fiatPref === 'usd' ? `$${data.fiat.usd.toFixed(2)}` : `$${data.fiat.usd.toFixed(2)} · ₹${data.fiat.inr.toLocaleString('en-IN')}`}</span>
          </button>
        ) : null}

        <div className="topbar-actions">
          <div className={`connection-state ${data?.collector.lastError ? 'connection-error' : ''}`}>
            <span className="live-pip" />
            {data?.collector.lastError ? 'API ISSUE' : loading ? 'SYNCING' : 'COLLECTING'}
          </div>
          <button className="icon-button" aria-label="Dashboard settings" title="Dashboard settings" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button>
          <button className="icon-button" aria-label="Refresh data" title="Refresh data" onClick={refreshWindow}><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
        </div>
      </header>

      <main className="dashboard-main">
        <section className="page-heading">
          <div>
            <p className="eyebrow">MINER PERFORMANCE <span>·</span> {data?.settings?.address.slice(0, 8)}…{data?.settings?.address.slice(-6)}</p>
            <h1>Earnings <span>monitor</span></h1>
          </div>
          <div className="activity-badge">
            <span className={`activity-pip ${minerOnline ? '' : 'activity-idle'}`} />
            <div><strong>{minerOnline ? 'Miner active' : 'No recent shares'}</strong><small>{minerAge === null ? 'Waiting for first share' : `Last share ${formatAge(minerAge)} ago`}</small></div>
          </div>
        </section>

        {notice && <div className="notice"><Check size={16} /> {notice}<button aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={15} /></button></div>}
        {error && <div className="error-banner"><AlertTriangle size={16} /><span>{error}</span></div>}

        <section className="earnings-layout">
          <div className="earnings-focus">
            <div className="focus-topline">
              <span><Activity size={15} /> CREDITS IN INTERVAL</span>
              <span className="asof">AS OF {formattedLatest}</span>
            </div>
            <div className="focus-value">
              <span>{formatXmr(intervalEarned)}</span>
              <em>XMR</em>
            </div>
            {data?.fiat && (
              <div className="focus-fiat">
                ≈ {formatFiat(intervalEarned, data.fiat, fiatPref) || '—'}
              </div>
            )}
            <div className="focus-bottomline">
              <div className="rate-readout">
                <ArrowUpRight size={16} />
                <strong>{formatXmr(hourlyRateAtomic)}</strong>
                <span>XMR / HR</span>
                {data?.fiat && hourlyRate > 0 && (
                  <span className="rate-fiat">
                    (≈ {formatFiat(hourlyRateAtomic, data.fiat, fiatPref, true)})
                  </span>
                )}
              </div>
              <div className="window-controls" role="group" aria-label="Earnings interval">
                <button className={choice === 'hour' ? 'selected' : ''} onClick={() => chooseWindow('hour')}>1H</button>
                <button className={choice === 'day' ? 'selected' : ''} onClick={() => chooseWindow('day')}>24H</button>
                <button className={choice === 'today' ? 'selected' : ''} onClick={() => chooseWindow('today')}>TODAY</button>
                <button className={choice === 'month' ? 'selected' : ''} onClick={() => chooseWindow('month')}>MONTH</button>
                <button className={choice === 'custom' ? 'selected' : ''} onClick={() => chooseWindow('custom')}><CalendarDays size={14} /><span>CUSTOM</span></button>
              </div>
            </div>
            {choice === 'custom' && <div className="custom-range">
              <label>FROM <input aria-label="Interval start" type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label>
              <ArrowDownRight size={14} />
              <label>TO <input aria-label="Interval end" type="datetime-local" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label>
              <span>Device local time</span>
            </div>}
          </div>

          <div className="metric-stack">
            <Metric
              label="TODAY · MIDNIGHT RESET"
              value={formatXmr(todayEarned)}
              fiatValue={formatFiat(todayEarned, data?.fiat, fiatPref)}
              unit="XMR"
              icon={<CalendarDays size={16} />}
              accent="orange"
            />
            <Metric
              label={`THIS MONTH · ${currentMonthName}`}
              value={formatXmr(thisMonthEarned)}
              fiatValue={formatFiat(thisMonthEarned, data?.fiat, fiatPref)}
              unit="XMR"
              icon={<CalendarRange size={16} />}
              accent="purple"
            />
            <Metric
              label="PENDING BALANCE"
              value={formatXmr(data?.latest?.pendingAtomic || '0')}
              fiatValue={formatFiat(data?.latest?.pendingAtomic || '0', data?.fiat, fiatPref)}
              unit="XMR"
              icon={<Wallet size={16} />}
              accent="mint"
            />
            <Metric
              label="LAST HOUR"
              value={formatXmr(oneHourEarned)}
              fiatValue={formatFiat(oneHourEarned, data?.fiat, fiatPref)}
              unit="XMR"
              icon={<Zap size={16} />}
              accent="blue"
            />
          </div>
        </section>

        {/* Active Workers Section */}
        <section className="worker-panel">
          <div className="section-heading lower-heading">
            <div>
              <p className="eyebrow">SUPPORTXMR POOL</p>
              <h2>Active miners</h2>
            </div>
            <span className="timezone-tag">
              {onlineWorkersCount > 0 ? `${onlineWorkersCount} MINING NOW` : 'NO ACTIVE WORKERS'}
            </span>
          </div>
          <div className="worker-grid">
            {activeWorkers.map((worker) => {
              const workerAge = worker.lastShare > 0 ? Math.max(0, Math.floor(clock / 1000) - worker.lastShare) : null
              const isOnline = (workerAge !== null && workerAge < 600) || worker.hashrate > 0
              const currentHashrate = isOnline ? worker.hashrate : 0
              return (
                <article className="worker-card" key={worker.name}>
                  <div className="worker-card-header">
                    <span className="worker-name">
                      <Cpu size={14} />
                      {worker.name}
                    </span>
                    <span className={`worker-status-badge ${isOnline ? 'worker-status-online' : 'worker-status-idle'}`}>
                      <span className="worker-status-pip" />
                      {isOnline ? 'MINING' : 'IDLE'}
                    </span>
                  </div>
                  <div className="worker-stats">
                    <div className="worker-hashrate">
                      {formatHashrate(currentHashrate)}
                    </div>
                    <div className="worker-last-share">
                      {workerAge === null ? 'No shares yet' : `Last share ${formatAge(workerAge)} ago`}
                    </div>
                  </div>
                </article>
              )
            })}
            {!activeWorkers.length && (
              <p className="worker-empty">
                <Cpu size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '6px' }} />
                {data?.latest ? 'No separate worker IDs reported. Mining under default account.' : 'Waiting for worker activity from SupportXMR.'}
              </p>
            )}
          </div>
        </section>

        <section className="chart-section">
          <div className="section-heading">
            <div><p className="eyebrow">CUMULATIVE POOL CREDIT</p><h2>{activePeriodName}</h2></div>
            <div className="chart-legend"><span /> EARNED XMR</div>
          </div>
          <div className="chart-wrap">
            {chartData.length > 1 ? <Suspense fallback={<div className="chart-empty">Loading chart…</div>}>
              <EarningsChart data={chartData} from={windowRange.from} to={windowRange.to} />
            </Suspense> : <div className="chart-empty"><Activity size={19} /><span>{data?.latest ? 'More snapshots will shape this chart.' : 'Waiting for the first pool snapshot.'}</span></div>}
          </div>
          <div className="chart-foot"><span>INTERVAL START <strong>{new Date(windowRange.from).toLocaleString()}</strong></span><span>ESTIMATED RATE <strong>{formatXmr(hourlyRateAtomic)} XMR / HR</strong></span><span>COLLECTION EVERY 60 SEC</span></div>
        </section>

        <section className="lower-grid">
          <div className="daily-panel">
            <div className="section-heading lower-heading">
              <div>
                <p className="eyebrow">HISTORICAL LEDGER <span>·</span> {timeZone}</p>
                <h2>{historyView === 'daily' ? 'Daily earnings' : 'Monthly earnings'}</h2>
              </div>
              <div className="view-toggle-group" role="tablist" aria-label="Ledger view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={historyView === 'daily'}
                  className={`view-toggle-btn ${historyView === 'daily' ? 'active' : ''}`}
                  onClick={() => setHistoryView('daily')}
                >
                  Daily
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={historyView === 'monthly'}
                  className={`view-toggle-btn ${historyView === 'monthly' ? 'active' : ''}`}
                  onClick={() => setHistoryView('monthly')}
                >
                  Monthly
                </button>
              </div>
            </div>

            {historyView === 'daily' ? (
              <>
                {data?.days && data.days.length > 0 && (
                  <Suspense fallback={null}>
                    <DailyBarChart days={data.days} fiat={data?.fiat} fiatPref={fiatPref} />
                  </Suspense>
                )}
                <div className="daily-table-wrap">
                  <table className="daily-table">
                    <thead><tr><th>DAY</th><th>EARNED</th><th>STATUS</th><th>ACTIONS</th></tr></thead>
                    <tbody>{(data?.days || []).slice(0, 14).map((day) => <tr key={day.dayKey}>
                      <td><span className="day-date">{day.dayKey}</span><small>{day.sampleCount.toLocaleString()} samples</small></td>
                      <td className="daily-amount">
                        <div>{formatXmr(day.earnedAtomic)} <small>XMR</small></div>
                        {data?.fiat && (
                          <small className="daily-fiat-sub">
                            ≈ {formatFiat(day.earnedAtomic, data.fiat, fiatPref)}
                          </small>
                        )}
                      </td>
                      <td><span className={`record-status ${day.finalized ? 'finalized' : 'recording'}`}><span />{day.finalized ? 'FINAL' : 'RECORDING'}</span></td>
                      <td>
                        <div className="table-actions">
                          <button className="icon-action-button" title={`Export JSON for ${day.dayKey}`} onClick={() => handleExport('date', day.dayKey)}><Download size={13} /></button>
                          <button className="icon-action-button action-danger" title={`Delete data for ${day.dayKey}`} onClick={() => handleDelete('date', day.dayKey)}><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>)}</tbody>
                  </table>
                  {!data?.days.length && <div className="table-empty">The daily log begins with your first pool snapshot.</div>}
                </div>
                <p className="table-note"><ShieldCheck size={14} /> Daily totals are based on pool balance changes recorded during active monitoring.</p>
              </>
            ) : (
              <>
                {monthlyRecords.length > 0 && (
                  <Suspense fallback={null}>
                    <MonthlyBarChart months={monthlyRecords} fiat={data?.fiat} fiatPref={fiatPref} />
                  </Suspense>
                )}
                <div className="daily-table-wrap">
                  <table className="daily-table">
                    <thead><tr><th>MONTH</th><th>TOTAL EARNED</th><th>DAILY AVG</th><th>DAYS MONITORED</th></tr></thead>
                    <tbody>{monthlyRecords.map((m) => {
                      const avgDailyAtomic = m.daysCount > 0 ? (BigInt(m.earnedAtomic) / BigInt(m.daysCount)).toString() : '0'
                      return (
                        <tr key={m.monthKey}>
                          <td>
                            <span className="day-date">{m.fullMonth}</span>
                            <small>{m.sampleCount.toLocaleString()} samples</small>
                          </td>
                          <td className="daily-amount">
                            <div>{formatXmr(m.earnedAtomic)} <small>XMR</small></div>
                            {data?.fiat && (
                              <small className="daily-fiat-sub">
                                ≈ {formatFiat(m.earnedAtomic, data.fiat, fiatPref)}
                              </small>
                            )}
                          </td>
                          <td className="daily-amount">
                            <div>{formatXmr(avgDailyAtomic, 6)} <small>XMR/day</small></div>
                            {data?.fiat && (
                              <small className="daily-fiat-sub">
                                ≈ {formatFiat(avgDailyAtomic, data.fiat, fiatPref)}/day
                              </small>
                            )}
                          </td>
                          <td>
                            <span className={`record-status ${m.isCurrent ? 'recording' : 'finalized'}`}>
                              <span />
                              {m.isCurrent ? `${m.daysCount}d (In progress)` : `${m.daysCount} days recorded`}
                            </span>
                          </td>
                        </tr>
                      )
                    })}</tbody>
                  </table>
                  {!monthlyRecords.length && <div className="table-empty">Monthly records will appear as daily logs are recorded.</div>}
                </div>
                <p className="table-note"><ShieldCheck size={14} /> Monthly metrics aggregate all verified daily snapshots for each calendar month.</p>
              </>
            )}
          </div>

          <aside className="status-panel">
            <div className="section-heading lower-heading"><div><p className="eyebrow">COLLECTOR STATUS</p><h2>System pulse</h2></div><span className={`pulse-icon ${data?.collector.lastError ? 'pulse-error' : ''}`}><Activity size={18} /></span></div>
            <div className="pulse-row"><span><span className={`status-dot ${data?.collector.lastError ? 'dot-error' : ''}`} />POOL API</span><strong>{data?.collector.lastError ? 'CHECK CONNECTION' : 'RESPONDING'}</strong></div>
            <div className="pulse-row"><span><Database size={14} />STORAGE</span><strong>{data?.latest ? 'RECORDING' : 'READY'}</strong></div>
            <div className="pulse-row"><span><Clock3 size={14} />LAST CHECK</span><strong>{latestAge === null ? '—' : `${formatAge(latestAge)} AGO`}</strong></div>
            <div className="pulse-row"><span><Cpu size={14} />TOTAL HASHES</span><strong>{formatNumber(Number(data?.latest?.totalHashes || 0))}</strong></div>
            {data?.fiat?.usd ? (
              <div className="pulse-row"><span><Zap size={14} />XMR PRICE</span><strong>${data.fiat.usd.toFixed(2)} · ₹{data.fiat.inr.toLocaleString('en-IN')}</strong></div>
            ) : null}
            <div className="pulse-foot"><span className="pool-pip" /> READ-ONLY · SUPPORTXMR</div>
          </aside>
        </section>

        <footer className="app-footer"><span>SUPPORTXMR EARNINGS MONITOR</span><span>POOL VALUES REFRESH ON A 60-SECOND CADENCE</span><span>LAST RESPONSE {formattedLatest}</span></footer>
      </main>

      {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
        <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="dialog-heading">
            <div>
              <p className="eyebrow">DASHBOARD & DATA</p>
              <h2 id="settings-title">{dialogTab === 'settings' ? 'Miner settings' : 'Data management'}</h2>
            </div>
            <button className="icon-button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={18} /></button>
          </div>

          <div className="dialog-tabs">
            <button type="button" className={`tab-button ${dialogTab === 'settings' ? 'active' : ''}`} onClick={() => setDialogTab('settings')}>Configuration</button>
            <button type="button" className={`tab-button ${dialogTab === 'data' ? 'active' : ''}`} onClick={() => setDialogTab('data')}>Backup & Delete</button>
          </div>

          {dialogTab === 'settings' ? (
            <form className="setup-form" onSubmit={saveSettings}>
              <label className="field-label" htmlFor="settings-address">Monero wallet address</label>
              <input id="settings-address" autoComplete="off" spellCheck={false} value={addressInput} onChange={(event) => setAddressInput(event.target.value)} required />
              <label className="field-label" htmlFor="settings-timezone">Daily log timezone</label>
              <input id="settings-timezone" value={timeZoneInput} onChange={(event) => setTimeZoneInput(event.target.value)} required />
              
              <label className="field-label" htmlFor="settings-fiat">Preferred fiat display currency</label>
              <select
                id="settings-fiat"
                value={fiatPref}
                onChange={(e) => {
                  const val = e.target.value as FiatPref
                  setFiatPref(val)
                  localStorage.setItem('orelog_fiat_pref', val)
                }}
                className="fiat-select"
              >
                <option value="both">Both (USD $ + INR ₹)</option>
                <option value="usd">USD ($) only</option>
                <option value="inr">INR (₹) only</option>
              </select>

              <p className="settings-warning"><AlertTriangle size={15} /> Changing the wallet or timezone clears this local earnings history and starts a new log.</p>
              {error && <p className="form-error">{error}</p>}
              <div className="dialog-actions">
                <button className="button button-quiet" type="button" onClick={() => setSettingsOpen(false)}>Cancel</button>
                <button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
              </div>
            </form>
          ) : (
            <div className="data-mgmt-section">
              <div className="data-mgmt-card">
                <h3><Download size={15} /> Save / Export Data (JSON)</h3>
                <p>Download a gapless JSON backup of your balance snapshots and daily earnings records.</p>
                <div className="mgmt-controls">
                  <select value={exportScope} onChange={(e) => setExportScope(e.target.value as any)}>
                    <option value="today">Today's Data</option>
                    <option value="date">Specific Date</option>
                    <option value="all">All History</option>
                  </select>
                  {exportScope === 'date' && (
                    <input type="date" value={exportDateInput} onChange={(e) => setExportDateInput(e.target.value)} />
                  )}
                  <button type="button" className="button button-primary" onClick={() => handleExport(exportScope, exportDateInput)}>
                    <Download size={14} /> Download JSON
                  </button>
                </div>
              </div>

              <div className="data-mgmt-card">
                <h3><Trash2 size={15} /> Delete Collected Data</h3>
                <p>Permanently remove recorded snapshots from the database. Useful for clearing test runs or specific dates.</p>
                <div className="mgmt-controls">
                  <select value={deleteScope} onChange={(e) => setDeleteScope(e.target.value as any)}>
                    <option value="today">Today's Data</option>
                    <option value="date">Specific Date</option>
                    <option value="all">All History</option>
                  </select>
                  {deleteScope === 'date' && (
                    <input type="date" value={deleteDateInput} onChange={(e) => setDeleteDateInput(e.target.value)} />
                  )}
                  <button type="button" className="button button-danger" disabled={deleting} onClick={() => handleDelete(deleteScope, deleteDateInput)}>
                    <Trash2 size={14} /> {deleting ? 'Deleting…' : 'Delete Data'}
                  </button>
                </div>
              </div>

              {error && <p className="form-error">{error}</p>}
              <div className="dialog-actions">
                <button className="button button-quiet" type="button" onClick={() => setSettingsOpen(false)}>Close</button>
              </div>
            </div>
          )}
        </section>
      </div>}
    </div>
  )
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><Zap size={16} fill="currentColor" /></span><span>ORE<span className="brand-light">LOG</span></span></div>
}

function Metric({
  label,
  value,
  fiatValue,
  unit,
  icon,
  accent,
}: {
  label: string
  value: string
  fiatValue?: string | null
  unit: string
  icon: React.ReactNode
  accent: string
}) {
  return (
    <article className={`metric-card metric-${accent}`}>
      <div className="metric-label">
        <span>{label}</span>
        <span className="metric-icon">{icon}</span>
      </div>
      <div className="metric-value">
        <span>{value}</span>
        <small>{unit}</small>
      </div>
      {fiatValue && <div className="metric-fiat-sub">≈ {fiatValue}</div>}
    </article>
  )
}

function formatAge(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}

export default App
