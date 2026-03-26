import {
  LineChart, Line,
  BarChart, Bar,
  AreaChart, Area,
  PieChart, Pie, Cell,
  ResponsiveContainer,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { formatNumber } from "@copilot/shared";
import type { ChartType, QueryColumn } from "@copilot/shared";

interface ResultChartProps {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  chartType: ChartType;
}

const COLORS = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#f97316"];

export function ResultChart({ columns, rows, chartType }: ResultChartProps) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-gray-500">
        No data to display
      </div>
    );
  }

  // For single-number results, show a metric card
  if (chartType === "metric" || (columns.length === 1 && rows.length === 1)) {
    const value = rows[0]?.[columns[0]?.name ?? ""];
    return (
      <div className="flex items-center justify-center py-6">
        <div className="text-center">
          <p className="text-5xl font-bold text-gray-100 tabular-nums">
            {typeof value === "number" ? formatNumber(value) : String(value ?? "—")}
          </p>
          {columns[0] && (
            <p className="mt-2 text-sm text-gray-500">{columns[0].name}</p>
          )}
        </div>
      </div>
    );
  }

  const numericCols = columns.filter((c) => c.type === "number");
  const categoryCols = columns.filter((c) => c.type !== "number");
  const xKey = categoryCols[0]?.name ?? columns[0]?.name ?? "index";
  const yKeys = numericCols.map((c) => c.name);

  const chartData = rows.map((row) => {
    const entry: Record<string, unknown> = {};
    for (const col of columns) {
      entry[col.name] = row[col.name];
    }
    return entry;
  });

  const tooltipStyle = {
    backgroundColor: "#1f2937",
    border: "1px solid #374151",
    borderRadius: "8px",
    fontSize: "12px",
  };

  if (chartType === "pie") {
    const dataKey = yKeys[0] ?? "value";
    const nameKey = categoryCols[0]?.name ?? "name";
    return (
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie data={chartData} dataKey={dataKey} nameKey={nameKey} cx="50%" cy="50%" outerRadius={100} label>
            {chartData.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "bar") {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: "#6b7280" }} />
          <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} tickFormatter={formatNumber} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown) => formatNumber(Number(v))} />
          <Legend />
          {yKeys.map((key, i) => (
            <Bar key={key} dataKey={key} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "area") {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
          <defs>
            {yKeys.map((key, i) => (
              <linearGradient key={key} id={`gradient-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0.3} />
                <stop offset="95%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: "#6b7280" }} />
          <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} tickFormatter={formatNumber} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown) => formatNumber(Number(v))} />
          <Legend />
          {yKeys.map((key, i) => (
            <Area key={key} type="monotone" dataKey={key} stroke={COLORS[i % COLORS.length]} fill={`url(#gradient-${i})`} strokeWidth={2} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // Default: line chart
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
        <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: "#6b7280" }} />
        <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} tickFormatter={formatNumber} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown) => formatNumber(Number(v))} />
        <Legend />
        {yKeys.map((key, i) => (
          <Line key={key} type="monotone" dataKey={key} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
