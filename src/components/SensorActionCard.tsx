import { useId } from 'react';
import { ChevronDown } from 'lucide-react';
import type { MonitoringParameter } from '../lib/monitoringRecommendations';
import { recommendationCopy, units, type Recommendation } from '../lib/recommendations';
import { sensorActionGuidance } from '../lib/sensorActionGuidance';
import { classCGuidelines, classCUrl } from '../lib/waterGuidelines';

const names = {
  ph: ['pH', 'pH'],
  temperature: ['Water Temperature', 'Temperatura ng Tubig'],
  dissolvedOxygen: ['Dissolved Oxygen (DO)', 'Natunaw na Oxygen (DO)'],
  turbidity: ['Turbidity', 'Labo ng Tubig']
};

export function sensorActionName(parameter: MonitoringParameter, lang: 'en' | 'tl') {
  return names[parameter][lang === 'tl' ? 1 : 0];
}

export function SensorActionCard({ item, lang, layout }: {
  item: Recommendation & { parameter: MonitoringParameter };
  lang: 'en' | 'tl';
  layout?: 'manual-panel';
}) {
  const id = useId();
  const tl = lang === 'tl';
  const copy = sensorActionGuidance(item, lang);
  if (!copy) return null;
  const status = recommendationCopy(item, tl).label;
  const unit = item.parameter === 'temperature' ? '\u00b0C' : units[item.parameter];
  const guideline = classCGuidelines[item.parameter];
  const manual = item.source === 'manual';
  const range = manual && item.parameter === 'dissolvedOxygen' ? `≥ ${item.range[0]}` :
    manual && item.parameter === 'turbidity' ? `≤ ${item.range[1]}` : item.range.join(' – ');
  const sections = [
    [tl ? 'Natukoy na Kondisyon' : 'Detected Condition', copy.condition],
    [tl ? '1. Suriin Muna' : '1. Check First', copy.check],
    [tl ? '2. Inirerekomendang Hakbang' : '2. Recommended Action', copy.action],
    [tl ? '3. Kailan Hihingi ng Tulong' : '3. When to Escalate', copy.escalate]
  ];
  const measurement = `${item.value}${unit ? ` ${unit}` : ''}`;
  const severity = <span className={`rounded-md px-2 py-1 text-xs font-bold ${item.state === 'critical' ? 'bg-red-100 text-red-900' : 'bg-amber-100 text-amber-950'}`}>{status}</span>;
  const guidance = sections.map(([label, value]) => <div key={label}>
    <dt className="font-semibold text-slate-950">{layout === 'manual-panel' ? label.replace(/^\d\. /, '') : label}</dt>
    <dd>{value}</dd>
  </div>);
  const explanation = <div className="space-y-1 text-sm leading-relaxed text-slate-700">
        <p>{manual ? (tl ? 'Pasok na saklaw sa Manual Test' : 'Manual Test in-range values') : (tl ? 'Saklaw na ginagamit ng gabay ng app' : 'Application guidance range')}: {range}{unit ? ` ${unit}` : ''}. {recommendationCopy(item, tl).why}</p>
        <p>{tl ? 'Ang patakaran ng app ay hiwalay sa saklaw ng bawat species at sa gabay pangkapaligiran ng DENR.' : 'Application rules are separate from species suitability ranges and DENR environmental guidelines.'}</p>
        {item.parameter === 'turbidity' && <p>{tl ? 'Hindi magkapareho ang turbidity (NTU) at TSS (mg/L). Walang opisyal na limitasyon sa NTU na ginagamit dito.' : 'Turbidity (NTU) and TSS (mg/L) are not interchangeable. No official NTU limit is used here.'}</p>}
  </div>;
  const references = <div className="text-sm">
      <ul className="mt-1 space-y-1">
        {copy.references.map(source => <li key={source.href}><a className="break-words text-teal-800 underline underline-offset-2" href={source.href} target="_blank" rel="noreferrer">{source.label}</a></li>)}
        {guideline && <li><a className="break-words text-teal-800 underline underline-offset-2" href={classCUrl} target="_blank" rel="noreferrer">{tl ? 'DENR Class C: gabay pangkapaligiran' : 'DENR Class C: environmental guidelines'}</a></li>}
      </ul>
      {item.parameter === 'dissolvedOxygen' && item.value !== null && item.value < item.range[0] &&
        <p className="mt-2 text-xs leading-relaxed text-slate-600">{tl ? 'Walang numerong DO limit sa abiso ng LLDA. Ang agarang hakbang para sa maaasahang Critical na sukat ay patakaran ng app.' : 'The LLDA advisory does not set a numerical DO limit. Acting promptly on a reliable Critical reading is application guidance.'}</p>}
  </div>;
  if (layout === 'manual-panel') return <article aria-labelledby={id} className="manual-guidance">
    <div className="manual-guidance-main">
      <header className="manual-guidance-reading">
        <h3 id={id} className="font-semibold">{sensorActionName(item.parameter, lang)}</h3>
        <strong className="manual-guidance-value">{measurement}</strong>
        <span className="manual-severity" data-severity={item.state}>{status}</span>
      </header>
      <dl className="manual-guidance-steps text-sm text-slate-700">{guidance}</dl>
    </div>
    <div className="manual-guidance-footer">
      <details>
        <summary><ChevronDown size={16} aria-hidden="true" />{tl ? 'Bakit mahalaga ito?' : 'Why does this matter?'}</summary>
        {explanation}
      </details>
      <details>
        <summary><ChevronDown size={16} aria-hidden="true" />{tl ? 'Mga sanggunian' : 'References'} ({copy.references.length + Number(Boolean(guideline))})</summary>
        {references}
      </details>
    </div>
  </article>;
  return <article aria-labelledby={id} className="min-w-0 rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id={id} className="text-base font-bold text-slate-950">{sensorActionName(item.parameter, lang)}</h3>
      {severity}
    </div>
    <p className="mt-1 text-sm text-slate-700">{tl ? 'Sukat' : 'Reading'}: <strong>{measurement}</strong></p>
    {!manual && copy.dashboardStatus !== item.state && <p className="mt-2 rounded-md bg-slate-100 px-2 py-1.5 text-sm text-slate-700">
      {tl ? 'Kalagayan sa Monitoring' : 'Monitoring status'}: <strong>{recommendationCopy({ ...item, state: copy.dashboardStatus }, tl).label}</strong>. {tl ? 'Magkaiba ang kasalukuyang patakaran ng Monitoring at ng gabay.' : 'Monitoring and this guidance use different existing rules.'}
    </p>}
    <dl className="mt-3 space-y-2 text-sm leading-relaxed text-slate-700">{guidance}</dl>
    <details className="refine-disclosure mt-3">
      <summary>{tl ? 'Bakit ito ipinapakita?' : 'Why am I seeing this?'}</summary>
      {explanation}
    </details>
    <div className="mt-3 border-t border-slate-200 pt-3 text-sm">
      <p className="font-semibold text-slate-950">{tl ? 'Siyentipiko / Opisyal na Sanggunian' : 'Scientific / Official Reference'}</p>
      {references}
    </div>
  </article>;
}
