import { useState } from 'react';
import { KeyRound, Link2, Plus, Unlink2 } from 'lucide-react';
import { apiJson } from '../lib/api';
import { confirmAction } from '../lib/actionAlerts';
import { AdminBadge, AdminDetails, AdminHeading, AdminLoad, AdminRefresh, AdminTable, DeviceKeyOnce, adminTime, useAdminResource } from './AdminControls';
import { DeviceRecords } from './AdminRecords';

export type HardwareRow = {
  id: number; chipId: string; name: string; farmer: string | null; fishpen: string | null;
  assignmentId: string | null; lastUpload: string | null; credentialDeviceId: number; active: number;
  status: 'Online' | 'Offline' | 'Never Connected' | 'Unassigned' | 'Paused';
};
type Target = { ownerId: number; farmer: string; fishpenId: number; fishpen: string };
type IssuedKey = { hardwareId: number; deviceKey: string };

export function SharedHardware() {
  const resource = useAdminResource<{ hardware: HardwareRow[]; uploadsEnabled: boolean }>('/api/admin/hardware', 15_000);
  const [registering, setRegistering] = useState(false);
  const [assigning, setAssigning] = useState<HardwareRow | null>(null);
  const [history, setHistory] = useState<HardwareRow | null>(null);
  const [key, setKey] = useState<IssuedKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function change(row: HardwareRow, action: 'unassign' | 'key', source: HTMLElement) {
    if (busy) return;
    const unassign = action === 'unassign';
    const assignment = row.farmer ? `Assigned to ${row.farmer}${row.fishpen ? ` / ${row.fishpen}` : ''}.` : 'No farmer assigned.';
    setBusy(true);
    try {
      if (!await confirmAction({
        source, title: unassign ? `Unassign ${row.name}?` : `Replace the key for ${row.name}?`,
        text: `${assignment}\n${unassign ? 'Uploads stop until the board is assigned again.' : 'The current key stops working. Update the ESP32 with the new key to resume uploads.'}`,
        label: unassign ? 'Unassign hardware' : 'Replace key', danger: true
      })) return;
      setMessage('');
      const result = await apiJson<IssuedKey>(`/api/admin/hardware/${row.id}/${action}`, {
        method: 'POST', body: JSON.stringify(unassign ? { assignmentId: row.assignmentId } : {})
      });
      if (result.data?.deviceKey) setKey(result.data);
      else setMessage(result.error || (unassign ? 'Hardware unassigned.' : 'Key replacement not confirmed.'));
      void resource.refresh();
    } finally { setBusy(false); }
  }
  return <>
    <AdminHeading title="ESP32 Devices">
      <div className="admin-actions">
        <AdminRefresh busy={resource.busy} refresh={resource.refresh} />
        <button type="button" className="primary-button" onClick={() => setRegistering(true)}><Plus size={16} aria-hidden="true" /> Register Hardware</button>
      </div>
    </AdminHeading>
    {message && <p role="status">{message}</p>}
    {resource.data?.uploadsEnabled === false && <p className="admin-muted">Shared uploads are paused. Existing monitors keep their current farmer assignments.</p>}
    <section className="admin-panel">
      <AdminLoad resource={resource} />
      {resource.data && <AdminTable label="Registered hardware" headings={['Hardware name', 'ESP32 Hardware ID', 'Assigned farmer', 'Assigned fishpen', 'Connection status', 'Last successful upload', 'Actions']}
        empty="No physical hardware registered yet." rows={resource.data.hardware.map(row => ({ id: row.id, cells: [
          <button type="button" className="admin-detail-link" onClick={() => setHistory(row)}>{row.name}</button>, row.chipId,
          row.farmer ?? 'Unassigned', row.fishpen ?? 'Unassigned',
          <AdminBadge tone={row.status === 'Online' ? 'good' : row.status === 'Offline' ? 'warning' : 'neutral'}>{resource.error ? 'Unavailable' : row.status}</AdminBadge>,
          adminTime(row.lastUpload) ?? 'None for current assignment',
          <div className="admin-actions">
            {row.assignmentId
              ? <button type="button" className="soft-button" disabled={busy || !!resource.error} onClick={event => void change(row, 'unassign', event.currentTarget)}><Unlink2 size={15} aria-hidden="true" /> Unassign Hardware</button>
              : <button type="button" className="soft-button" disabled={busy || !!resource.error || !row.active} onClick={() => setAssigning(row)}><Link2 size={15} aria-hidden="true" /> Assign Hardware</button>}
            <button type="button" className="soft-button" disabled={busy || !!resource.error} onClick={event => void change(row, 'key', event.currentTarget)}><KeyRound size={15} aria-hidden="true" /> Replace Key</button>
          </div>
        ] }))} />}
    </section>
    {registering && <Registration allowAdoption={resource.data?.uploadsEnabled === true} close={() => setRegistering(false)} onSave={issued => {
      setRegistering(false); if (issued.deviceKey) setKey(issued); else setMessage('Existing board registered. Its hardware key is unchanged.');
      void resource.refresh();
    }} />}
    {assigning && <Assignment row={assigning} close={() => setAssigning(null)} onSave={() => {
      setAssigning(null); setMessage(resource.data?.uploadsEnabled === false
        ? 'Assignment saved. Shared uploads are paused.' : 'Hardware assigned. Waiting for its first upload at this fishpen.'); void resource.refresh();
    }} />}
    {history && <AdminDetails title={history.name} close={() => setHistory(null)}><DeviceRecords deviceId={history.credentialDeviceId} /></AdminDetails>}
    {key && <AdminDetails title="One-time hardware key" close={() => setKey(null)}><DeviceKeyOnce deviceId={key.hardwareId} value={key.deviceKey} label="Hardware" /></AdminDetails>}
  </>;
}

function Registration({ allowAdoption, close, onSave }: { allowAdoption: boolean; close: () => void; onSave: (result: IssuedKey) => void }) {
  const [name, setName] = useState('');
  const [chip, setChip] = useState('');
  const [legacy, setLegacy] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <AdminDetails title="Register Hardware" close={close} locked={busy}>
    <form className="admin-form-grid" onSubmit={async event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError('');
      const result = await apiJson<IssuedKey>('/api/admin/hardware', { method: 'POST', body: JSON.stringify({
        name, chipId: chip.trim(), legacyDeviceId: legacy ? Number(legacy) : undefined, verifiedPhysicalBoard: verified
      }) });
      setBusy(false);
      if (result.data) onSave(result.data); else setError(result.error || 'Registration not confirmed.');
    }}>
      <label>Hardware name<input required maxLength={100} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>ESP32 Hardware ID<input required maxLength={12} pattern="[0-9A-Fa-f]{1,12}" autoComplete="off" spellCheck={false} disabled={busy} value={chip} onChange={event => setChip(event.target.value)} /></label>
      {allowAdoption && <label>Existing credential ID (optional)<input type="number" min="1" step="1" disabled={busy} value={legacy} onChange={event => setLegacy(event.target.value)} /></label>}
      {legacy && <label className="hardware-check"><input type="checkbox" required disabled={busy} checked={verified} onChange={event => setVerified(event.target.checked)} /> I verified this physical board against the existing credential’s upload.</label>}
      <button type="submit" className="primary-button" disabled={busy || (!!legacy && !verified)}>Register</button>
    </form>
    {error && <p role="alert" className="admin-action-error">{error}</p>}
  </AdminDetails>;
}

function Assignment({ row, close, onSave }: { row: HardwareRow; close: () => void; onSave: () => void }) {
  const targets = useAdminResource<{ fishpens: Target[] }>('/api/admin/hardware/fishpens');
  const [selected, setSelected] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <AdminDetails title={`Assign ${row.name}`} close={close} locked={busy}>
    <AdminLoad resource={targets} />
    <form className="admin-form-grid" onSubmit={async event => {
      event.preventDefault();
      const pen = targets.data?.fishpens.find(item => String(item.fishpenId) === selected);
      if (!pen || !confirmed || busy || targets.error) return;
      setBusy(true); setError('');
      const result = await apiJson(`/api/admin/hardware/${row.id}/assign`, { method: 'POST', body: JSON.stringify({
        ownerId: pen.ownerId, fishpenId: pen.fishpenId, confirmedMoved: confirmed
      }) });
      setBusy(false);
      if (!result.error) onSave(); else setError(result.error);
    }}>
      <label>Farmer and fishpen<select required disabled={busy || !targets.data} value={selected} onChange={event => { setSelected(event.target.value); setConfirmed(false); }}>
        <option value="">Select fishpen</option>
        {targets.data?.fishpens.map(pen => <option key={pen.fishpenId} value={pen.fishpenId}>{pen.farmer} / {pen.fishpen}</option>)}
      </select></label>
      <label className="hardware-check"><input type="checkbox" required disabled={!selected || busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
        The board and probes are physically at this fishpen.</label>
      <button type="submit" className="primary-button" disabled={!confirmed || busy || !!targets.error}>Activate assignment</button>
    </form>
    {error && <p role="alert" className="admin-action-error">{error}</p>}
  </AdminDetails>;
}
