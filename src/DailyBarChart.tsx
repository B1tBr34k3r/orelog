import { Bar, BarChart, Brush, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

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
  const data: DayItem[] = [...days]
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey))
    .map((d) => ({
      dayKey: d.dayKey.slice(5),
      fullDay: d.dayKey,
      earned: Number(d.earnedAtomic) / 1e12,
      finalized: d.finalized,
    }))

  if (!data.length) return null

  const showBrush = data.length > 7
  const defaultWindow = 14
  const startIndex = Math.max(0, data.length - defaultWindow)

  return (
    <div style={{ width: '100%', height: showBrush ? 198 : 160, marginBottom: '1.25rem' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: showBrush ? 4 : 0 }}>
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
          {showBrush && (
            <Brush
              key={`${data[0]?.fullDay}-${data[data.length - 1]?.fullDay}-${data.length}`}
              dataKey="dayKey"
              height={24}
              stroke="#434e3f"
              fill="#101410"
              startIndex={startIndex}
              endIndex={data.length - 1}
              travellerWidth={10}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
