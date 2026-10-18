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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDayLabel(dayKey: string): string {
  const parts = dayKey.split('-')
  if (parts.length >= 3) {
    const month = MONTH_NAMES[Number(parts[1]) - 1] || parts[1]
    const day = Number(parts[2])
    return `${day} ${month}`
  }
  if (parts.length === 2) {
    const month = MONTH_NAMES[Number(parts[0]) - 1] || parts[0]
    const day = Number(parts[1])
    return `${day} ${month}`
  }
  return dayKey
}

function formatFullDate(fullDay: string): string {
  const parts = fullDay.split('-')
  if (parts.length >= 3) {
    const month = MONTH_NAMES[Number(parts[1]) - 1] || parts[1]
    const day = Number(parts[2])
    const year = parts[0]
    return `${day} ${month} ${year}`
  }
  return fullDay
}

function CustomXAxisTick({ x = 0, y = 0, payload, visibleCount }: any) {
  if (!payload || typeof payload.value !== 'string') return null
  const label = formatDayLabel(payload.value)
  const isRotated = visibleCount > 6

  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={isRotated ? 10 : 13}
        textAnchor={isRotated ? 'end' : 'middle'}
        fill="#838d80"
        fontSize={10}
        fontFamily="DM Mono, monospace"
        transform={isRotated ? 'rotate(-35)' : undefined}
      >
        {label}
      </text>
    </g>
  )
}

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

  const formattedDate = formatFullDate(item.fullDay)

  return (
    <div className="chart-tooltip">
      <span>{formattedDate} {item.finalized ? '(Final)' : '(In progress)'}</span>
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
        dayKey: d.dayKey,
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

  const rangeLabel = useMemo(() => {
    if (!visibleData.length) return ''
    const first = visibleData[0].fullDay
    const last = visibleData[visibleData.length - 1].fullDay
    if (first === last) return formatDayLabel(first)
    return `${formatDayLabel(first)} — ${formatDayLabel(last)}`
  }, [visibleData])

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
      <div style={{ width: '100%', height: 185 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={visibleData} margin={{ top: 8, right: 8, left: 14, bottom: 4 }}>
            <CartesianGrid vertical={false} stroke="#29302c" strokeDasharray="2 5" />
            <XAxis
              dataKey="dayKey"
              stroke="#747b73"
              tickLine={false}
              axisLine={false}
              interval={visibleData.length > 20 ? 2 : visibleData.length > 14 ? 1 : 0}
              height={visibleData.length > 6 ? 38 : 24}
              tick={<CustomXAxisTick visibleCount={visibleData.length} />}
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
