import { useEffect, useState } from 'react';
import { Check, History } from 'lucide-react';
import { apiJson } from '../lib/api';
import { monitoringAssessment, partitionMonitoringRecommendations, type MonitoringSnapshot } from '../lib/monitoringRecommendations';
import { parameters, parameterLabels, units, recommendationCopy, lowOxygenGuidance, lldaAdvisoryUrl, type Recommendation } from '../lib/recommendations';
import { SensorActionCard, sensorActionName } from './SensorActionCard';

export type WaterContext = { recommendations: Recommendation[]; status: string; reference: string; fishpenName: string | null; deviceAssigned: boolean };
type HistoryRow = { id: number; fishpenName: string | null; deviceId: number | null; recordedAt: string; acknowledgedAt: string | null; payload: Recommendation & { reference: string } };
const colors = { critical: 'border-red-200 bg-red-50 text-red-900', warning: 'border-amber-200 bg-amber-50 text-amber-950', safe: 'border-emerald-200 bg-emerald-50 text-emerald-950', missing: 'border-slate-200 bg-slate-50 text-slate-700', stale: 'border-slate-200 bg-slate-50 text-slate-700', unavailable: 'border-slate-200 bg-slate-50 text-slate-700', unverified: 'border-slate-200 bg-slate-50 text-slate-700' };
export function RecommendationDetails({ item, reference, lang }: { item: Recommendation; reference: string; lang: 'en' | 'tl' }) {
  const copy = recommendationCopy(item, lang === 'tl');
  const oxygen = lowOxygenGuidance(item, lang === 'tl');
  const priority = lang === 'tl' ? ({ NORMAL: 'NORMAL', WATCH: 'BANTAYAN', 'ACTION NEEDED': 'KAILANGANG KUMILOS', URGENT: 'AGARAN' })[item.priority] : item.priority;
  const source = item.source === 'manual' ? (lang === 'tl' ? 'Manu-manong sukat' : 'Manual measurement') : item.source === 'sensor' ? (lang === 'tl' ? 'Sukat ng sensor' : 'Sensor measurement') : null;
  return <article className={`rounded-lg border p-3 ${colors[item.state]}`}>
    <div className="flex flex-wrap items-start justify-between gap-2"><strong className="text-sm">{parameterLabels[item.parameter]}</strong><span className="text-xs font-bold">{priority}</span></div>
    <p className="mt-1 text-base font-bold">{item.value === null ? '--' : item.value} {item.value === null ? '' : units[item.parameter]} <span className="text-xs font-semibold">{copy.label}</span></p>
    {source && <p className="mt-1 text-sm">{source}{item.recordedAt ? ` · ${new Date(item.recordedAt).toLocaleString(lang === 'tl' ? 'fil-PH' : 'en-PH', { timeZone: 'Asia/Manila' })} PHT` : ''}</p>}
    <dl className="mt-3 space-y-2 text-sm leading-relaxed">
      <div><dt className="font-semibold">{lang === 'tl' ? 'Natukoy na kondisyon' : 'Detected Condition'}</dt><dd>{oxygen ? (lang === 'tl' ? `Mababang nasukat na DO: ${item.value} mg/L. Hindi pa nakumpirma ang kilos ng isda.` : `Measured low DO: ${item.value} mg/L. Fish behavior is not confirmed.`) : copy.why}</dd></div>
      <div><dt className="font-semibold">{lang === 'tl' ? 'Kalubhaan' : 'Severity'}</dt><dd>{copy.label} · {lang === 'tl' ? 'ayon sa kasalukuyang patakaran ng app' : 'per current application rule'}</dd></div>
      <div><dt className="font-semibold">{lang === 'tl' ? 'Agarang hakbang' : 'Immediate Action'}</dt><dd>{oxygen?.immediate ?? copy.action}</dd></div>
      <div><dt className="font-semibold">{lang === 'tl' ? 'Patuloy na pagbabantay' : 'Monitoring Action'}</dt><dd>{oxygen?.monitoring ?? copy.followup}</dd></div>
      <div><dt className="font-semibold">{lang === 'tl' ? 'Kung may emerhensiya' : 'Conditional Emergency Action'}</dt><dd>{oxygen?.emergency ?? (lang === 'tl' ? 'Kung may nakitang pagkabalisa ng isda o hindi pangkaraniwang kondisyon, kumonsulta sa lokal na fisheries officer. Walang awtomatikong aeration o pag-ani.' : 'If fish distress or unusual conditions are observed, consult a local fisheries officer. No automatic aeration or harvest is triggered.')}</dd></div>
      <div><dt className="font-semibold">{lang === 'tl' ? 'Opisyal na sanggunian' : 'Scientific or Official Reference'}</dt><dd>{oxygen ? <><a className="underline" href={lldaAdvisoryUrl} target="_blank" rel="noreferrer">LLDA algal bloom and fish kill advisory</a>. {lang === 'tl' ? 'Hindi nagbibigay ang abiso ng numerong DO threshold; galing sa app ang severity.' : 'The advisory does not set a numerical DO threshold; severity comes from the application rule.'}</> : (lang === 'tl' ? 'Saklaw ng app; walang beripikadong opisyal na sanggunian para sa payong ito.' : 'Application range; no verified official citation for this action.')}</dd></div>
    </dl>
    <details className="mt-2 text-sm"><summary className="cursor-pointer py-1 font-semibold">{lang === 'tl' ? 'Bakit ito ipinapakita?' : 'Why am I seeing this?'}</summary>
      <p className="mt-2">{copy.why}</p><p>{reference}: {item.range.join(' - ')} {units[item.parameter]}</p>
      <p className="mt-1">{copy.followup}</p><p className="mt-1 text-xs">{lang === 'tl' ? 'Patakaran' : 'Rule'}: {item.rule}</p>
    </details>
  </article>;
}
export function RecommendedActions({ lang, refreshKey, snapshot, now }: { lang: 'en' | 'tl'; refreshKey?: string; snapshot: MonitoringSnapshot | null; now: number }) {
  const [context, setContext] = useState<WaterContext | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyError, setHistoryError] = useState('');
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
      if (!cancelled) { setHistory(r.data?.history || []); setHistoryError(r.error || ''); }
    });
    return () => { cancelled = true; };
  }, [open, filters]);
  const tl = lang === 'tl';
  const assessed = monitoringAssessment(snapshot, now);
  const alerts = assessed.filter(item => item.state === 'critical' || item.state === 'warning');
  const normal = assessed.filter(item => item.state === 'safe');
  const unavailable = assessed.filter(item => !['safe', 'warning', 'critical'].includes(item.state));
  const { manual, other } = partitionMonitoringRecommendations(context?.recommendations ?? [], assessed.length ? snapshot?.sampledAt ?? null : null);
  const list = (items: Recommendation[]) => <div className="space-y-2">{items.map(item => <RecommendationDetails key={item.parameter} item={item} reference={context?.reference ?? ''} lang={lang} />)}</div>;
  return <section className="card p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-bold">{tl ? 'Mga Hakbang mula sa Sensor' : 'Sensor Recommendations'}</h2><button className="soft-button flex items-center gap-2" onClick={() => setOpen(!open)} aria-expanded={open}><History size={16}/>{tl ? 'Kasaysayan ng payo' : 'Recommendation history'}</button></div>
    {error && <p role="status" className="mt-3 text-sm text-red-700">{lang === 'tl' ? 'Hindi makuha ang mga tala. Subukang muli.' : error}</p>}
    <div className="mt-3 space-y-3">
      {(alerts.length > 0 || normal.length > 0) ? <p className="text-sm text-slate-600">{tl ? 'Batay lamang sa kasalukuyang sukat ng sensor. Mano-manong ginagawa ng operator ang mga hakbang.' : 'Based only on the current sensor snapshot. All actions are carried out by the operator.'}</p> : <p className="text-sm text-slate-600">{tl ? 'Walang live na rekomendasyon mula sa sensor.' : 'No live sensor recommendation is available.'}</p>}
      {alerts.map(item => <SensorActionCard key={item.parameter} item={item} lang={lang} />)}
      {normal.length > 0 && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
        <h3 className="font-semibold">{tl ? 'Mga sukat na pasok sa saklaw ng gabay' : 'Readings within the guidance range'}</h3>
        <p>{normal.map(item => sensorActionName(item.parameter, lang)).join(', ')}. {tl ? 'Ipagpatuloy ang regular na pagmamasid at pagsusukat. Hindi nito kinukumpirma ang kabuuang kaligtasan ng tubig.' : 'Continue routine checks. This does not confirm overall water safety.'}</p>
      </div>}
      {unavailable.length > 0 && <ul className="text-sm text-slate-600">
        {unavailable.map(item => <li key={item.parameter}>{sensorActionName(item.parameter, lang)}: {item.parameter === 'turbidity' && item.value === null
          ? (tl ? 'Walang calibrated na sukat' : 'No calibrated reading')
          : item.rule === 'invalid-physical-value-v1' ? (tl ? 'Hindi wastong sukat' : 'Invalid reading') : recommendationCopy(item, tl).label}</li>)}
      </ul>}
      {other.length > 0 && <details className="refine-disclosure"><summary>{tl ? 'Ibang kalagayan ng sensor (hindi live)' : 'Other sensor conditions (not live)'}</summary>{list(other)}</details>}
      {manual.length > 0 && <details className="refine-disclosure"><summary>{tl ? 'Nakaraang manu-manong pagsusuri' : 'Previous manual assessment'}</summary><p className="mb-3 text-sm text-slate-600">{tl ? 'Batay sa naitalang manu-manong sukat, hindi sa live na sensor.' : 'Based on a saved manual test, not the live sensor.'}</p>{list(manual)}</details>}
    </div>
    {open && <div className="mt-5 border-t pt-4"><h3 className="font-bold">{lang === 'tl' ? 'Huling 100 rekomendasyon' : 'Latest 100 recommendations'}</h3>
      <p className="mt-2 text-sm text-slate-600">{lang === 'tl' ? 'Bawat tala ay batay sa isang naisumiteng sukat. Hindi nito pinagsasama ang ibang sukat sa kasalukuyang pagsusuri.' : 'Each entry reflects one submitted reading, not the combined measurements in the current assessment.'}</p>
      <div className="my-3 grid gap-2 sm:grid-cols-2">
        <label className="text-sm">{lang === 'tl' ? 'Petsa' : 'Date'}<input type="date" className="block w-full rounded-md border p-2" value={filters.date} onChange={e => setFilters({ ...filters, date: e.target.value })}/></label>
        <label className="text-sm">{lang === 'tl' ? 'Parameter' : 'Parameter'}<select className="block w-full rounded-md border p-2" value={filters.parameter} onChange={e => setFilters({ ...filters, parameter: e.target.value })}><option value="">{lang === 'tl' ? 'Lahat' : 'All'}</option>{parameters.map(p => <option key={p} value={p}>{parameterLabels[p]}</option>)}</select></label>
        <label className="text-sm">{lang === 'tl' ? 'Kalagayan' : 'Status'}<select className="block w-full rounded-md border p-2" value={filters.severity} onChange={e => setFilters({ ...filters, severity: e.target.value })}><option value="">{lang === 'tl' ? 'Lahat' : 'All'}</option>{Object.keys(colors).map(state => <option key={state} value={state}>{recommendationCopy({ state, parameter: 'ph' } as Recommendation, lang === 'tl').label}</option>)}</select></label>
        <label className="text-sm">Fishpen<input className="block w-full rounded-md border p-2" value={filters.fishpen} onChange={e => setFilters({ ...filters, fishpen: e.target.value })}/></label>
      </div>
      {historyError && <p role="status" className="text-sm text-red-700">{tl ? 'Hindi makuha o ma-update ang kasaysayan. Subukang muli.' : historyError}</p>}
      {!historyError && !history.length && <p className="text-sm text-slate-600">{lang === 'tl' ? 'Walang tumugmang tala.' : 'No matching records.'}</p>}
      <div className="max-h-[480px] space-y-3 overflow-y-auto">{history.map(row => <div key={row.id} className="border-b pb-3"><p className="mb-1 text-xs text-slate-600">{row.fishpenName || (lang === 'tl' ? 'Walang fishpen' : 'Unassigned fishpen')} · {new Date(row.recordedAt).toLocaleString()} {row.deviceId ? `· Device #${row.deviceId}` : ''}</p><RecommendationDetails item={row.payload} reference={row.payload.reference} lang={lang}/><button className="soft-button mt-2 flex items-center gap-2" disabled={!!row.acknowledgedAt || busy !== null} onClick={async () => { setBusy(row.id); const r = await apiJson(`/api/recommendations/${row.id}/acknowledge`, { method: 'POST' }); setHistoryError(r.error || ''); if (!r.error) setHistory(items => items.map(i => i.id === row.id ? { ...i, acknowledgedAt: new Date().toISOString() } : i)); setBusy(null); }}><Check size={16}/>{row.acknowledgedAt ? (lang === 'tl' ? 'Nabasa na' : 'Acknowledged') : (lang === 'tl' ? 'Markahang nabasa' : 'Acknowledge')}</button></div>)}</div>
    </div>}
  </section>;
}
