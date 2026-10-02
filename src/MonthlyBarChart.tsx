import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export type MonthItem = {
  monthKey: string
  label: string
  fullMonth: string
  earned: number
  earnedAtomic: string
  daysCount: number
  sampleCount: number
  isCurrent: boolean
}

type Props = {
  months: MonthItem[]
  fiat?: { usd: number; inr: number } | null
  fiatPref?: 'both' | 'usd' | 'inr'
}

function MonthlyTooltip({
  active,
  payload,
  fiat,
  fiatPref,
}: {
  active?: boolean
  payload?: Array<{ value: number; payload: MonthItem }>
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
      <span>{item.fullMonth} {item.isCurrent ? '(Month to date)' : `(${item.daysCount} days recorded)`}</span>
      <strong>{item.earned.toFixed(6)} XMR{fiatStr}</strong>
    </div>
  )
}

export default function MonthlyBarChart({ months, fiat, fiatPref }: Props) {
  // Show last 12 months chronologically
  const data = [...months].slice(0, 12).reverse()

  if (!data.length) return null

  return (
    <div style={{ width: '100%', height: 165, marginBottom: '1.25rem' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#29302c" strokeDasharray="2 5" />
          <XAxis
            dataKey="label"
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
          <Tooltip content={<MonthlyTooltip fiat={fiat} fiatPref={fiatPref} />} />
          <Bar dataKey="earned" fill="#80a8ff" radius={[3, 3, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
