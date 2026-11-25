import { useId, useState } from 'react';
import { Calculator } from 'lucide-react';
import { classifyTurbidity, turbidityAlertCopy, turbidityStatusLabel, type TurbidityAlertRule } from '../lib/turbidityAlert';
import { estimateTurbidity, turbidityReferenceRange, turbidityValidityLabel, turbidityVoltageRange } from '../lib/turbidityEstimate';

export function TurbidityCalculator({ lang, rule }: { lang: 'en' | 'tl'; rule: TurbidityAlertRule }) {
  const [input, setInput] = useState('2.50');
  const id = useId();
  const tl = lang === 'tl';
  const result = estimateTurbidity(input === '' ? null : Number(input));
  const preview = classifyTurbidity(result.ntu, result.validity, rule, 'preview');
  const { min, max, step } = turbidityVoltageRange;
  return <details className="refine-disclosure col-span-full min-w-0">
    <summary className="font-semibold"><Calculator size={18} className="mr-2 inline" aria-hidden="true" />
      {tl ? 'Voltage-to-NTU na kalkulador' : 'Voltage-to-NTU calculator'}
    </summary>
    <div className="grid gap-5 p-4 sm:grid-cols-2 sm:p-5">
      <div className="min-w-0 space-y-3">
        <label className="block text-sm font-semibold" htmlFor={`${id}-voltage`}>{tl ? 'Boltahe sa GPIO34 (V)' : 'GPIO34 voltage (V)'}</label>
        <input id={`${id}-voltage`} type="number" inputMode="decimal" min={min} max={max} step={step}
          value={input} onChange={e => setInput(e.target.value)} className="block w-32 max-w-full rounded-md border border-slate-300 px-3 py-2" />
        <input type="range" aria-label={tl ? 'Piliin ang boltahe sa GPIO34' : 'GPIO34 voltage slider'}
          min={min} max={max} step={step} value={result.voltage ?? min} onChange={e => setInput(Number(e.target.value).toFixed(2))}
          className="block min-h-8 w-full accent-teal-700" />
        <div className="flex justify-between text-xs text-slate-600"><span>0.00 V</span><span>3.30 V</span></div>
        <p className="text-sm text-slate-600">{tl ? 'Direkta sa GPIO34 · walang voltage divider' : 'Direct GPIO34 input · no voltage divider'}</p>
      </div>
      <div className="min-w-0 space-y-2" role="status">
        <p className="text-sm font-semibold">{tl ? 'Tinatayang turbidity' : 'Estimated turbidity'}</p>
        <output className="block text-2xl font-bold tabular-nums">{result.ntu === null ? '—' : `${result.ntu.toFixed(2)} NTU`}</output>
        <p className="font-mono text-sm">131.875 − (43.75 × {result.voltage === null ? 'V' : result.voltage.toFixed(3)})</p>
        {result.validity === 'invalid' && <p className="text-sm text-amber-900">{result.voltage === null
          ? (tl ? 'Ang boltahe ay dapat 0.00–3.30 V.' : 'Voltage must be between 0.00 and 3.30 V.')
          : (tl ? 'Negatibo ang resulta ng formula.' : 'The formula returns a negative NTU.')}</p>}
        <dl className="space-y-1 text-sm">
          <div><dt className="inline font-semibold">{tl ? 'Saklaw ng reference' : 'Reference range'}: </dt><dd className="inline">{turbidityReferenceRange.min.toFixed(2)}–{turbidityReferenceRange.max.toFixed(2)} V</dd></div>
          <div><dt className="inline font-semibold">{tl ? 'Bisa ng sukat' : 'Measurement validity'}: </dt><dd className="inline">{turbidityValidityLabel(result.validity, tl)}</dd></div>
          <div><dt className="inline font-semibold">{tl ? 'Kalagayan ng tubig' : 'Water quality status'}: </dt><dd className="inline">{turbidityStatusLabel(null, tl)}</dd></div>
        </dl>
        {preview && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          <p className="font-semibold">{tl ? 'Paunang preview' : 'Provisional preview'}: {turbidityStatusLabel(preview, tl)}</p>
          <p>{turbidityAlertCopy[preview][lang]}</p>
          <p className="mt-1 text-xs">{tl ? 'Hinihintay ang pag-apruba. Hindi pamantayan ng DENR o LLDA.' : 'Pending approval. Not a DENR or LLDA standard.'}</p>
        </div>}
      </div>
    </div>
  </details>;
}
