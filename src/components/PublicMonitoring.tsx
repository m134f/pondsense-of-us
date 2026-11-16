import { useEffect, useState } from 'react';
type Reading = { ph: number | null; temperature: number | null; turbidity: number | null; measuredAt: string; receivedAt: string };
export function PublicMonitoring({ lang }: { lang: 'en' | 'tl' }) {
  const [reading, setReading] = useState<Reading | null>(null);
  const [state, setState] = useState('loading');
  const [now, setNow] = useState(Date.now());
  const tl = lang === 'tl';
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>, failures = 0;
    let controller: AbortController;
    const poll = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('/api/public/monitoring', { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!disposed) { setReading(data.reading); setState('ready'); setNow(Date.now()); }
        failures = 0;
      } catch { failures++; if (!disposed) setState('error'); }
      finally { clearTimeout(timeout); if (!disposed) timer = setTimeout(poll, Math.min(30000, 5000 * 2 ** failures)); }
    };
    void poll();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { disposed = true; clearTimeout(timer); clearInterval(clock); controller?.abort(); };
  }, []);
  const age = reading ? now - Math.min(new Date(reading.measuredAt).getTime(), new Date(reading.receivedAt).getTime()) : Infinity;
  const status = state === 'error' ? (tl ? 'Hindi makakonekta' : 'Connection unavailable') : !reading ? '' : age < 0 || age > 120000 ? 'Offline' : age > 20000 ? (tl ? 'Lumang sukat' : 'Stale') : 'Live';
  return <section className="mt-5 border-y border-slate-200 py-5" aria-label="Public water monitoring">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-bold">{tl ? 'Pampublikong sukat ng tubig' : 'Public water readings'}</h2>{status && <span className={`rounded-md px-3 py-1 font-bold ${status === 'Live' ? 'bg-teal-100 text-teal-900' : 'bg-amber-100 text-amber-900'}`}>{status}</span>}</div>
    {!reading ? <p className="mt-3">{state === 'loading' ? (tl ? 'Kinukuha ang mga sukat...' : 'Loading readings...') : state === 'error' ? (tl ? 'Hindi makuha ang readings. Awtomatikong susubok muli.' : 'Unable to load readings. Retrying automatically.') : (tl ? 'Wala pang nailalathalang sukat.' : 'No published measurement yet.')}</p> : <>
      <p className="mt-2 text-sm text-slate-600">{tl ? 'Huling sukat' : 'Last measurement'}: {new Date(reading.measuredAt).toLocaleString('en-PH')}</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">{([['pH', reading.ph, ''], [tl ? 'Temperatura' : 'Temperature', reading.temperature, '°C'], ['Turbidity', reading.turbidity, 'NTU']] as const).map(([label, value, unit]) => <div key={label} className="rounded-lg border border-slate-200 p-4"><h3 className="text-sm font-semibold text-slate-600">{label}</h3><p className="mt-2 text-2xl font-bold">{value === null ? '--' : `${label === 'Turbidity' ? '~' : ''}${value} ${unit}`}</p><p className="mt-2 text-sm text-slate-600">{value === null ? (tl ? 'Walang sukat' : 'No measurement') : label === 'Turbidity' ? (tl ? 'Tantya lamang; kailangan ng calibration' : 'Estimate; calibration required') : ''}</p></div>)}</div>
    </>}
    <p className="mt-4 text-sm text-slate-600">{tl ? 'Mula sa isang napiling fishpen lamang, hindi buong Cuyab. Hindi kinukumpirma ng kulang o lumang datos na ligtas ang tubig.' : 'From one selected fishpen, not all of Cuyab. Incomplete or old readings do not confirm water safety.'}</p>
  </section>;
}
