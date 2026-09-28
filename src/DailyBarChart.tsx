import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

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
}

function DailyTooltip({ active, payload }: { active?: boolean; payload?: Array<{ value: number; payload: DayItem }> }) {
  if (!active || !payload?.length) return null
  const item = payload[0].payload
  return (
    <div className="chart-tooltip">
      <span>{item.fullDay} {item.finalized ? '(Final)' : '(In progress)'}</span>
      <strong>{Number(item.earned).toFixed(8)} XMR</strong>
    </div>
  )
}

export default function DailyBarChart({ days }: Props) {
  const data: DayItem[] = days
    .slice(0, 14)
    .reverse()
    .map((d) => ({
      dayKey: d.dayKey.slice(5),
      fullDay: d.dayKey,
      earned: Number(d.earnedAtomic) / 1e12,
      finalized: d.finalized,
    }))

  if (!data.length) return null

  return (
    <div style={{ width: '100%', height: 160, marginBottom: '1.25rem' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
          <Tooltip content={<DailyTooltip />} />
          <Bar dataKey="earned" fill="#b7ff5b" radius={[3, 3, 0, 0]} maxBarSize={32} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
