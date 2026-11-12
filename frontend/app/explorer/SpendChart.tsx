"use client";

import { AgCharts } from "ag-charts-react";
import { AllCommunityModule, ModuleRegistry, type AgCartesianChartOptions } from "ag-charts-community";
import { useMemo, useSyncExternalStore } from "react";
import type { Transaction } from "@shared/types";

// Daily spend, on AG Charts. It plots exactly the rows the grid is showing, so a question like
// "what did the Grocery bot spend?" redraws the chart as well as the table.

ModuleRegistry.registerModules([AllCommunityModule]);

const DAYS = 14;
const dayLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const usd = (v: number) => "$" + v.toFixed(2);

// Canvas charts can't read CSS variables, so resolve the app's tokens to real colors, and redraw
// when the theme toggle flips them.
const TOKENS = ["--panel", "--ink", "--muted", "--line", "--ok", "--warn", "--bad"] as const;

function subscribe(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function readColors(): string {
  const style = getComputedStyle(document.documentElement);
  return TOKENS.map((t) => style.getPropertyValue(t).trim()).join("|");
}

export default function SpendChart({ rows }: { rows: Transaction[] }) {
  const colors = useSyncExternalStore(subscribe, readColors, () => "");

  const { data, total } = useMemo(() => {
    const today = new Date();
    const buckets = Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (DAYS - 1 - i));
      return { key: dayKey(d), day: dayLabel.format(d), paid: 0, waiting: 0, stopped: 0 };
    });
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    for (const r of rows) {
      const b = byKey.get(dayKey(new Date(r.createdAt)));
      if (!b) continue;
      if (r.status === "PAID") b.paid += r.amount;
      else if (r.status === "PENDING_APPROVAL") b.waiting += r.amount;
      else if (r.status === "BLOCKED") b.stopped += r.amount;
    }
    return { data: buckets, total: buckets.reduce((n, b) => n + b.paid + b.waiting + b.stopped, 0) };
  }, [rows]);

  const options = useMemo<AgCartesianChartOptions | null>(() => {
    const [panel, ink, muted, line, ok, warn, bad] = colors.split("|");
    if (!panel) return null;
    const series = (yKey: string, yName: string, fill: string) => ({
      type: "bar" as const,
      xKey: "day",
      yKey,
      yName,
      stacked: true,
      fill,
      stroke: panel,
      strokeWidth: 1,
      cornerRadius: 3,
      tooltip: {
        renderer: ({ datum }: { datum: Record<string, number | string> }) => ({
          title: String(datum.day),
          data: [{ label: yName, value: usd(Number(datum[yKey])) }],
        }),
      },
    });
    return {
      data,
      background: { fill: "transparent" },
      padding: { top: 8, right: 8, bottom: 4, left: 4 },
      legend: { position: "top", item: { label: { color: muted, fontSize: 12 }, marker: { shape: "circle", size: 8 } } },
      axes: {
        x: { type: "category", position: "bottom", line: { enabled: false }, tick: { enabled: false }, label: { color: muted, fontSize: 11, autoRotate: false }, gridLine: { enabled: false } },
        y: { type: "number", position: "left", label: { color: muted, fontSize: 11, formatter: ({ value }: { value: number }) => "$" + value }, gridLine: { style: [{ stroke: line, lineDash: [] }] }, line: { enabled: false }, tick: { enabled: false } },
      },
      series: [series("paid", "Paid", ok), series("waiting", "Waiting on you", warn), series("stopped", "Stopped before paying", bad)],
      // keeps tooltips readable on both themes
      theme: { baseTheme: "ag-default", params: { foregroundColor: ink, backgroundColor: panel } },
    };
  }, [colors, data]);

  return (
    <section className="mt-3 rounded-xl border border-line bg-panel p-4" aria-label="Daily spend, last 14 days">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Last 14 days</h2>
        <span className="text-xs text-muted">Follows whatever the table below is showing</span>
      </div>
      {total === 0 ? (
        <p className="grid h-40 place-items-center text-sm text-muted">Nothing in the last 14 days for this view.</p>
      ) : (
        <div className="mt-2 h-56">{options && <AgCharts options={options} style={{ height: "100%" }} />}</div>
      )}
    </section>
  );
}
