import { useMemo, useState } from 'react';
import { CalendarDays, TrendingUp } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, usePlotArea, useXAxisInverseDataSnapScale } from 'recharts';
import { filterTrendReadings, makeTrendSeries, trendParameters, trendRanges, type TrendParameter, type TrendRange, type TrendReading } from '../lib/sensorTrends';

type Lang = 'en' | 'tl';
type Point = ReturnType<typeof makeTrendSeries>['rows'][number];
type PlotRow = { time: number; values: Record<TrendParameter, Point> };
type Connection = 'live' | 'stale' | 'offline' | 'checking' | 'unverified' | 'no-upload';

const metadata = {
  ph: { en: 'pH', tl: 'pH', unit: 'pH', color: '#7645b3' },
  temperature: { en: 'Temperature', tl: 'Temperatura', unit: '\u00b0C', color: '#b75308' },
  dissolvedOxygen: { en: 'Dissolved Oxygen', tl: 'Natunaw na Oxygen', unit: 'mg/L', color: '#1760bb' },
  turbidity: { en: 'Turbidity', tl: 'Labo ng Tubig', unit: 'NTU', color: '#157047' }
};

function domainFor(rows: Point[]): [number, number] {
  const values = rows.flatMap(row => row.value == null ? [] : [row.value]);
  if (!values.length) return [0, 1];
  const low = Math.min(...values), high = Math.max(...values);
  const pad = Math.max((high - low) * .15, Math.abs(low) * .08, .5);
  return [low >= 0 ? Math.max(0, low - pad) : low - pad, high + pad];
}

function SampleTap({ pick }: { pick: (time: number) => void }) {
  const plot = usePlotArea();
  const snap = useXAxisInverseDataSnapScale();
  if (!plot || !snap) return null;
  return <rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} fill="transparent" aria-hidden="true"
    onClick={event => {
      const box = event.currentTarget.getBoundingClientRect();
      if (!box.width) return;
      const value = snap(plot.x + (event.clientX - box.left) * plot.width / box.width);
      if (typeof value === 'number' && Number.isFinite(value)) pick(value);
    }} />;
}

export function WaterQualityTrends({ readings, state, connection, now, lang, onRetry }: {
  readings: TrendReading[]; state: 'loading' | 'ready' | 'error'; connection: Connection; now: number; lang: Lang; onRetry: () => void;
}) {
  const [days, setDays] = useState<TrendRange>(1);
  const [hidden, setHidden] = useState<TrendParameter[]>([]);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const tl = lang === 'tl';
  const locale = tl ? 'fil-PH' : 'en-PH';
  const { points, untimedIds } = useMemo(() => filterTrendReadings(readings, days, now), [readings, days, now]);
  const series = useMemo(() => ({
    ph: makeTrendSeries(points, 'ph', untimedIds),
    temperature: makeTrendSeries(points, 'temperature', untimedIds),
    dissolvedOxygen: makeTrendSeries(points, 'dissolvedOxygen', untimedIds),
    turbidity: makeTrendSeries(points, 'turbidity', untimedIds)
  }), [points, untimedIds]);
  const rows: PlotRow[] = points.map(([time], i) => ({ time, values: {
    ph: series.ph.rows[i], temperature: series.temperature.rows[i],
    dissolvedOxygen: series.dissolvedOxygen.rows[i], turbidity: series.turbidity.rows[i]
  } }));
  const shown = trendParameters.filter(key => !hidden.includes(key));
  const plotted = shown.filter(key => series[key].latest);
  const single = plotted.length === 1 ? plotted[0] : null;
  const start = rows[0]?.time ?? now, end = rows.at(-1)?.time ?? now;
  const span = end - start;
  const domain: [number, number] = span ? [start, end] : [start - 30_000, end + 30_000];
  const stamp = new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const tick = new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Manila', ...(span >= 86_400_000
    ? { month: 'short', day: 'numeric' } : { hour: 'numeric', minute: '2-digit', ...(span < 180_000 ? { second: '2-digit' } : {}) }) });
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const label = (row: PlotRow, key: TrendParameter) => {
    const point = row.values[key];
    return point.value != null ? `${number.format(point.value)} ${metadata[key].unit}` :
      point.uncalibrated ? (tl ? 'Hindi calibrated' : 'Uncalibrated') : (tl ? 'Walang sukat' : 'No reading');
  };
  const sampleDetails = (row: PlotRow) => <><strong>{stamp.format(row.time)} PHT</strong><dl>{shown.map(key => (
    <div key={key}><dt>{metadata[key][lang]}</dt><dd>{label(row, key)}</dd></div>
  ))}</dl></>;
  const picked = rows.find(row => row.time === selectedTime);
  const rangeName = (choice: TrendRange) => choice === 1 ? (tl ? '24 Oras' : '24 Hours') : `${choice} ${tl ? 'Araw' : 'Days'}`;
  const deviceMessage = {
    live: '', checking: '',
    'no-upload': tl ? 'Wala pang upload mula sa ESP32.' : 'The ESP32 has not uploaded a reading yet.',
    stale: tl ? 'Lumang sukat ang pinakahuling sample.' : 'The latest sample is stale.',
    offline: tl ? 'Offline ang device. Ipinapakita ang mga naitalang sukat.' : 'Device offline. Showing recorded history.',
    unverified: tl ? 'Hindi makumpirma ang koneksiyon ng device.' : 'Unable to verify the device connection.'
  }[connection];
  const noData = !shown.length ? (tl ? 'Pumili ng linya.' : 'No series selected.') : state === 'loading' ? (tl ? 'Kinukuha ang mga tala...' : 'Loading historical readings...') :
    state === 'error' && !readings.length ? (tl ? 'Hindi makuha ang mga tala.' : 'Historical readings unavailable.') :
      !readings.length ? (tl ? 'Wala pang naitalang sukat' : 'No historical readings yet') :
        (tl ? 'Walang valid na sukat sa napiling panahon at parameter.' : 'No valid readings for the selected period and parameters.');

  return <section className="water-quality-trends dashboard-trend" aria-labelledby="water-quality-trends-heading">
    <header className="dashboard-section-heading">
      <h2 id="water-quality-trends-heading"><TrendingUp size={23} aria-hidden="true" />{tl ? 'Mga Trend sa Kalidad ng Tubig' : 'Water Quality Trends'}</h2>
      <div className="dashboard-period" role="group" aria-label={tl ? 'Saklaw ng petsa' : 'Time range'}>
        {trendRanges.map(choice => <button key={choice} type="button" aria-pressed={days === choice}
          onClick={() => { setDays(choice); setSelectedTime(null); }}><CalendarDays size={15} aria-hidden="true" />{rangeName(choice)}</button>)}
      </div>
    </header>
    <div className="dashboard-trend-plot">
      {plotted.length ? <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={rows} margin={{ top: 12, right: 20, bottom: 4, left: 8 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="#dce6e8" />
          <XAxis type="number" dataKey="time" scale="time" domain={domain} allowDataOverflow tickCount={5}
            minTickGap={20} tickFormatter={time => tick.format(time)} tick={{ fontSize: 11 }} />
          {plotted.map(key => <YAxis key={key} yAxisId={key} domain={domainFor(series[key].rows)} hide={single !== key}
            width={52} tickCount={5} tickFormatter={value => number.format(value)} tick={{ fontSize: 11 }} unit={` ${metadata[key].unit}`} />)}
          <Tooltip content={({ active, label: time }) => {
            const row = active ? rows.find(point => point.time === Number(time)) : null;
            return row ? <div className="dashboard-trend-tooltip">{sampleDetails(row)}</div> : null;
          }} />
          {plotted.flatMap(key => series[key].segments.map(segment => <Line key={`${key}-${segment}`} yAxisId={key}
            name={metadata[key][lang]} dataKey={(row: PlotRow) => row.values[key].segment === segment ? row.values[key].value : null}
            type="linear" stroke={metadata[key].color} strokeWidth={2}
            dot={{ r: 2.5, fill: metadata[key].color, strokeWidth: 0 }} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />))}
          <SampleTap pick={setSelectedTime} />
        </LineChart>
      </ResponsiveContainer> : <p className="dashboard-trend-empty" role="status">{noData}</p>}
    </div>
    <div className="dashboard-series" role="group" aria-label={tl ? 'Mga linya sa tsart' : 'Chart series'}>
      {trendParameters.map(key => <button key={key} type="button" aria-pressed={shown.includes(key)}
        onClick={() => setHidden(before => before.includes(key) ? before.filter(item => item !== key) : [...before, key])}>
        <i style={{ backgroundColor: metadata[key].color }} aria-hidden="true" />{metadata[key][lang]}{key !== 'ph' && ` (${metadata[key].unit})`}
      </button>)}
    </div>
    <div className="dashboard-trend-caption">
      <span>{tl ? `${rows.length} sample · PHT` : `${rows.length} samples · PHT`}{plotted.length > 1 && (tl ? ' · Magkakahiwalay na scale' : ' · Independent scales')}</span>
      {deviceMessage && <span>{deviceMessage}</span>}
      {readings.length >= 60 && <span>{tl ? 'Hanggang 60 pinakahuling tala.' : 'Up to 60 recent samples.'}</span>}
      {untimedIds.length > 0 && <span>{tl ? `${untimedIds.length} sample na walang tiyak na oras` : `${untimedIds.length} untimed samples omitted`}</span>}
      {state === 'error' && <button type="button" className="soft-button" onClick={onRetry}>{tl ? 'Subukan muli' : 'Try again'}</button>}
    </div>
    {picked && <div className="dashboard-trend-tooltip dashboard-trend-picked" role="status">{sampleDetails(picked)}</div>}
    {plotted.length > 0 && <details className="dashboard-trend-readings">
      <summary>{tl ? 'Talaan ng mga sukat' : 'View readings'}</summary>
      <div className="farmer-table-frame" tabIndex={0}>
        <table><thead><tr><th scope="col">{tl ? 'Oras (PHT)' : 'Time (PHT)'}</th>{shown.map(key => <th key={key} scope="col">{metadata[key][lang]}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.time}><td>{stamp.format(row.time)}</td>{shown.map(key => <td key={key}>{label(row, key)}</td>)}</tr>)}</tbody></table>
      </div>
    </details>}
  </section>;
}
