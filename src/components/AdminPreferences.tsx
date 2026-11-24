import { useState } from 'react';
import { Save, TriangleAlert } from 'lucide-react';
import { apiJson } from '../lib/api';
import { AdminDeviceSettings } from './AdminDeviceSecurity';
import type { AdminAccount } from './AdminWorkspace';
import { AdminBadge, AdminDetails, AdminHeading, AdminLoad, AdminRefresh, useAdminResource } from './AdminControls';

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

export function AdminThresholds() {
  const resource = useAdminResource<{ fish: Fish[] }>('/api/admin/thresholds');
  return <>
    <AdminHeading title="Fish Threshold Management" caption="Species suitability ranges, separate from environmental references and SMS rules"><AdminRefresh busy={resource.busy} refresh={resource.refresh} /></AdminHeading>
    <AdminLoad resource={resource} />
    {resource.data && (resource.data.fish.length ? resource.data.fish.map(fish => <ThresholdEditor key={fish.id} fish={fish} onSaved={resource.refresh} />) : <p className="admin-empty">No species found.</p>)}
  </>;
}

const dangerActions = {
  clear: { label: 'Clear Logs', code: 'CLEAR_LOGS', endpoint: '/api/admin/logs', detail: 'Permanently deletes saved water analyses, legacy alert records, and corrective-action logs. This does not clear the raw ESP32 upload log or all SMS history.', success: 'Saved analyses, legacy alerts, and corrective-action logs cleared.' },
  reset: { label: 'Factory Reset', code: 'RESET_PONDSENSE', endpoint: '/api/admin/factory-reset', detail: 'Permanently deletes farmer accounts, the same records as Clear Logs, and dependent records tied to deleted accounts. This does not reset the entire database to a clean installation.', success: 'Factory reset completed.' }
} as const;

export function AdminSettings({ admin, navigate }: { admin: AdminAccount; navigate: (path: string) => void }) {
  const [pin, setPin] = useState('');
  const [action, setAction] = useState<keyof typeof dangerActions | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [pinMessage, setPinMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [dangerMessage, setDangerMessage] = useState<{ error: boolean; text: string } | null>(null);
  const danger = action && dangerActions[action];
  const closeDanger = () => { if (!resetting) { setAction(null); setConfirmation(''); } };
  return <>
    <AdminHeading title="Settings" caption="Administrator profile and security" />
    <section className="admin-panel"><h2>Administrator profile</h2><dl className="admin-definition">
      <div><dt>Name</dt><dd>{admin.fullName}</dd></div><div><dt>Username</dt><dd>{admin.username || '\u2014'}</dd></div>
      <div><dt>Email</dt><dd>{admin.email || '\u2014'}</dd></div><div><dt>Role</dt><dd>Administrator</dd></div>
    </dl></section>
    <section className="admin-panel"><h2>Admin PIN</h2><form className="admin-form-grid" onSubmit={async e => {
      e.preventDefault();
      if (busy) return;
      setBusy(true); setPinMessage(null);
      const r = await apiJson('/api/admin/settings/pin', { method: 'POST', body: JSON.stringify({ pin }) });
      if (!r.error) setPin('');
      setPinMessage({ error: !!r.error, text: r.error || 'Admin PIN updated.' }); setBusy(false);
    }}>
      <label>New admin PIN<input required minLength={4} type="password" autoComplete="new-password" value={pin} onChange={e => setPin(e.target.value)} /></label>
      <button type="submit" className="primary-button" disabled={busy}>Change Admin PIN</button>
    </form>{pinMessage && <p role={pinMessage.error ? 'alert' : 'status'} className="admin-notice" data-tone={pinMessage.error ? 'warning' : 'good'}>{pinMessage.text}</p>}
      <button type="button" className="soft-button" onClick={() => navigate('/admin/login')}>Go to Admin Login</button>
    </section>
    <AdminDeviceSettings />
    <section className="admin-panel admin-danger"><h2><TriangleAlert size={18} aria-hidden="true" /> Danger Zone</h2>
      {Object.entries(dangerActions).map(([key, item]) => <div className="admin-danger-row" key={key}>
        <div><strong>{item.label}</strong><p className="admin-muted">{item.detail}</p></div>
        <button type="button" className="admin-danger-button" onClick={() => { setDangerMessage(null); setConfirmation(''); setAction(key as keyof typeof dangerActions); }}>{item.label}</button>
      </div>)}
      {!danger && dangerMessage && <p role={dangerMessage.error ? 'alert' : 'status'} className="admin-notice" data-tone={dangerMessage.error ? 'warning' : 'good'}>{dangerMessage.text}</p>}
    </section>
    {danger && <AdminDetails title={danger.label} close={closeDanger} locked={resetting}>
      <p>{danger.detail}</p>
      <form className="admin-confirm-form" onSubmit={async e => {
        e.preventDefault();
        if (confirmation !== danger.code || resetting) return;
        setResetting(true); setDangerMessage(null);
        const r = await apiJson(`${danger.endpoint}?confirm=${danger.code}`, { method: 'DELETE' });
        setResetting(false);
        setDangerMessage({ error: !!r.error, text: r.error || danger.success });
        if (!r.error) { setAction(null); setConfirmation(''); }
      }}>
        <label>Type {danger.code} to confirm<input value={confirmation} autoComplete="off" spellCheck={false} disabled={resetting} onChange={e => setConfirmation(e.target.value)} /></label>
        {dangerMessage && <p role="alert" className="admin-action-error">{dangerMessage.text}</p>}
        <div className="admin-actions"><button type="button" className="soft-button" disabled={resetting} onClick={closeDanger}>Cancel</button>
          <button type="submit" className="admin-danger-button" disabled={resetting || confirmation !== danger.code}>{resetting ? 'Working...' : `Confirm ${danger.label}`}</button></div>
      </form>
    </AdminDetails>}
  </>;
}
