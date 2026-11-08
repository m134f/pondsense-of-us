import { useEffect, useState } from 'react';
import { Check, History } from 'lucide-react';
import { apiJson } from '../lib/api';
import { parameters, parameterLabels, units, recommendationCopy, type Recommendation } from '../lib/recommendations';

export type WaterContext = { recommendations: Recommendation[]; status: string; reference: string; fishpenName: string | null; deviceAssigned: boolean };
type HistoryRow = { id: number; fishpenName: string | null; deviceId: number | null; recordedAt: string; acknowledgedAt: string | null; payload: Recommendation & { reference: string } };
const colors = { critical: 'border-red-200 bg-red-50 text-red-900', warning: 'border-amber-200 bg-amber-50 text-amber-950', safe: 'border-emerald-200 bg-emerald-50 text-emerald-950', missing: 'border-slate-200 bg-slate-50 text-slate-700', stale: 'border-slate-200 bg-slate-50 text-slate-700', unavailable: 'border-slate-200 bg-slate-50 text-slate-700', unverified: 'border-slate-200 bg-slate-50 text-slate-700' };
export function RecommendationDetails({ item, reference, lang }: { item: Recommendation; reference: string; lang: 'en' | 'tl' }) {
  const copy = recommendationCopy(item, lang === 'tl');
  const priority = lang === 'tl' ? ({ NORMAL: 'NORMAL', WATCH: 'BANTAYAN', 'ACTION NEEDED': 'KAILANGANG KUMILOS', URGENT: 'AGARAN' })[item.priority] : item.priority;
  return <article className={`rounded-lg border p-3 ${colors[item.state]}`}>
    <div className="flex flex-wrap items-start justify-between gap-2"><strong className="text-sm">{parameterLabels[item.parameter]}</strong><span className="text-xs font-bold">{priority}</span></div>
    <p className="mt-1 text-base font-bold">{item.value === null ? '--' : item.value} {item.value === null ? '' : units[item.parameter]} <span className="text-xs font-semibold">{copy.label}</span></p>
    <p className="mt-2 text-sm leading-relaxed">{copy.action}</p>
    <details className="mt-2 text-sm"><summary className="cursor-pointer py-1 font-semibold">{lang === 'tl' ? 'Bakit ito ipinapakita?' : 'Why am I seeing this?'}</summary>
      <p className="mt-2">{copy.why}</p><p>{reference}: {item.range.join(' - ')} {units[item.parameter]}</p>
      <p>{item.source === 'manual' ? (lang === 'tl' ? 'Manu-manong sukat' : 'Manual measurement') : item.source === 'sensor' ? 'Sensor' : '--'} · {item.recordedAt ? new Date(item.recordedAt).toLocaleString(lang === 'tl' ? 'fil-PH' : 'en-PH') : '--'}</p>
      <p className="mt-1">{copy.followup}</p><p className="mt-1 text-xs">{lang === 'tl' ? 'Patakaran' : 'Rule'}: {item.rule}</p>
    </details>
  </article>;
}
export function RecommendedActions({ lang, refreshKey }: { lang: 'en' | 'tl'; refreshKey?: string }) {
  const [context, setContext] = useState<WaterContext | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState({ date: '', parameter: '', severity: '', fishpen: '' });
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const result = await apiJson<WaterContext>('/api/recommendations');
      if (cancelled) return;
      if (result.data) { setContext(result.data); setError(''); }
      else { setContext(null); setError(result.status === 401 ? '' : result.error || ''); }
    };
    void refresh(); const timer = setInterval(refresh, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [refreshKey]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void apiJson<{ history: HistoryRow[] }>(`/api/recommendations/history?${new URLSearchParams(filters)}`).then(r => {
      if (!cancelled) { setHistory(r.data?.history || []); if (r.error) setError(r.error); }
    });
    return () => { cancelled = true; };
  }, [open, filters]);
  if (!context && !error) return null;
  return <section className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-bold">{lang === 'tl' ? 'Mga Rekomendadong Hakbang' : 'Recommended Actions'}</h2><button className="soft-button flex items-center gap-2" onClick={() => setOpen(!open)} aria-expanded={open}><History size={16}/>{lang === 'tl' ? 'Kasaysayan' : 'History'}</button></div>
    {error && <p role="status" className="mt-3 text-sm text-red-700">{lang === 'tl' ? 'Hindi makuha ang mga tala. Subukang muli.' : error}</p>}
    {context && <><p className="my-3 text-sm text-slate-600">{lang === 'tl' ? 'Batay sa available na sukat. Ikaw ang magpapasya.' : 'Based on available measurements. You make the final decision.'}</p>
      {context.recommendations.some(item => ['missing', 'unavailable', 'stale', 'unverified'].includes(item.state)) && <p className="mb-3 text-sm font-semibold text-slate-700">{lang === 'tl' ? 'Kailangan ng karagdagang napapanahon at beripikadong sukat para sa kumpletong pagsusuri ng tubig.' : 'Complete water-quality assessment requires additional current, verified measurements.'}</p>}
      {context.recommendations[0] && <RecommendationDetails item={context.recommendations[0]} reference={context.reference} lang={lang}/>}
      <details className="mt-3"><summary className="cursor-pointer py-2 text-sm font-semibold text-teal-800">{lang === 'tl' ? 'Iba pang parameter' : 'Other parameters'} ({Math.max(0, context.recommendations.length - 1)})</summary><div className="mt-2 space-y-2">{context.recommendations.slice(1).map(item => <RecommendationDetails key={item.parameter} item={item} reference={context.reference} lang={lang}/>)}</div></details>
    </>}
    {open && <div className="mt-5 border-t pt-4"><h3 className="font-bold">{lang === 'tl' ? 'Huling 100 rekomendasyon' : 'Latest 100 recommendations'}</h3>
      <p className="mt-2 text-sm text-slate-600">{lang === 'tl' ? 'Bawat tala ay batay sa isang naisumiteng sukat. Hindi nito pinagsasama ang ibang sukat sa kasalukuyang pagsusuri.' : 'Each entry reflects one submitted reading, not the combined measurements in the current assessment.'}</p>
      <div className="my-3 grid gap-2 sm:grid-cols-2">
        <label className="text-sm">{lang === 'tl' ? 'Petsa' : 'Date'}<input type="date" className="block w-full rounded-md border p-2" value={filters.date} onChange={e => setFilters({ ...filters, date: e.target.value })}/></label>
        <label className="text-sm">{lang === 'tl' ? 'Parameter' : 'Parameter'}<select className="block w-full rounded-md border p-2" value={filters.parameter} onChange={e => setFilters({ ...filters, parameter: e.target.value })}><option value="">{lang === 'tl' ? 'Lahat' : 'All'}</option>{parameters.map(p => <option key={p} value={p}>{parameterLabels[p]}</option>)}</select></label>
        <label className="text-sm">{lang === 'tl' ? 'Kalagayan' : 'Status'}<select className="block w-full rounded-md border p-2" value={filters.severity} onChange={e => setFilters({ ...filters, severity: e.target.value })}><option value="">{lang === 'tl' ? 'Lahat' : 'All'}</option>{Object.keys(colors).map(state => <option key={state} value={state}>{recommendationCopy({ state, parameter: 'ph' } as Recommendation, lang === 'tl').label}</option>)}</select></label>
        <label className="text-sm">Fishpen<input className="block w-full rounded-md border p-2" value={filters.fishpen} onChange={e => setFilters({ ...filters, fishpen: e.target.value })}/></label>
      </div>
      {!history.length && <p className="text-sm text-slate-600">{lang === 'tl' ? 'Walang tumugmang tala.' : 'No matching records.'}</p>}
      <div className="max-h-[480px] space-y-3 overflow-y-auto">{history.map(row => <div key={row.id} className="border-b pb-3"><p className="mb-1 text-xs text-slate-600">{row.fishpenName || (lang === 'tl' ? 'Walang fishpen' : 'Unassigned fishpen')} · {new Date(row.recordedAt).toLocaleString()} {row.deviceId ? `· Device #${row.deviceId}` : ''}</p><RecommendationDetails item={row.payload} reference={row.payload.reference} lang={lang}/><button className="soft-button mt-2 flex items-center gap-2" disabled={!!row.acknowledgedAt || busy !== null} onClick={async () => { setBusy(row.id); const r = await apiJson(`/api/recommendations/${row.id}/acknowledge`, { method: 'POST' }); if (r.error) setError(r.error); else setHistory(items => items.map(i => i.id === row.id ? { ...i, acknowledgedAt: new Date().toISOString() } : i)); setBusy(null); }}><Check size={16}/>{row.acknowledgedAt ? (lang === 'tl' ? 'Nabasa na' : 'Acknowledged') : (lang === 'tl' ? 'Markahang nabasa' : 'Acknowledge')}</button></div>)}</div>
    </div>}
  </section>;
}
