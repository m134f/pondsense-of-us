import { useState } from 'react';
import { Save } from 'lucide-react';
import { apiJson } from '../lib/api';
import { AdminLoad, useAdminResource } from './AdminControls';

type Data = { owners: { id: number; name: string; fishpenId: number | null }[]; fishpens: { id: number; name: string; ownerId: number; deviceId: number | null }[]; devices: { id: number; name: string; ownerId: number }[] };
export function AdminFishpenAssignments({ onSaved }: { onSaved: () => void }) {
  const resource = useAdminResource<Data>('/api/admin/fishpen-assignments');
  const { data } = resource;
  const [owner, setOwner] = useState('');
  const [pen, setPen] = useState('');
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const choosePen = (id: string) => { const row = data?.fishpens.find(item => String(item.id) === id); setPen(id); setName(row?.name || ''); setDevice(row?.deviceId ? String(row.deviceId) : ''); };
  return <div>
    <AdminLoad resource={resource} />
    <form onSubmit={async e => {
      e.preventDefault();
      if (busy || resource.error) return;
      setBusy(true); setMessage(null);
      const r = await apiJson(`/api/admin/fishpen-assignments/${owner}`, { method: 'PUT', body: JSON.stringify({ fishpenId: pen ? Number(pen) : null, name, deviceId: device ? Number(device) : null }) });
      if (!r.error) {
        // Do not leave "create" selected after a successful save.
        setOwner(''); choosePen(''); onSaved(); await resource.refresh();
      }
      setMessage({ text: r.error || 'Fishpen assignment saved.', error: !!r.error }); setBusy(false);
    }}>
      <fieldset className="admin-form-grid" disabled={!data || busy || !!resource.error}>
        <label>Farmer<select aria-label="Farmer" required value={owner} onChange={e => { setOwner(e.target.value); const row = data?.owners.find(item => String(item.id) === e.target.value); choosePen(row?.fishpenId ? String(row.fishpenId) : ''); }}><option value="">Choose farmer</option>{data?.owners.map(row => <option key={row.id} value={row.id}>{row.name}{!row.fishpenId ? ' (no assignment)' : ''}</option>)}</select></label>
        <label>Existing fishpen<select disabled={!owner} value={pen} onChange={e => choosePen(e.target.value)}><option value="">Create fishpen for this owner</option>{data?.fishpens.filter(row => row.ownerId === Number(owner)).map(row => <option key={row.id} value={row.id}>{row.name} #{row.id}</option>)}</select></label>
        <label>Fishpen name<input required disabled={!owner} maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Monitoring device<select aria-label="Monitoring device" disabled={!owner} value={device} onChange={e => setDevice(e.target.value)}><option value="">No assigned monitor</option>{device && !data?.devices.some(row => row.id === Number(device) && row.ownerId === Number(owner)) && <option value={device} disabled>#{device} is not active</option>}{data?.devices.filter(row => row.ownerId === Number(owner)).map(row => <option key={row.id} value={row.id}>{row.name} #{row.id}</option>)}</select></label>
        <button className="primary-button" disabled={!owner}><Save size={17} aria-hidden="true" />{busy ? 'Saving...' : 'Save assignment'}</button>
      </fieldset>
    </form>{message && <p role={message.error ? 'alert' : 'status'} className="admin-notice" data-tone={message.error ? 'warning' : 'good'}>{message.text}</p>}
  </div>;
}
