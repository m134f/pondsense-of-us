import { useMemo, useState } from 'react';
import { BookOpen, Droplet, Droplets, Thermometer, TrendingUp, Waves } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { classCGuidelines, classCUrl } from '../lib/waterGuidelines';
import { compareClassC, compareTurbidityResearch, filterTrendReadings, makeTrendSeries, trendParameters, trendRanges, turbidityResearchReference, type TrendParameter, type TrendRange, type TrendReading } from '../lib/sensorTrends';

type Lang = 'en' | 'tl';
type RequestState = 'loading' | 'ready' | 'error';
type Connection = 'live' | 'stale' | 'offline' | 'checking' | 'unverified' | 'no-upload';
type Point = ReturnType<typeof makeTrendSeries>['rows'][number];
const metadata = {
  ph: { en: 'pH', tl: 'pH', unit: '', axis: 'pH', digits: 2, Icon: Droplet },
  dissolvedOxygen: { en: 'Dissolved Oxygen (DO)', tl: 'Natunaw na Oxygen (DO)', unit: 'mg/L', axis: 'DO (mg/L)', digits: 2, Icon: Waves },
  temperature: { en: 'Temperature', tl: 'Temperatura', unit: '\u00b0C', axis: '\u00b0C', digits: 2, Icon: Thermometer },
  turbidity: { en: 'Turbidity', tl: 'Labo ng Tubig', unit: 'NTU', axis: 'NTU', digits: 2, Icon: Droplets }
};
const { moderate, severeAbove, url: turbiditySource } = turbidityResearchReference;
const turbidityLines = [
  { value: moderate, color: '#8a5c10' },
  { value: severeAbove, color: '#a42b32' }
] as const;

function researchTitle(tl: boolean) {
  return tl ? 'Sanggunian sa Pananaliksik sa Aquaculture' : 'Aquaculture Research Reference';
}

function referenceText(parameter: TrendParameter, tl: boolean) {
  const limit = classCGuidelines[parameter];
  if (!limit) return tl ? 'Walang NTU limit sa Talahanayan 3 ng DENR' : 'No DENR NTU limit in Table 3';
  const suffix = parameter === 'ph' ? '' : ` ${limit.unit}`;
  return limit.max === undefined ? `\u2265 ${limit.min}${suffix}` : `${limit.min}\u2013${limit.max}${suffix}`;
}

function readingLabel(key: TrendParameter, value: number, locale: string) {
  const { unit, digits } = metadata[key];
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)}${unit ? ` ${unit}` : ''}`;
}

function sampleTime(time: number, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    second: '2-digit', timeZone: 'Asia/Manila' }).format(time);
}

function yDomain(parameter: TrendParameter, rows: Point[]): [number, number] {
  const limit = classCGuidelines[parameter];
  const values = rows.flatMap(row => row.value === null ? [] : [row.value]);
  if (limit?.min !== undefined) values.push(limit.min);
  if (limit?.max !== undefined) values.push(limit.max);
  if (parameter === 'turbidity') values.push(moderate, severeAbove);
  if (parameter === 'dissolvedOxygen' || parameter === 'turbidity' || !values.length) values.push(0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * .12, parameter === 'ph' ? .25 : 1);
  return [parameter === 'temperature' ? Math.floor(min - padding) : Math.max(0, Math.floor(min - padding)), Math.ceil(max + padding)];
}

function EmptyReferencePlot({ parameter, range, tl }: { parameter: TrendParameter; range: [number, number]; tl: boolean }) {
  const limit = classCGuidelines[parameter];
  const position = (value: number) => (range[1] - value) * 100 / (range[1] - range[0]);
  if (parameter === 'turbidity') return <div className="water-trend-empty-frame" role="img" aria-label={`${researchTitle(tl)}: ${moderate} NTU, ${severeAbove} NTU`}>
    <span className="water-trend-frame-axis" aria-hidden="true">NTU</span>
    {turbidityLines.map(({ value, color }) => <div key={value} className="water-trend-frame-line"
      style={{ top: `${position(value)}%`, borderColor: color, color }}><span>{value} NTU</span></div>)}
  </div>;
  if (limit?.min === undefined) return <div className="water-trend-empty-frame" aria-hidden="true" />;
  const lower = position(limit.min);
  const upper = limit.max === undefined ? null : position(limit.max);
  return <div className="water-trend-empty-frame" role="img" aria-label={`${metadata[parameter][tl ? 'tl' : 'en']}: ${referenceText(parameter, tl)}`}>
    <span className="water-trend-frame-axis" aria-hidden="true">{metadata[parameter].axis}</span>
    <div className="water-trend-frame-shade" data-min-only={upper === null} style={{ top: `${upper ?? lower}%`, bottom: `${upper === null ? 0 : 100 - lower}%` }} />
    <div className="water-trend-frame-line" style={{ top: `${lower}%` }}><span>{tl ? 'Min.' : 'Min'} {limit.min}</span></div>
    {upper !== null && <div className="water-trend-frame-line" data-upper="true" style={{ top: `${upper}%` }}><span>{tl ? 'Max.' : 'Max'} {limit.max}</span></div>}
  </div>;
}

function TrendChart({ parameter, points, untimedIds, lang, emptyText }: {
  parameter: TrendParameter; points: ReturnType<typeof filterTrendReadings>['points']; untimedIds: number[]; lang: Lang; emptyText: string;
}) {
  const tl = lang === 'tl';
  const locale = tl ? 'fil-PH' : 'en-PH';
  const { Icon, unit, axis } = metadata[parameter];
  const title = metadata[parameter][lang];
  const limit = classCGuidelines[parameter];
  const research = parameter === 'turbidity';
  const { rows, segments, latest } = useMemo(() => makeTrendSeries(points, parameter, untimedIds), [points, parameter, untimedIds]);
  const range = yDomain(parameter, rows);
  const start = rows[0]?.time;
  const end = rows.at(-1)?.time;
  const span = start !== undefined && end !== undefined ? end - start : 0;
  const domain: [number, number] = start === undefined || end === undefined ? [0, 1] :
    start === end ? [start - 30_000, end + 30_000] : [start, end];
  const tick = new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Manila',
    ...(span > 30 * 3_600_000 ? { month: 'short', day: 'numeric' } :
      { hour: 'numeric', minute: '2-digit', ...(span < 180_000 ? { second: '2-digit' } : {}) })
  });
  const comparison = latest ? (research ? compareTurbidityResearch(latest.value) : compareClassC(parameter, latest.value)) :
    rows.some(row => row.uncalibrated) ? 'uncalibrated' : 'missing';
  const uncalibrated = tl ? 'Walang calibrated na sukat' : 'No calibrated reading';
  const labels = {
    missing: tl ? 'Walang valid na sukat' : 'No valid reading',
    uncalibrated,
    favorable: tl ? 'Paborable' : 'Favorable',
    moderate: tl ? 'Katamtamang limitasyon' : 'Moderate limitation',
    severe: tl ? 'Matinding limitasyon' : 'Severe limitation',
    unreferenced: referenceText(parameter, tl),
    within: parameter === 'temperature' ? (tl ? 'Pasok sa saklaw sa talahanayan' : 'Within table range') : (tl ? 'Pasok sa sanggunian' : 'Within reference range'),
    below: tl ? 'Mas mababa sa sanggunian' : 'Below reference range',
    above: tl ? 'Mas mataas sa sanggunian' : 'Above reference range'
  };
  const measuredName = tl ? 'Sukat ng sensor' : 'Sensor reading';
  const pointLabel = (row: Point) => row.value !== null ? readingLabel(parameter, row.value, locale) :
    row.uncalibrated ? uncalibrated : (tl ? 'Wala o hindi valid' : 'Missing or invalid');
  return <section className="card water-trend-card" aria-labelledby={`water-trend-${parameter}`}>
    <header className="water-trend-card-header">
      <Icon size={23} className="water-trend-icon" aria-hidden="true" />
      <div className="water-trend-heading">
        <h3 id={`water-trend-${parameter}`}>{title}{unit && <span className="water-trend-unit"> ({unit})</span>}</h3>
        <p className="text-sm text-slate-600">{tl ? 'Huling valid na sukat' : 'Latest valid reading'}: <strong>{latest ? readingLabel(parameter, latest.value, locale) : '\u2014'}</strong>
          {latest && <time className="water-trend-timestamp" dateTime={new Date(latest.time).toISOString()}>{sampleTime(latest.time, locale)} PHT</time>}
        </p>
        {latest && rows.at(-1)?.uncalibrated && <p className="text-sm text-slate-600">{tl ? 'Walang calibrated na sukat sa pinakahuling sample.' : 'Latest sample has no calibrated reading.'}</p>}
      </div>
      <span className="water-trend-status" data-comparison={comparison}>{labels[comparison]}</span>
    </header>
    <div className="water-trend-plot" data-empty={!latest}>
      {latest ? <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={rows} margin={{ top: 10, right: 18, bottom: 23, left: 0 }} accessibilityLayer
          title={`${title} \u2014 ${tl ? 'Kasaysayan ng sukat' : 'Reading history'}`}>
          <CartesianGrid vertical={false} stroke="#dfe7ed" />
          <XAxis type="number" dataKey="time" scale="time" domain={domain} allowDataOverflow tickCount={5} minTickGap={18}
            hide={!rows.length} tickFormatter={value => tick.format(value)} tick={{ fontSize: 11 }} tickMargin={6}
            label={{ value: tl ? 'Oras ng sukat (PHT)' : 'Sample time (PHT)', position: 'insideBottom', offset: -13, fontSize: 11 }} />
          <YAxis domain={range} allowDataOverflow hide={!latest && !limit} tickCount={5} width={48} tick={{ fontSize: 11 }} tickMargin={4}
            label={{ value: axis, angle: -90, position: 'insideLeft', offset: 5, fontSize: 11, style: { textAnchor: 'middle' } }} />
          {limit?.min !== undefined && <ReferenceArea y1={limit.max === undefined ? range[0] : limit.min}
            y2={limit.max ?? limit.min} fill={limit.max === undefined ? '#fce4e3' : '#d9eee3'} fillOpacity={.65} stroke="none" />}
          {limit?.min !== undefined && <ReferenceLine y={limit.min} stroke="#3558a9" strokeWidth={1.5} strokeDasharray="5 4"
            label={{ value: `${tl ? 'Min.' : 'Min'} ${limit.min}`, position: 'insideTopRight', fill: '#28478f', fontSize: 11 }} />}
          {limit?.max !== undefined && <ReferenceLine y={limit.max} stroke="#bb3e42" strokeWidth={1.5} strokeDasharray="5 4"
            label={{ value: `${tl ? 'Max.' : 'Max'} ${limit.max}`, position: 'insideTopRight', fill: '#a42b32', fontSize: 11 }} />}
          {research && turbidityLines.map(({ value, color }) => <ReferenceLine key={value} y={value} stroke={color} strokeWidth={1.5} strokeDasharray="5 4"
            label={{ value: `${value} NTU`, position: 'insideTopRight', fill: color, fontSize: 11 }} />)}
          <Tooltip filterNull={false} content={({ active, label }) => {
            const row = active && typeof label === 'number' ? rows.find(point => point.time === label) : null;
            return row ? <div className="water-trend-tooltip" role="status" aria-live="polite">
              <p>{sampleTime(row.time, locale)} PHT</p>
              <strong>{title}: {pointLabel(row)}</strong>
            </div> : null;
          }} />
          {segments.map(segment => <Line key={segment} type="linear"
            dataKey={(point: Point) => point.segment === segment ? point.value : null}
            name={measuredName} stroke="#12664f" strokeWidth={2.5}
            dot={{ r: 2.6, fill: '#12664f', strokeWidth: 0 }} activeDot={{ r: 4 }}
            connectNulls={false} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer> : <EmptyReferencePlot parameter={parameter} range={range} tl={tl} />}
      {!latest && <div className="water-trend-empty"><p>{comparison === 'uncalibrated' ? (tl ? 'Hindi ipinapakita ang mga tantya.' : 'Estimates are not plotted.') : rows.length ? (tl ? 'Walang valid na sukat para sa parameter na ito.' : 'No valid readings for this parameter.') : emptyText}</p></div>}
    </div>
    {research && <div className="water-trend-research text-sm">
      <strong>{researchTitle(tl)}</strong>
      <div className="water-trend-legend" aria-label={tl ? 'Mga kategorya ng labo ng tubig' : 'Turbidity research categories'}>
        <span><i className="water-trend-band" data-band="favorable" aria-hidden="true" />{labels.favorable} ({tl ? 'bahagyang limitasyon' : 'slight limitation'}): &lt;{moderate} NTU</span>
        <span><i className="water-trend-key water-trend-key-research" data-band="moderate" aria-hidden="true" />{labels.moderate}: {moderate}{'\u2013'}{severeAbove} NTU</span>
        <span><i className="water-trend-key water-trend-key-research" data-band="severe" aria-hidden="true" />{labels.severe}: &gt;{severeAbove} NTU</span>
      </div>
    </div>}
    <div className="water-trend-legend text-sm" aria-label={tl ? 'Mga simbolo ng tsart' : 'Chart legend'}>
      <span><i className="water-trend-key water-trend-key-measurement" aria-hidden="true" />{measuredName}</span>
      {limit && <span><i className="water-trend-key water-trend-key-reference" aria-hidden="true" />
        {limit.max !== undefined && <i className="water-trend-key water-trend-key-upper" aria-hidden="true" />}
        {tl ? 'Sanggunian' : 'Reference'}: {referenceText(parameter, tl)}{parameter === 'temperature' ? ' (b)' : ''}</span>}
    </div>
    {latest && <details className="water-trend-readings">
      <summary>{tl ? 'Talaan ng mga sukat' : 'View readings'}</summary>
      <dl>{rows.map(row => <div key={row.time}>
        <dt><time dateTime={new Date(row.time).toISOString()}>{sampleTime(row.time, locale)} PHT</time></dt>
        <dd>{pointLabel(row)}</dd>
      </div>)}</dl>
    </details>}
  </section>;
}

export function WaterQualityTrends({ readings, state, connection, now, lang, onRetry }: {
  readings: TrendReading[]; state: RequestState; connection: Connection; now: number; lang: Lang; onRetry: () => void;
}) {
  const [parameter, setParameter] = useState<TrendParameter | 'all'>('all');
  const [days, setDays] = useState<TrendRange>(1);
  const tl = lang === 'tl';
  const { points, untimedIds } = useMemo(() => filterTrendReadings(readings, days, now), [readings, days, now]);
  const untimed = untimedIds.length;
  const emptyText = state === 'loading' && !readings.length ? (tl ? 'Kinukuha ang mga tala...' : 'Loading historical readings...') :
    state === 'error' && !readings.length ? (tl ? 'Hindi makuha ang mga tala.' : 'Historical readings unavailable.') :
      !readings.length ? (tl ? 'Wala pang naitalang sukat' : 'No historical readings yet') :
        (tl ? 'Walang napetsahang sukat sa panahong ito.' : 'No timestamped readings in this period.');
  const deviceMessage = {
    live: '', checking: '',
    'no-upload': tl ? 'Wala pang upload mula sa ESP32.' : 'The ESP32 has not uploaded a reading yet.',
    stale: tl ? 'Lumang sukat ang pinakahuling sample. Hindi live ang mga tala rito.' : 'The latest sample is stale. The readings below are historical, not live.',
    offline: tl ? 'Offline ang device. Ipinapakita ang mga naitalang sukat.' : 'Device offline. Showing recorded history.',
    unverified: tl ? 'Hindi makumpirma ang koneksiyon ng device.' : 'Unable to verify the device connection.'
  }[connection];
  const shown = parameter === 'all' ? trendParameters : [parameter];
  return <section className="water-quality-trends" aria-labelledby="water-quality-trends-heading">
    <div className="water-trends-header">
      <div className="flex min-w-0 items-start gap-3">
        <TrendingUp size={25} className="water-trend-icon" aria-hidden="true" />
        <div><h2 id="water-quality-trends-heading">{tl ? 'Mga Trend sa Kalidad ng Tubig' : 'Water Quality Trends'}</h2>
          <p className="text-sm text-slate-600">{tl ? 'Mga naitalang sukat ng sensor at mga sanggunian sa bawat parameter.' : 'Recorded sensor readings and parameter-specific references.'}</p></div>
      </div>
      <select className="water-trends-range" aria-label={tl ? 'Saklaw ng petsa' : 'Time range'} value={days}
        onChange={event => { const choice = trendRanges.find(value => String(value) === event.target.value); if (choice) setDays(choice); }}>
        <option value={1}>{tl ? 'Huling 24 Oras' : 'Last 24 Hours'}</option>
        <option value={7}>{tl ? 'Huling 7 Araw' : 'Last 7 Days'}</option>
        <option value={30}>{tl ? 'Huling 30 Araw' : 'Last 30 Days'}</option>
      </select>
    </div>
    <div className="water-trends-filters" role="group" aria-label={tl ? 'Salain ayon sa parameter' : 'Filter by parameter'}>
      {(['all', ...trendParameters] as const).map(key => <button type="button" key={key} aria-pressed={key === parameter}
        onClick={() => setParameter(key)}>{key === 'all' ? (tl ? 'Lahat' : 'All') : metadata[key][lang]}</button>)}
    </div>
    <div className="water-trends-state text-sm">
      <p>{tl ? `${points.length} tala sa panahong ito. Hanggang 60 pinakahuling tala ang ibinibigay ng server.` : `${points.length} samples in this period. The server returns up to 60 recent samples.`}</p>
      {deviceMessage && <p>{deviceMessage}</p>}
      {!!untimed && <p>{tl ? `${untimed} tala ang hindi isinama dahil hindi matiyak ang oras ng pagsukat.` : `${untimed} ${untimed === 1 ? 'sample' : 'samples'} omitted because the sample time could not be verified.`}</p>}
      {state === 'loading' && <p role="status">{tl ? 'Kinukuha ang mga tala...' : 'Loading historical readings...'}</p>}
      {state === 'error' && <div className="water-trends-error" role="status">
        <p>{readings.length ? (tl ? 'Hindi ma-update ang mga tala. Ipinapakita ang huling nakuhang datos.' : 'Could not refresh history. Showing the last loaded data.') :
          (tl ? 'Hindi makuha ang mga tala.' : 'Could not load historical readings.')}</p>
        <button type="button" className="soft-button" onClick={onRetry}>{tl ? 'Subukan muli' : 'Try again'}</button>
      </div>}
    </div>
    <div className="water-trends-grid" data-single={shown.length === 1}>
      {shown.map(key => <TrendChart key={key} parameter={key} points={points} untimedIds={untimedIds} lang={lang} emptyText={emptyText} />)}
    </div>
    <div className="card water-trends-source text-sm">
      <div className="water-trends-source-line">
        <strong><BookOpen size={17} className="water-trend-icon" aria-hidden="true" /> DENR Class C</strong>
        {trendParameters.filter(key => key !== 'turbidity').map(key => <span key={key}>{key === 'dissolvedOxygen' ? 'DO' : metadata[key][lang]}: {referenceText(key, tl)}</span>)}
        <a href={classCUrl} target="_blank" rel="noreferrer">DAO 2016-08, Table 3</a>
      </div>
      <p>{tl ? 'Sangguniang pangkapaligiran, hindi patakaran ng Warning o Critical. Sa Note (b), maaaring manaig ang natural na temperatura na tinukoy ng EMB. Ang opisyal na DO sampling ay 9 AM–4 PM. Ang TSS (80 mg/L) ay iba sa turbidity (NTU).' :
        'Environmental references, not the app’s Warning or Critical thresholds. Under Note (b), EMB-determined natural background temperature may apply. Official DO sampling is 9 AM–4 PM. TSS (80 mg/L) is not turbidity (NTU).'}</p>
      <div className="water-trend-research">
        <div className="water-trends-source-line">
          <strong>{researchTitle(tl)}: {metadata.turbidity[lang]}</strong>
          <a href={turbiditySource} target="_blank" rel="noreferrer">Hajek &amp; Boyd (1994), {tl ? 'Talahanayan' : 'Table'} 2 (LAJAR)</a>
        </div>
        <p>{tl ? 'Para sa freshwater pond aquaculture at gabay lamang. Hindi ito pamantayan ng DENR o LLDA, at hindi ginagamit sa mga alerto o pagsuri ng pagsunod sa DENR Class C.' :
          'Informational bands for freshwater pond aquaculture. Not a DENR or LLDA standard, an alert threshold, or a measure of DENR Class C compliance.'} {referenceText('turbidity', tl)}.</p>
      </div>
    </div>
  </section>;
}
