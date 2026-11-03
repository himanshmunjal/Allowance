"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi, type ICellRendererParams, type IRowNode, type RowClickedEvent } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { LedgerView, ReconcileRow, Transaction } from "@shared/types";
import DecisionTimeline from "@/app/components/DecisionTimeline";
import { api, money, statusMeta } from "@/app/components/format";

// The Spending Explorer (D-066), on AG Grid: the whole ledger, a question box whose answer is a view
// of the grid, and a check of every payment against PayPal's own record.

ModuleRegistry.registerModules([AllCommunityModule]);

// The grid follows the app's own tokens, so it matches both light and dark without a second theme.
const theme = themeQuartz.withParams({
  backgroundColor: "var(--panel)",
  foregroundColor: "var(--ink)",
  headerBackgroundColor: "var(--panel-2)",
  borderColor: "var(--line)",
  accentColor: "var(--brand)",
  oddRowBackgroundColor: "var(--panel)",
  fontFamily: "inherit",
  fontSize: 13,
  wrapperBorderRadius: 16,
});

const EXAMPLES = ["What did the Grocery bot spend this month?", "Biggest purchases you blocked", "Anything still waiting on me?"];

function matchesView(t: Transaction, v: LedgerView): boolean {
  if (v.statuses.length && !v.statuses.includes(t.status)) return false;
  if (v.agents.length && !v.agents.includes(t.agentName ?? "")) return false;
  if (v.merchant && !t.merchantName.toLowerCase().includes(v.merchant.toLowerCase())) return false;
  if (v.category && t.category !== v.category) return false;
  if (v.minAmount !== null && t.amount < v.minAmount) return false;
  if (v.maxAmount !== null && t.amount > v.maxAmount) return false;
  if (v.sinceDays !== null && Date.now() - new Date(t.createdAt).getTime() > v.sinceDays * 86_400_000) return false;
  return true;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function ExplorerView() {
  const [rows, setRows] = useState<Transaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gridApi = useRef<GridApi<Transaction> | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [view, setView] = useState<LedgerView | null>(null);
  const [answeredBy, setAnsweredBy] = useState<string | null>(null);
  const viewRef = useRef<LedgerView | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<Map<string, ReconcileRow>>(new Map());
  const [verifySummary, setVerifySummary] = useState<string | null>(null);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [visibleRows, setVisibleRows] = useState<Transaction[]>([]);

  useEffect(() => {
    api<{ transactions: Transaction[] }>("/api/transactions/explorer")
      .then((r) => setRows(r.transactions))
      .catch((err) => setError(err.message));
  }, []);

  const syncVisible = useCallback(() => {
    const out: Transaction[] = [];
    gridApi.current?.forEachNodeAfterFilter((n) => n.data && out.push(n.data));
    setVisibleRows(out);
  }, []);

  function applyView(next: LedgerView | null) {
    viewRef.current = next;
    setView(next);
    const grid = gridApi.current;
    if (!grid) return;
    grid.onFilterChanged();
    grid.applyColumnState({
      state: [{ colId: next?.sortBy ?? "createdAt", sort: next?.sortDir ?? "desc" }],
      defaultState: { sort: null },
    });
  }

  async function ask(text: string) {
    const q = text.trim();
    if (q.length < 2 || asking) return;
    setQuestion(q);
    setAsking(true);
    setError(null);
    try {
      const r = await api<{ view: LedgerView; answeredBy: string }>("/api/transactions/ask", { method: "POST", body: JSON.stringify({ question: q }) });
      applyView(r.view);
      setAnsweredBy(r.answeredBy);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAsking(false);
    }
  }

  async function verify() {
    setVerifying(true);
    setError(null);
    try {
      const r = await api<{ rows: ReconcileRow[]; checked: number; mismatches: number }>("/api/transactions/reconcile", { method: "POST" });
      setVerified(new Map(r.rows.map((x) => [x.id, x])));
      setVerifySummary(
        r.checked === 0
          ? "No PayPal payments to check yet. Make one, then check again."
          : r.mismatches === 0
            ? `All ${r.checked} payment${r.checked === 1 ? "" : "s"} match PayPal's records.`
            : `${r.mismatches} of ${r.checked} payments don't match PayPal: see the PayPal column.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setVerifying(false);
    }
  }

  const columns = useMemo<ColDef<Transaction>[]>(
    () => [
      { field: "createdAt", headerName: "When", sort: "desc", minWidth: 130, flex: 1, filter: "agDateColumnFilter", valueGetter: (p) => (p.data ? new Date(p.data.createdAt) : null), valueFormatter: (p) => (p.value ? dateFormat.format(p.value as Date) : "") },
      { field: "title", headerName: "Item", minWidth: 200, flex: 2, tooltipField: "title", filter: "agTextColumnFilter", valueFormatter: (p) => (p.data && p.data.quantity > 1 ? `${p.data.quantity} × ${p.value}` : String(p.value ?? "")) },
      { field: "amount", headerName: "Amount", width: 105, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => (typeof p.value === "number" ? money(p.value) : ""), cellClass: "tabular-nums" },
      { field: "status", headerName: "Status", width: 150, filter: "agTextColumnFilter", cellRenderer: StatusCell },
      { field: "agentName", headerName: "Agent", minWidth: 130, flex: 1, filter: "agTextColumnFilter" },
      { field: "merchantName", headerName: "Merchant", minWidth: 140, flex: 1, filter: "agTextColumnFilter" },
      { field: "category", headerName: "Category", width: 115, filter: "agTextColumnFilter", valueFormatter: (p) => String(p.value ?? "–") },
      { colId: "paypal", headerName: "PayPal", minWidth: 150, flex: 1, sortable: false, filter: false, cellRenderer: PayPalCell, valueGetter: (p) => (p.data ? verified.get(p.data.id) : undefined), valueFormatter: (p) => (p.value as ReconcileRow | undefined)?.note ?? "" },
    ],
    [verified],
  );

  const totals = useMemo(() => {
    const sum = (status: Transaction["status"]) => visibleRows.filter((r) => r.status === status).reduce((n, r) => n + r.amount, 0);
    return {
      paid: sum("PAID"),
      waiting: sum("PENDING_APPROVAL"),
      stopped: sum("BLOCKED"),
      stoppedCount: visibleRows.filter((r) => r.status === "BLOCKED").length,
    };
  }, [visibleRows]);

  const hasSample = rows?.some((r) => r.source === "sample");

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <Link href="/" className="text-xs text-muted hover:text-ink">
        ← Dashboard
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Spending Explorer</h1>
          <p className="mt-1 text-sm text-muted">Everything your agents tried to buy, including what they weren&rsquo;t allowed to.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={verify} disabled={verifying} className="rounded-xl border border-line bg-panel px-3 py-2 text-xs font-medium hover:bg-panel-2 disabled:opacity-60">
            {verifying ? "Asking PayPal…" : "Verify with PayPal"}
          </button>
          <button
            onClick={() => gridApi.current?.exportDataAsCsv({ fileName: "allowance-ledger.csv" })}
            className="rounded-xl border border-line bg-panel px-3 py-2 text-xs font-medium hover:bg-panel-2"
          >
            Export CSV
          </button>
        </div>
      </div>

      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void ask(question);
        }}
        className="mt-4 flex gap-2"
      >
        <label className="sr-only" htmlFor="ask">
          Ask a question about your ledger
        </label>
        <input
          id="ask"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={300}
          placeholder="Ask your ledger anything…"
          className="min-w-0 flex-1 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-sm outline-none focus:border-brand"
        />
        <button type="submit" disabled={asking || question.trim().length < 2} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-ai px-4 py-2.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50">
          <span aria-hidden>✦</span> {asking ? "Thinking…" : "Ask"}
        </button>
      </form>

      <div className="mt-2 flex min-h-7 flex-wrap items-center gap-2 text-xs">
        {view ? (
          <>
            <span className="rounded-lg bg-ai-soft px-2.5 py-1 text-ai">{view.summary}</span>
            {answeredBy && <span className="text-muted">{answeredBy} chose this view without seeing your purchases</span>}
            <button
              onClick={() => {
                applyView(null);
                setQuestion("");
                setAnsweredBy(null);
              }}
              className="font-medium text-brand hover:underline"
            >
              Show everything
            </button>
          </>
        ) : (
          EXAMPLES.map((e) => (
            <button key={e} onClick={() => void ask(e)} className="rounded-lg border border-line bg-panel px-2.5 py-1 text-muted hover:text-ink">
              {e}
            </button>
          ))
        )}
      </div>

      {error && <p className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">{error}</p>}
      {verifySummary && (
        <p className="mt-2 rounded-lg bg-panel px-3 py-2 text-xs ring-1 ring-line" role="status">
          {verifySummary}
        </p>
      )}

      <dl className="mt-4 grid grid-cols-3 gap-3">
        <Tile label="Paid" value={money(totals.paid)} />
        <Tile label="Waiting on you" value={money(totals.waiting)} />
        <Tile label="Stopped before paying" value={money(totals.stopped)} note={`${totals.stoppedCount} purchase${totals.stoppedCount === 1 ? "" : "s"}`} />
      </dl>

      <div className="mt-3 h-[34rem]">
        <AgGridReact<Transaction>
          theme={theme}
          rowData={rows ?? undefined}
          loading={rows === null}
          columnDefs={columns}
          defaultColDef={{ sortable: true, resizable: true, filter: true, floatingFilter: false }}
          getRowId={(p) => p.data.id}
          pagination
          paginationPageSize={25}
          paginationPageSizeSelector={[25, 50, 100]}
          tooltipShowDelay={300}
          isExternalFilterPresent={() => viewRef.current !== null}
          doesExternalFilterPass={(node: IRowNode<Transaction>) => (node.data && viewRef.current ? matchesView(node.data, viewRef.current) : true)}
          onGridReady={(e) => {
            gridApi.current = e.api;
          }}
          onRowDataUpdated={syncVisible}
          onFilterChanged={syncVisible}
          onRowClicked={(e: RowClickedEvent<Transaction>) => setSelected(e.data ?? null)}
          overlayNoRowsTemplate="Nothing matches this view."
        />
      </div>
      {hasSample && <p className="mt-2 text-xs text-muted">Rows older than a week in this demo account are made-up sample history: no PayPal payment happened for those.</p>}

      {selected && (
        <div className="mt-4 rounded-xl border border-line bg-panel p-5">
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-sm font-semibold">
              {selected.title} · {money(selected.amount)}
            </h2>
            <button onClick={() => setSelected(null)} className="text-xs text-muted hover:text-ink">
              Close
            </button>
          </div>
          <div className="mt-3">
            <DecisionTimeline tx={selected} />
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">
        {value} {note && <span className="text-xs font-normal text-muted">{note}</span>}
      </dd>
    </div>
  );
}

function StatusCell({ value }: ICellRendererParams<Transaction, Transaction["status"]>) {
  if (!value) return null;
  const meta = statusMeta[value];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>{meta.label}</span>;
}

function PayPalCell({ value, data }: ICellRendererParams<Transaction, ReconcileRow | undefined>) {
  if (!value) return <span className="text-muted">{data?.paypalCaptureId ? "Not checked yet" : "–"}</span>;
  return (
    <span title={value.note} className={value.matches ? "text-ok" : "text-bad"}>
      {value.matches ? `✓ ${value.paypalStatus}` : `✕ ${value.note}`}
    </span>
  );
}
