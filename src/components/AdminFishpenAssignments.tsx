import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { apiJson } from '../lib/api';

type Data = { owners: { id: number; name: string; fishpenId: number | null }[]; fishpens: { id: number; name: string; ownerId: number; deviceId: number | null }[]; devices: { id: number; name: string; ownerId: number }[] };
export function AdminFishpenAssignments() {
  const [data, setData] = useState<Data | null>(null);
  const [owner, setOwner] = useState('');
  const [pen, setPen] = useState('');
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => { const r = await apiJson<Data>('/api/admin/fishpen-assignments'); if (r.data) setData(r.data); else setMessage(r.error || 'Unable to load assignments.'); };
  useEffect(() => { void load(); }, []);
  const choosePen = (id: string) => { const row = data?.fishpens.find(item => String(item.id) === id); setPen(id); setName(row?.name || ''); setDevice(row?.deviceId ? String(row.deviceId) : ''); };
  return <section className="card space-y-4 p-5"><h2 className="text-lg font-bold">Owner fishpen assignments</h2><p className="text-sm text-slate-600">One assigned fishpen per owner. Existing records are preserved when the assignment changes.</p>
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={async e => { e.preventDefault(); setBusy(true); setMessage(''); const r = await apiJson(`/api/admin/fishpen-assignments/${owner}`, { method: 'PUT', body: JSON.stringify({ fishpenId: pen ? Number(pen) : null, name, deviceId: device ? Number(device) : null }) }); setMessage(r.error || 'Fishpen assignment saved.'); if (!r.error) await load(); setBusy(false); }}>
      <label>Owner<select required className="mt-2 w-full rounded-md border p-3" value={owner} onChange={e => { setOwner(e.target.value); const row = data?.owners.find(item => String(item.id) === e.target.value); choosePen(row?.fishpenId ? String(row.fishpenId) : ''); }}><option value="">Choose owner</option>{data?.owners.map(row => <option key={row.id} value={row.id}>{row.name}{!row.fishpenId ? ' — no assignment' : ''}</option>)}</select></label>
      <label>Existing fishpen<select disabled={!owner} className="mt-2 w-full rounded-md border p-3" value={pen} onChange={e => choosePen(e.target.value)}><option value="">Create fishpen for this owner</option>{data?.fishpens.filter(row => row.ownerId === Number(owner)).map(row => <option key={row.id} value={row.id}>{row.name} #{row.id}</option>)}</select></label>
      <label>Fishpen name<input required maxLength={100} className="mt-2 w-full rounded-md border p-3" value={name} onChange={e => setName(e.target.value)} /></label>
      <label>Monitoring device<select className="mt-2 w-full rounded-md border p-3" value={device} onChange={e => setDevice(e.target.value)}><option value="">No assigned monitor</option>{data?.devices.filter(row => row.ownerId === Number(owner)).map(row => <option key={row.id} value={row.id}>{row.name} #{row.id}</option>)}</select></label>
      <button className="primary-button" disabled={busy || !owner}><Save size={18}/>{busy ? 'Saving…' : 'Save assignment'}</button>
    </form>{message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
