import { useState } from 'react';
import { Save } from 'lucide-react';
import { apiJson } from '../lib/api';
import { confirmAction, showErrorToast, showSuccessToast, showWarningToast } from '../lib/actionAlerts';
import { activeSpecies, speciesId } from '../data/fish';
import { AdminBadge, AdminHeading, AdminLoad, AdminRefresh, useAdminResource } from './AdminControls';

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
      if (invalid) {
        const text = `${invalid.label}: enter a nonnegative minimum and a higher maximum.`;
        setMessage({ error: true, text });
        void showWarningToast(text);
        return;
      }
      const labels = Object.fromEntries(ranges.flatMap(({ label, min, max }) => [[min, `${label} minimum`], [max, `${label} maximum`]]));
      const summary = changed.map(key => `${labels[key]}: ${fish[key] ?? 'Not set'} to ${number(key)}`);
      const source = (e.nativeEvent as SubmitEvent).submitter ?? e.currentTarget;
      setBusy(true);
      try {
        if (!await confirmAction({ source, title: `Save thresholds for ${fish.name}?`, text: summary.join('\n'), label: 'Save thresholds' })) return;
        setMessage(null);
        const r = await apiJson(`/api/admin/thresholds/${fish.id}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(changed.map(key => [key, number(key)]))) });
        if (r.error) {
          setMessage({ error: true, text: r.error });
          void showErrorToast('Threshold save not confirmed.');
        } else {
          await onSaved(); setDraft({});
          void showSuccessToast(`Thresholds saved for ${fish.name}.`);
        }
      } finally { setBusy(false); }
    }}>
      <fieldset disabled={busy} className="admin-threshold-fields">
        <div className="admin-threshold-grid">{ranges.map(range => <fieldset key={range.label} className="admin-range-pair">
          <legend>{range.label}</legend>{field(range.min, 'Minimum')}{field(range.max, 'Maximum')}
        </fieldset>)}</div>
        <button type="submit" className="primary-button" disabled={!changed.length || busy}><Save size={16} aria-hidden="true" /> {busy ? 'Saving...' : 'Save Thresholds'}</button>
      </fieldset>
      {message && <p role={message.error ? 'alert' : 'status'} className="admin-notice" data-tone={message.error ? 'warning' : 'good'}>{message.text}</p>}
    </form>}
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
  </>;
}
