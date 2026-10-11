import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChevronLeft, ChevronRight } from 'lucide-react'

type DayItem = {
  dayKey: string
  fullDay: string
  earned: number
  finalized: boolean
}

type Props = {
  days: Array<{
    dayKey: string
    earnedAtomic: string
    finalized: boolean
  }>
  fiat?: { usd: number; inr: number } | null
  fiatPref?: 'both' | 'usd' | 'inr'
}

type Preset = '7d' | '14d' | '30d' | 'all'

function DailyTooltip({
  active,
  payload,
  fiat,
  fiatPref,
}: {
  active?: boolean
  payload?: Array<{ value: number; payload: DayItem }>
  fiat?: { usd: number; inr: number } | null
  fiatPref?: 'both' | 'usd' | 'inr'
}) {
  if (!active || !payload?.length) return null
  const item = payload[0].payload
  const xmr = item.earned
  const usd = fiat?.usd ? xmr * fiat.usd : 0
  const inr = fiat?.inr ? xmr * fiat.inr : 0

  let fiatStr = ''
  if (fiat?.usd || fiat?.inr) {
    if (fiatPref === 'usd') fiatStr = ` ≈ $${usd.toFixed(2)}`
    else if (fiatPref === 'inr') fiatStr = ` ≈ ₹${inr.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
    else fiatStr = ` ≈ $${usd.toFixed(2)} · ₹${inr.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
  }

  return (
    <div className="chart-tooltip">
      <span>{item.fullDay} {item.finalized ? '(Final)' : '(In progress)'}</span>
      <strong>{Number(item.earned).toFixed(8)} XMR{fiatStr}</strong>
    </div>
  )
}

export default function DailyBarChart({ days, fiat, fiatPref }: Props) {
  // Chronological order (oldest to newest)
  const allData: DayItem[] = useMemo(() => {
    return [...days]
      .sort((a, b) => a.dayKey.localeCompare(b.dayKey))
      .map((d) => ({
        dayKey: d.dayKey.slice(5),
        fullDay: d.dayKey,
        earned: Number(d.earnedAtomic) / 1e12,
        finalized: d.finalized,
      }))
  }, [days])

  // Presets available based on total days
  const availablePresets: Preset[] = useMemo(() => {
    const list: Preset[] = []
    if (allData.length > 7) list.push('7d')
    if (allData.length > 14) list.push('14d')
    if (allData.length > 30) list.push('30d')
    list.push('all')
    return list
  }, [allData.length])

  const [timeframe, setTimeframe] = useState<Preset>(() => {
    if (allData.length > 14) return '14d'
    if (allData.length > 7) return '7d'
    return 'all'
  })

  // Offset: how many days shifted back from the latest day
  const [offset, setOffset] = useState<number>(0)

  const windowSize = useMemo(() => {
    if (timeframe === '7d') return 7
    if (timeframe === '14d') return 14
    if (timeframe === '30d') return 30
    return allData.length
  }, [timeframe, allData.length])

  const maxOffset = Math.max(0, allData.length - windowSize)
  const currentOffset = Math.min(offset, maxOffset)

  // Sliced data based on windowSize and offset
  const { visibleData, startIndex } = useMemo(() => {
    if (timeframe === 'all' || allData.length <= windowSize) {
      return { visibleData: allData, startIndex: 0 }
    }
    const end = allData.length - currentOffset
    const start = Math.max(0, end - windowSize)
    return {
      visibleData: allData.slice(start, end),
      startIndex: start,
    }
  }, [allData, timeframe, windowSize, currentOffset])

  if (!allData.length) return null

  const canGoBack = currentOffset < maxOffset
  const canGoForward = currentOffset > 0

  const handlePrev = () => {
    const step = Math.max(1, Math.floor(windowSize / 2))
    setOffset((prev) => Math.min(maxOffset, prev + step))
  }

  const handleNext = () => {
    const step = Math.max(1, Math.floor(windowSize / 2))
    setOffset((prev) => Math.max(0, prev - step))
  }

  const rangeLabel = visibleData.length > 0
    ? `${visibleData[0].fullDay} — ${visibleData[visibleData.length - 1].fullDay}`
    : ''

  return (
    <div className="daily-chart-container">
      {/* Sleek Navigation Bar */}
      <div className="chart-nav-bar">
        <div className="chart-range-badge">
          <span className="range-badge-dot" />
          <span className="range-badge-text">{rangeLabel}</span>
          <span className="range-badge-sub">{visibleData.length}D</span>
        </div>

        <div className="chart-nav-right">
          {timeframe !== 'all' && allData.length > windowSize && (
            <div className="chart-pager">
              <button
                type="button"
                className="chart-pager-btn"
                disabled={!canGoBack}
                onClick={handlePrev}
                title="View earlier dates"
                aria-label="View earlier dates"
              >
                <ChevronLeft size={13} />
              </button>
              <button
                type="button"
                className="chart-pager-btn"
                disabled={!canGoForward}
                onClick={handleNext}
                title="View more recent dates"
                aria-label="View more recent dates"
              >
                <ChevronRight size={13} />
              </button>
            </div>
          )}

          {availablePresets.length > 1 && (
            <div className="chart-preset-group" role="group" aria-label="Timeframe presets">
              {availablePresets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`chart-preset-btn ${timeframe === preset ? 'active' : ''}`}
                  onClick={() => {
                    setTimeframe(preset)
                    setOffset(0)
                  }}
                >
                  {preset.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bar Chart */}
      <div style={{ width: '100%', height: 165 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={visibleData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#29302c" strokeDasharray="2 5" />
            <XAxis
              dataKey="dayKey"
              stroke="#747b73"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fontFamily: 'DM Mono' }}
            />
            <YAxis
              orientation="right"
              stroke="#747b73"
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(val) => Number(val).toFixed(4)}
              tick={{ fontSize: 11, fontFamily: 'DM Mono' }}
            />
            <Tooltip content={<DailyTooltip fiat={fiat} fiatPref={fiatPref} />} />
            <Bar dataKey="earned" fill="#b7ff5b" radius={[3, 3, 0, 0]} maxBarSize={32} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Ambient Timeline Scrubber Bar */}
      {allData.length > visibleData.length && (
        <div className="chart-ambient-track" title={`Showing days ${startIndex + 1}–${startIndex + visibleData.length} of ${allData.length}`}>
          <div
            className="chart-ambient-thumb"
            style={{
              left: `${(startIndex / allData.length) * 100}%`,
              width: `${Math.max(6, (visibleData.length / allData.length) * 100)}%`,
            }}
          />
        </div>
      )}
    </div>
  )
}
