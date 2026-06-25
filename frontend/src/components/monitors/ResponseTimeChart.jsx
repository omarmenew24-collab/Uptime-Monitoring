import { Card } from '@/components/ui/card';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Area,
  AreaChart,
} from 'recharts';

function formatData(rollups) {
  return rollups
    .filter((r) => r.avg_response_ms != null)
    .map((r) => ({
      date: new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      avg: r.avg_response_ms,
      min: r.min_response_ms,
      max: r.max_response_ms,
    }));
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs shadow-lg">
      <p className="text-zinc-400 mb-1">{label}</p>
      <p className="text-zinc-100 font-mono">Avg: {payload[0]?.value}ms</p>
      {payload[0]?.payload?.min != null && (
        <p className="text-zinc-500 font-mono">
          Min: {payload[0].payload.min}ms · Max: {payload[0].payload.max}ms
        </p>
      )}
    </div>
  );
}

export default function ResponseTimeChart({ rollups = [] }) {
  const data = formatData(rollups);

  return (
    <Card className="p-5">
      <span className="block text-sm font-semibold text-zinc-300 mb-4">
        Response Time (30 days)
      </span>
      {data.length === 0 ? (
        <div className="flex items-center justify-center h-48 text-sm text-zinc-600">
          No response time data yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={192}>
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
            <defs>
              <linearGradient id="responseGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: '#71717a' }}
              axisLine={{ stroke: '#3f3f46' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#71717a' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${v}ms`}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#3f3f46' }} />
            <Area
              type="monotone"
              dataKey="avg"
              stroke="#6366f1"
              strokeWidth={2}
              fill="url(#responseGradient)"
              dot={false}
              activeDot={{ r: 4, fill: '#6366f1', stroke: '#18181b', strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
