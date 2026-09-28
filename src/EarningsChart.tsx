import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

type ChartPoint = { at: number; earned: number; [workerId: string]: number }
type Props = { data: ChartPoint[]; from: number; to: number; workers: string[] }

function ValueTooltip({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; payload: ChartPoint }> }) {
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tooltip">
      <span>{new Date(payload[0].payload.at).toLocaleString()}</span>
      {payload.map((entry) => (
        <strong key={entry.name}>
          {entry.name === 'earned' ? 'Combined' : entry.name}: {Number(entry.value).toFixed(8)} XMR
        </strong>
      ))}
    </div>
  )
}

export default function EarningsChart({ data, from, to, workers = [] }: Props) {
  const colors = ["#ff5b5b", "#5b84ff", "#ffb75b", "#d95bff", "#5bffcf", "#ff5bcf", "#5bff5b"]
  
  return <ResponsiveContainer width="100%" height="100%">
    <AreaChart data={data} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
      <defs>
        <linearGradient id="earnedFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b7ff5b" stopOpacity={0.24} /><stop offset="100%" stopColor="#b7ff5b" stopOpacity={0} /></linearGradient>
        {workers.map((w, i) => (
          <linearGradient key={w} id={`fill-${i}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={colors[i % colors.length]} stopOpacity={0.24} /><stop offset="100%" stopColor={colors[i % colors.length]} stopOpacity={0} /></linearGradient>
        ))}
      </defs>
      <CartesianGrid vertical={false} stroke="#29302c" strokeDasharray="2 5" />
      <XAxis dataKey="at" type="number" scale="time" domain={[from, to]} tickFormatter={(value) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value))} stroke="#747b73" tickLine={false} axisLine={false} minTickGap={44} tick={{ fontSize: 11, fontFamily: 'DM Mono' }} />
      <YAxis orientation="right" tickFormatter={(value) => Number(value).toFixed(5)} stroke="#747b73" tickLine={false} axisLine={false} width={68} tick={{ fontSize: 11, fontFamily: 'DM Mono' }} />
      <Tooltip content={<ValueTooltip />} />
      <Area type="monotone" name="earned" dataKey="earned" stroke="#b7ff5b" strokeWidth={2} fill="url(#earnedFill)" isAnimationActive={false} />
      {workers.map((w, i) => (
        <Area key={w} type="monotone" name={w} dataKey={w} stroke={colors[i % colors.length]} strokeWidth={2} fill={`url(#fill-${i})`} isAnimationActive={false} />
      ))}
    </AreaChart>
  </ResponsiveContainer>
}