import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiJson } from '../lib/api';
import { parameters, parameterLabels } from '../lib/recommendations';
import { recentMortality } from '../lib/harvest';
import { RecommendationDetails, type WaterContext } from './RecommendedActions';

type Review = WaterContext & { observations: Array<{ id: number; date: string; category: string; notes: string }>; reminders: Array<{ day: number; targetDate: string; status: string }> };
const observations = { normal: ['Normal behavior', 'Normal na kilos'], reduced_feeding: ['Reduced feeding', 'Kaunting pagkain'], surface_gathering: ['Surface gathering', 'Pagtitipon sa ibabaw'], unusual_color: ['Unusual water color', 'Di-karaniwang kulay ng tubig'], unusual_odor: ['Unusual odor', 'Di-karaniwang amoy'], mortalities: ['Observed mortalities', 'May namatay na isda'], net_damage: ['Net damage', 'Sira ang lambat'], other: ['Other observation', 'Ibang obserbasyon'] };
export function HarvestReview({ batch, lang }: { batch: { id: number; actualHarvestDate: string | null; notes?: string; targetWeightG: number | null; samples: Array<{ id: number; sampledAt: string; sampleSize: number; averageWeightG: number; notes?: string }>; mortalities: Array<{ mortalityDate: string; deadCount: number }> }; lang: 'en' | 'tl' }) {
  const tl = lang === 'tl';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ date: today, category: 'normal', notes: '' });
  const [manual, setManual] = useState({ parameter: 'dissolvedOxygen', value: '' });
  const refresh = async () => { const r = await apiJson<Review>(`/api/harvests/${batch.id}/review`); if (r.data) setReview(r.data); else { setReview(null); setMessage(tl ? 'Hindi makuha ang tala. Subukang muli.' : r.error || ''); } };
  useEffect(() => { if (!open) return; void refresh(); const timer = setInterval(refresh, 10000); return () => clearInterval(timer); }, [open, batch.id, lang]);
  const save = async (kind: 'observations' | 'water') => {
    setBusy(true); setMessage('');
    const r = await apiJson<{ saved: boolean; historySaved?: boolean }>(`/api/harvests/${batch.id}/${kind}`, { method: 'POST', body: JSON.stringify(kind === 'observations' ? form : manual) });
    setBusy(false);
    setMessage(r.error ? (tl ? 'Hindi na-save. Suriin ang petsa at sukat, at subukang muli.' : r.error) : r.data?.historySaved === false
      ? (tl ? 'Nai-save ang sukat. Hindi magamit ang history ng payo ngayon; huwag uliting isumite.' : 'Measurement saved. Advice history is temporarily unavailable; do not resubmit.')
      : tl ? 'Nai-save ang tala.' : 'Record saved.');
    if (!r.error) { setForm({ date: today, category: 'normal', notes: '' }); setManual({ ...manual, value: '' }); void refresh(); }
  };
  const sampled = [...batch.samples].sort((a, b) => a.sampledAt.localeCompare(b.sampledAt) || a.id - b.id).map(s => ({ ...s, averageWeightG: Number(s.averageWeightG) }));
  const latest = sampled.at(-1);
  const timestamps = (review?.recommendations || []).flatMap(item => item.recordedAt && Number.isFinite(Date.parse(item.recordedAt)) ? [Date.parse(item.recordedAt)] : []);
  const lastUpdated = timestamps.length ? new Date(Math.max(...timestamps)).toLocaleString(tl ? 'fil-PH' : 'en-PH') : '--';
  const noCurrentWater = review?.recommendations.every(item => ['missing', 'unavailable', 'stale', 'unverified'].includes(item.state));
  return <details className="mt-4 border-t border-slate-200 pt-3" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer py-2 text-sm font-bold text-teal-800">{tl ? 'Suriin ang plano, tubig at obserbasyon' : 'Review plan, water and observations'}</summary>
    {open && <div className="mt-3 space-y-5 text-sm">
      <div className="grid gap-3 sm:grid-cols-3"><p>{tl ? 'Huling sample' : 'Latest sample'}<strong className="block">{latest ? `${latest.averageWeightG} g · ${latest.sampledAt}` : '--'}</strong></p><p>{tl ? 'Target timbang' : 'Target market weight'}<strong className="block">{batch.targetWeightG ? `${batch.targetWeightG} g` : '--'}</strong></p><p>{tl ? 'Namatay sa huling 7 araw' : 'Mortality in last 7 days'}<strong className="block">{recentMortality(batch.mortalities, today)}</strong></p></div>
      {batch.notes && <p className="break-words">{batch.notes}</p>}
      <p className="text-slate-600">{tl ? 'Ang target na petsa at timbang ay plano lamang. Suriin ang laki, kalusugan at kondisyon ng tubig. Ikaw ang magpapasya kung kailan aanihin.' : 'Target dates and weights are plans only. Inspect fish size, health and water conditions. You decide when to harvest.'}</p>
      {sampled.length ? <div><h3 className="mb-2 font-bold">{tl ? 'Mga naitalang timbang ng sample (g)' : 'Recorded sample weights (g)'}</h3><div className="h-52 w-full min-w-0"><ResponsiveContainer width="100%" height="100%"><LineChart data={sampled} margin={{ top: 10, right: 15, left: 0, bottom: 5 }}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="sampledAt" tick={{ fontSize: 11 }}/><YAxis width={45}/><Tooltip/><Line dataKey="averageWeightG" name={tl ? 'Karaniwang timbang (g)' : 'Average weight (g)'} stroke="#0d9488" strokeWidth={2} type="linear" isAnimationActive={false}/></LineChart></ResponsiveContainer></div>{sampled.map(s => <p key={s.id} className="py-1 text-xs text-slate-600">{s.sampledAt} · {s.sampleSize} {tl ? 'isda' : 'fish'} · {s.averageWeightG} g {s.notes ? `· ${s.notes}` : ''}</p>)}</div> : <p>{tl ? 'Wala pang sampling record.' : 'No sampling records yet.'}</p>}
      {review && <div><h3 className="mb-2 font-bold">{tl ? 'Tubig sa fishpen na ito' : 'Water in this fishpen'}</h3>
        <p className="mb-2 text-slate-600">{tl ? 'Huling sukat' : 'Latest measurement'}: {lastUpdated}</p>
        {noCurrentWater && <p className="mb-3 border-l-4 border-slate-400 bg-slate-50 p-3 text-slate-700">{tl ? 'Walang napapanahong beripikadong sukat ng tubig. Kumuha muna ng bagong sukat bago magpasya.' : 'Current verified water conditions are unavailable. Take new measurements before deciding.'}</p>}
        {!review.deviceAssigned && <p className="mb-3 text-slate-600">{tl ? 'Walang nakatalagang sensor sa batch. Magtalaga ng sariling device sa Edit batch o magtala ng aktuwal na sukat.' : 'No sensor is assigned to this batch. Select your device in Edit batch or record an actual measurement.'}</p>}
        {['warning', 'critical'].includes(review.status) && <p className="mb-3 border-l-4 border-amber-500 bg-amber-50 p-3 text-amber-950">{tl ? 'Suriin muna ang kalusugan ng isda at kondisyon ng tubig bago mag-ani. Hindi ito utos para sa emergency harvest.' : 'Inspect fish health and water conditions before harvesting. This is not an instruction for an emergency harvest.'}</p>}
        <div className="grid gap-2 lg:grid-cols-2">{review.recommendations.map(item => <RecommendationDetails key={item.parameter} item={item} reference={review.reference} lang={lang}/>)}</div>
      </div>}
      {!batch.actualHarvestDate && <>
        <form className="border-t pt-4" onSubmit={e => { e.preventDefault(); void save('water'); }}><h3 className="font-bold">{tl ? 'Aktuwal na manu-manong sukat ngayon' : 'Actual manual measurement taken now'}</h3><div className="mt-2 flex flex-wrap items-end gap-3"><label>{tl ? 'Parameter' : 'Parameter'}<select className="mt-1 block max-w-full rounded-md border p-2" value={manual.parameter} onChange={e => setManual({ ...manual, parameter: e.target.value })}>{parameters.map(p => <option key={p} value={p}>{parameterLabels[p]}</option>)}</select></label><label>{tl ? 'Sukat' : 'Value'}<input required type="number" step="any" className="mt-1 block w-28 rounded-md border p-2" value={manual.value} onChange={e => setManual({ ...manual, value: e.target.value })}/></label><button className="primary-button" disabled={busy}>{tl ? 'Itala ang sukat' : 'Save measurement'}</button></div></form>
        <form className="border-t pt-4" onSubmit={e => { e.preventDefault(); void save('observations'); }}><h3 className="font-bold">{tl ? 'Obserbasyon sa fishpen' : 'Fishpen observation'}</h3><div className="mt-2 grid gap-3 sm:grid-cols-2"><label>{tl ? 'Petsa' : 'Date'}<input required type="date" max={today} className="mt-1 block w-full rounded-md border p-2" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })}/></label><label>{tl ? 'Napansin' : 'Observed'}<select className="mt-1 block w-full rounded-md border p-2" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{Object.entries(observations).map(([key, labels]) => <option key={key} value={key}>{labels[tl ? 1 : 0]}</option>)}</select></label></div><label className="mt-3 block">{tl ? 'Puna (opsyonal)' : 'Notes (optional)'}<textarea maxLength={1000} className="mt-1 w-full rounded-md border p-2" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}/></label><button className="primary-button mt-2" disabled={busy}>{tl ? 'Itala ang obserbasyon' : 'Save observation'}</button></form>
      </>}
      {message && <p role="status" className="text-sm text-slate-700">{message}</p>}
      {!!review?.observations.length && <div><h3 className="font-bold">{tl ? 'Mga obserbasyon (hindi diagnosis)' : 'Observations (not diagnoses)'}</h3>{review.observations.map(o => <p key={o.id} className="border-b py-2">{o.date} · {observations[o.category as keyof typeof observations]?.[tl ? 1 : 0] || o.category} {o.notes ? `· ${o.notes}` : ''}</p>)}</div>}
      {!!review?.reminders.length && <details><summary className="cursor-pointer font-bold">{tl ? 'Mga SMS na paalala' : 'SMS reminders'}</summary>{review.reminders.map((r, index) => <p key={index} className="py-1">{String(r.targetDate).slice(0, 10)} · {r.day < 0 ? (tl ? 'Lampas na' : 'Overdue') : `${r.day} ${tl ? 'araw bago' : 'days before'}`} · {r.status === 'sent' ? (tl ? 'Tinanggap ng SMS provider' : 'Accepted by SMS provider') : (tl ? 'Hindi naipadala' : 'Not sent')}</p>)}</details>}
    </div>}
  </details>;
}
