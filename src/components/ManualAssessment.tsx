import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { WaterParams } from '../types';
import { manualParameters } from '../lib/manualValidation';
import { measuredStatus, parameterStatus } from '../lib/measurementStatus';
import { recommendationCopy, referenceThresholds, units } from '../lib/recommendations';
import { SensorActionCard, sensorActionName } from './SensorActionCard';

function manualItems(values: Partial<WaterParams>) {
  return manualParameters.map(parameter => {
    const value = values[parameter] ?? null;
    const state = value === null ? 'missing' as const : parameterStatus(parameter, value);
    return { parameter, value, state, source: 'manual' as const, range: referenceThresholds[parameter],
      recordedAt: null, priority: 'NORMAL' as const, rule: 'manual-measured-status' };
  });
}

const criticalOxygenAction = {
  en: 'If the reading is reliable, start manual aeration now if it is safe and available.',
  tl: 'Kung maaasahan ang sukat, paandarin agad nang mano-mano ang aerator kung ligtas at mayroon.'
};

type ManualParameter = typeof manualParameters[number];
const tabOrder = ['dissolvedOxygen', 'turbidity', 'ph', 'temperature'] as const;
const shortNames = {
  ph: { en: 'pH', tl: 'pH' },
  temperature: { en: 'Temp.', tl: 'Temp.' },
  dissolvedOxygen: { en: 'DO', tl: 'DO' },
  turbidity: { en: 'Turbidity', tl: 'Labo' }
};

export function ManualAssessment({ values, lang }: { values: Partial<WaterParams>; lang: 'en' | 'tl' }) {
  const tl = lang === 'tl';
  const items = manualItems(values);
  const measured = items.filter(item => item.value !== null).length;
  const overall = measuredStatus(values);
  const urgentOxygen = items.some(item => item.parameter === 'dissolvedOxygen' && item.state === 'critical');
  const overallLabel = overall === 'partial' ? (tl ? 'Walang sukat' : 'No measurements') : overall === 'safe' ?
    (tl ? 'Pasok ang mga nasukat' : 'Measured values in range') : recommendationCopy({ ...items[0], state: overall }, tl).label;
  return <section className="card manual-summary p-4 sm:p-5" data-severity={overall} aria-labelledby="manual-summary-heading">
    <header className="manual-summary-header">
      <div>
        <h2 id="manual-summary-heading" className="text-lg font-bold">
          {tl ? 'Buod ng kalidad ng tubig' : 'Water quality summary'}:
          {' '}<span className="manual-severity" data-severity={overall}>{overallLabel}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-600">{urgentOxygen ? <><strong>{tl ? 'Kritikal na DO:' : 'Critical DO:'}</strong> {criticalOxygenAction[lang]}</> :
          (tl ? 'Bahagyang manu-manong pagsusuri, hindi live.' : 'Partial manual assessment, not live sensor data.')}</p>
      </div>
      <p role="status" className="manual-summary-counts text-sm">
        <strong>{tl ? `${measured} sa ${items.length} nasukat` : `${measured} of ${items.length} measured`}</strong>
        <span className="text-slate-600">{tl ? `Hindi nasukat: ${items.length - measured}` : `Missing: ${items.length - measured}`}</span>
      </p>
    </header>
    <dl className="manual-summary-metrics">
      {items.map(item => <div key={item.parameter} className="manual-summary-metric">
        <dt className="text-sm text-slate-600">{sensorActionName(item.parameter, lang)}</dt>
        <dd>
          <strong>{item.value === null ? '\u2014' : `${item.value} ${item.parameter === 'temperature' ? '\u00b0C' : units[item.parameter]}`.trim()}</strong>
          <span className="manual-severity manual-severity-dot" data-severity={item.state}>{item.state === 'safe' ?
            (tl ? 'Pasok sa saklaw' : 'In range') : recommendationCopy(item, tl).label}</span>
        </dd>
      </div>)}
    </dl>
    <p className="manual-summary-note text-sm text-slate-600">{tl ? 'Manu-manong sukat ito, hindi live. Hindi nito kinukumpirma ang kaligtasan ng buong tubig.' : 'These are manual readings, not live sensor data. They do not confirm overall water safety.'}</p>
  </section>;
}

export function ManualRecommendedActions({ values, lang }: { values: Partial<WaterParams>; lang: 'en' | 'tl' }) {
  const id = useId();
  const tabRefs = useRef<Partial<Record<ManualParameter, HTMLButtonElement | null>>>({});
  const [selectedParameter, setSelectedParameter] = useState<ManualParameter | null>(null);
  const tl = lang === 'tl';
  const actions = manualItems(values).filter(item => item.state === 'critical' || item.state === 'warning')
    .sort((a, b) => Number(b.state === 'critical') - Number(a.state === 'critical') ||
      (a.state === 'critical' ? Number(b.parameter === 'dissolvedOxygen') - Number(a.parameter === 'dissolvedOxygen') : 0) ||
      manualParameters.indexOf(a.parameter) - manualParameters.indexOf(b.parameter));
  if (!actions.length) return null;
  const tabs = tabOrder.flatMap(parameter => actions.filter(item => item.parameter === parameter));
  const selected = actions.find(item => item.parameter === selectedParameter) ?? actions[0];
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length :
      event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const parameter = tabs[next].parameter;
    setSelectedParameter(parameter);
    tabRefs.current[parameter]?.focus();
  };
  return <section className="card manual-recommendations min-w-0" aria-labelledby={`${id}-heading`}>
    <header className="manual-actions-header">
      <h2 id={`${id}-heading`} className="text-lg font-bold">{tl ? 'Mga inirerekomendang hakbang' : 'Recommended actions'}</h2>
    </header>
    <div className="manual-action-tabs" role="tablist" aria-label={tl ? 'Mga parameter na dapat bantayan' : 'Parameters that need attention'}>
      {tabs.map((item, index) => {
        const label = recommendationCopy(item, tl).label;
        const name = sensorActionName(item.parameter, lang);
        const active = selected.parameter === item.parameter;
        return <button key={item.parameter} ref={node => { tabRefs.current[item.parameter] = node; }} type="button" role="tab"
          id={`${id}-tab-${item.parameter}`} aria-controls={`${id}-panel-${item.parameter}`} aria-selected={active} tabIndex={active ? 0 : -1}
          aria-label={`${name}, ${label}`} onClick={() => setSelectedParameter(item.parameter)} onKeyDown={event => navigateTabs(event, index)}>
          <span className="manual-tab-name">{name}</span>
          <span className="manual-tab-short" aria-hidden="true">{shortNames[item.parameter][lang]}</span>
          <span className="manual-severity manual-severity-dot" data-severity={item.state}>{label}</span>
        </button>;
      })}
    </div>
    {tabs.map(item => {
      const active = selected.parameter === item.parameter;
      return <div key={item.parameter} className="manual-action-panel" role="tabpanel" id={`${id}-panel-${item.parameter}`}
        aria-labelledby={`${id}-tab-${item.parameter}`} tabIndex={active ? 0 : -1} hidden={!active}>
        {active && <SensorActionCard item={item} lang={lang} layout="manual-panel" />}
      </div>;
    })}
  </section>;
}
