import { useState } from 'react';
import { Save } from 'lucide-react';
import { apiJson } from '../lib/api';
import { activeSpecies, speciesId } from '../data/fish';
import { AdminBadge, AdminHeading, AdminLoad, AdminRefresh, useAdminResource } from './AdminControls';
import { parseTurbidityThresholds, type TurbidityAlertRule } from '../lib/turbidityAlert';
import { TurbidityCalculator } from './TurbidityCalculator';

type Fish = { id: string | number; name: string; validationPending?: boolean } & Record<string, unknown>;
const ranges = [
  { label: 'pH', min: 'optimal_ph_min', max: 'optimal_ph_max' },
  { label: 'Temperature (\u00b0C)', min: 'optimal_temp_min', max: 'optimal_temp_max' },
  { label: 'Dissolved Oxygen (mg/L)', min: 'optimal_do_min', max: 'optimal_do_max' },
  { label: 'Turbidity (NTU)', min: 'optimal_turb_min', max: 'optimal_turb_max' }
] as const;

function ThresholdEditor({ fish, onSaved }: { fish: Fish; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const value = (key: string) => draft[key] ?? String(fish[key] ?? '');
  const number = (key: string) => value(key).trim() ? Number(value(key)) : NaN;
  const changed = Object.keys(draft).filter(key => value(key) !== String(fish[key] ?? '') &&
    (!String(fish[key] ?? '').trim() || number(key) !== Number(fish[key])));
  const field = (key: string, label: string, step = '0.01') => <label>{label}
    <input type="number" step={step} min="0" value={value(key)} onChange={e => { setDraft(before => ({ ...before, [key]: e.target.value })); setMessage(null); }} />
  </label>;
  const configured = Number.isSafeInteger(Number(fish.id)) && Number(fish.id) > 0;
  return <section className="admin-panel admin-threshold-card">
    <header className="admin-section-heading"><h2>{fish.name}</h2>{fish.validationPending && <AdminBadge tone="warning">Validation pending</AdminBadge>}</header>
    {!configured ? <p className="admin-muted">No editable ranges are configured for this species.</p> : <form noValidate onSubmit={async e => {
      e.preventDefault();
      if (busy || !changed.length) return;
      const invalid = ranges.find(({ min, max }) => (changed.includes(min) || changed.includes(max)) &&
        (!Number.isFinite(number(min)) || !Number.isFinite(number(max)) || number(min) < 0 || number(min) >= number(max)));
      if (invalid) { setMessage({ error: true, text: `${invalid.label}: enter a nonnegative minimum and a higher maximum.` }); return; }
      if (changed.includes('max_ammonia') && (!Number.isFinite(number('max_ammonia')) || number('max_ammonia') <= 0)) {
        setMessage({ error: true, text: 'Enter a positive maximum ammonia value.' }); return;
      }
      setBusy(true); setMessage(null);
      const r = await apiJson(`/api/admin/thresholds/${fish.id}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(changed.map(key => [key, number(key)]))) });
      if (!r.error) { await onSaved(); setDraft({}); }
      setMessage({ error: !!r.error, text: r.error || `Thresholds saved for ${fish.name}.` }); setBusy(false);
    }}>
      <fieldset disabled={busy} className="admin-threshold-fields">
        <div className="admin-threshold-grid">{ranges.map(range => <fieldset key={range.label} className="admin-range-pair">
          <legend>{range.label}</legend>{field(range.min, 'Minimum')}{field(range.max, 'Maximum')}
        </fieldset>)}</div>
        <details className="admin-advanced"><summary>Advanced</summary><div>{field('max_ammonia', 'Maximum ammonia (mg/L)', '0.0001')}</div></details>
        <button type="submit" className="primary-button" disabled={!changed.length || busy}><Save size={16} aria-hidden="true" /> {busy ? 'Saving...' : 'Save Thresholds'}</button>
      </fieldset>
      {message && <p role={message.error ? 'alert' : 'status'} className="admin-notice" data-tone={message.error ? 'warning' : 'good'}>{message.text}</p>}
    </form>}
  </section>;
}

function TurbidityProposalEditor() {
  const endpoint = '/api/admin/turbidity-alert-rule';
  const resource = useAdminResource<{ rule: TurbidityAlertRule }>(endpoint);
  const rule = resource.data?.rule;
  const [draft, setDraft] = useState<Partial<Record<'warningFrom' | 'criticalAbove', string>>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const fieldValue = (key: 'warningFrom' | 'criticalAbove') => draft[key] ?? String(rule?.[key] ?? '');
  return <section className="admin-panel admin-threshold-card" aria-labelledby="turbidity-proposal-heading">
    <header className="admin-section-heading"><h2 id="turbidity-proposal-heading">Turbidity alert proposal</h2><AdminBadge tone="warning">Pending approval</AdminBadge></header>
    <p className="admin-muted">Preview only until approved by the administrator and an expert. Not a DENR or LLDA standard.</p>
    <AdminLoad resource={resource} />
    {rule && <form onSubmit={async e => {
      e.preventDefault();
      const thresholds = parseTurbidityThresholds({ warningFrom: Number(fieldValue('warningFrom')), criticalAbove: Number(fieldValue('criticalAbove')) });
      if (!thresholds) { setMessage({ error: true, text: 'Enter two increasing thresholds above zero, up to 1000 NTU.' }); return; }
      setBusy(true); setMessage(null);
      const result = await apiJson<{ rule: TurbidityAlertRule }>(endpoint, { method: 'PATCH', body: JSON.stringify(thresholds) });
      if (!result.error) { await resource.refresh(); setDraft({}); }
      setMessage({ error: !!result.error, text: result.error || 'Proposal saved. Approval is still pending.' }); setBusy(false);
    }}>
      <fieldset disabled={busy} className="admin-threshold-fields">
        <fieldset className="admin-range-pair">
          <legend>Proposed boundaries (NTU)</legend>
          {([['warningFrom', 'Warning from (inclusive)'], ['criticalAbove', 'Critical above']] as const).map(([key, label]) => <label key={key}>{label}
            <input type="number" min="0.01" max="1000" step="0.01" required value={fieldValue(key)} onChange={e => {
              setDraft(previous => ({ ...previous, [key]: e.target.value })); setMessage(null);
            }} />
          </label>)}
        </fieldset>
        <p className="admin-muted">Safe: 0 to below {rule.warningFrom} NTU. Warning: {rule.warningFrom} to {rule.criticalAbove} NTU. Critical: above {rule.criticalAbove} NTU.</p>
        <button type="submit" className="primary-button" disabled={!Object.keys(draft).length || busy}><Save size={16} aria-hidden="true" /> {busy ? 'Saving...' : 'Save proposal'}</button>
      </fieldset>
    </form>}
    {message && <p role={message.error ? 'alert' : 'status'} className="admin-notice" data-tone={message.error ? 'warning' : 'good'}>{message.text}</p>}
    {rule && <TurbidityCalculator lang="en" rule={rule} />}
  </section>;
}

export function AdminThresholds() {
  const resource = useAdminResource<{ fish: Fish[] }>('/api/admin/thresholds');
  const [selected, setSelected] = useState<string>(activeSpecies[0].id);
  const species = activeSpecies.find(fish => fish.id === selected);
  const fish = resource.data?.fish.find(row => speciesId(row.name) === selected);
  const label = (name: string) => name === 'Bangus (Milkfish)' ? 'Bangus' : name;
  return <>
    <AdminHeading title="Thresholds" caption="Fish suitability ranges"><AdminRefresh busy={resource.busy} refresh={resource.refresh} /></AdminHeading>
    <label className="admin-species-select">Fish species
      <select aria-label="Fish species" value={selected} onChange={event => setSelected(event.target.value)}>
        {activeSpecies.map(item => <option value={item.id} key={item.id}>{label(item.name)}</option>)}
      </select>
    </label>
    <AdminLoad resource={resource} />
    {resource.data && (fish ? <ThresholdEditor key={fish.id} fish={fish} onSaved={resource.refresh} /> :
      <p className="admin-empty">No editable ranges are configured for {species ? label(species.name) : 'this species'}.</p>)}
    <TurbidityProposalEditor />
  </>;
}
