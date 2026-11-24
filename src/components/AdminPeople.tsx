import { useState } from 'react';
import { Eye, KeyRound, Radio } from 'lucide-react';
import { apiJson } from '../lib/api';
import { AdminFishpenAssignments } from './AdminFishpenAssignments';
import { ProvisionOwner } from './ProvisionOwner';
import { DeviceRecords, FarmerRecords } from './AdminRecords';
import { AdminBadge, AdminDetails, AdminHeading, AdminLoad, AdminRefresh, AdminTable, DeviceKeyOnce, adminTime, useAdminResource } from './AdminControls';
import type { AdminAccount } from './AdminWorkspace';

const missing = '\u2014';
type Message = { text: string; error: boolean };
function ActionMessage({ message }: { message: Message | null }) {
  return message && <p role={message.error ? 'alert' : 'status'} className="admin-notice" data-tone={message.error ? 'warning' : 'good'}>{message.text}</p>;
}

export function AdminUsers({ openCreate }: { openCreate: boolean }) {
  const users = useAdminResource<{ users: AdminAccount[] }>('/api/admin/users');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [password, setPassword] = useState<{ name: string; value: string } | null>(null);
  const query = search.trim().toLowerCase();
  const accounts = users.data?.users.filter(row => row.role === 'farmer' && row.phone !== '+639000000000') ?? [];
  const shown = accounts.filter(row => [row.fullName, row.fishpenName, row.phone, row.accountStatus, row.deviceId && `#${row.deviceId}`].join(' ').toLowerCase().includes(query));
  const owner = accounts.find(row => row.id === selected);
  const changeStatus = async (row: AdminAccount, status: 'ACTIVE' | 'SUSPENDED') => {
    if (!window.confirm(`${status === 'ACTIVE' ? 'Reactivate' : 'Suspend'} ${row.fullName}? This changes account access, not saved records.`)) return;
    setBusy(true); setMessage(null);
    const r = await apiJson(`/api/admin/users/${row.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    if (!r.error) await users.refresh();
    setMessage({ text: r.error || `Account ${status === 'ACTIVE' ? 'reactivated' : 'suspended'}.`, error: !!r.error });
    setBusy(false);
  };
  const resetPassword = async (row: AdminAccount) => {
    if (!window.confirm(`Reset the password for ${row.fullName}? Existing sessions will be invalidated.`)) return;
    setBusy(true); setMessage(null); setPassword(null);
    const r = await apiJson<{ temporaryPassword: string }>(`/api/admin/owners/${row.id}/reset-password`, { method: 'POST', body: '{}' });
    if (r.data) { setSelected(null); setPassword({ name: row.fullName, value: r.data.temporaryPassword }); }
    else setMessage({ text: r.error || 'Could not confirm password reset.', error: true });
    setBusy(false);
  };
  const statusBadge = (status?: AdminAccount['accountStatus']) => <AdminBadge tone={status === 'ACTIVE' ? 'good' : status === 'SUSPENDED' ? 'warning' : 'neutral'}>{status ? `${status[0]}${status.slice(1).toLowerCase()}` : 'Unknown'}</AdminBadge>;
  return <>
    <AdminHeading title="Users"><AdminRefresh busy={users.busy} refresh={users.refresh} /></AdminHeading>
    <ProvisionOwner onSaved={users.refresh} initiallyOpen={openCreate} />
    {!owner && <ActionMessage message={message} />}
    <section className="admin-panel">
      <header className="admin-section-heading">
        <h2>Farmer accounts</h2>
        <input type="search" aria-label="Search users" placeholder="Search users" value={search} onChange={e => setSearch(e.target.value)} />
      </header>
      <AdminLoad resource={users} />
      {users.data && <AdminTable label="Farmer accounts" headings={['Farmer name', 'Fishpen', 'Mobile number', 'Status', 'Details']} empty="No farmer accounts match."
        rows={shown.map(row => ({ id: row.id, cells: [<strong>{row.fullName}</strong>, row.fishpenName || 'Unassigned', row.phone || missing, statusBadge(row.accountStatus),
          <button type="button" className="soft-button" onClick={() => { setSelected(row.id); setMessage(null); }}><Eye size={15} aria-hidden="true" /> View</button>] }))} />}
    </section>
    {owner && <AdminDetails title={owner.fullName} close={() => setSelected(null)} locked={busy}><dl className="admin-definition">
      <div><dt>Fishpen</dt><dd>{owner.fishpenName || 'Unassigned'}</dd></div>
      <div><dt>Mobile number</dt><dd>{owner.phone || missing}</dd></div>
      <div><dt>Account status</dt><dd>{statusBadge(owner.accountStatus)}</dd></div>
      <div><dt>Assigned ESP32</dt><dd>{owner.deviceId ? `#${owner.deviceId}` : 'Unassigned'}</dd></div>
      <div><dt>Created</dt><dd>{adminTime(owner.createdAt) || missing}</dd></div>
    </dl>
      <div className="admin-actions">
        {owner.accountStatus && <button type="button" className="soft-button" disabled={busy || !!users.error} onClick={() => void changeStatus(owner, owner.accountStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE')}>{owner.accountStatus === 'ACTIVE' ? 'Suspend account' : 'Reactivate account'}</button>}
        <button type="button" className="soft-button" disabled={busy || !!users.error} onClick={() => void resetPassword(owner)}><KeyRound size={15} aria-hidden="true" /> Reset password</button>
      </div>
      <ActionMessage message={message} />
      <FarmerRecords ownerId={owner.id} />
    </AdminDetails>}
    {password && <AdminDetails title="Temporary password" close={() => setPassword(null)}>
      <p className="admin-muted">For {password.name}. Expires in 24 hours. Share privately.</p><code className="admin-secret">{password.value}</code>
      <button type="button" className="soft-button" onClick={() => setPassword(null)}>Hide password</button>
    </AdminDetails>}
  </>;
}

type Connection = 'online' | 'offline' | 'never' | 'inactive';
type Device = {
  id: number; device_name: string; owner_user_id: number | null; owner_name: string | null; is_active: number | boolean;
  current_upload_at: string | null; last_reading_at: string | null; last_seen_at: string | null;
  monitoring_fishpen_id: number | null; fishpen_name: string | null; connection: Connection;
};
const connectionLabels = { online: 'Online', offline: 'Offline', never: 'Never uploaded', inactive: 'Inactive' };
const deviceStatus = (row: Device, stale: boolean) => stale || !row.connection ? <AdminBadge>Unknown</AdminBadge> :
  <AdminBadge tone={row.connection === 'online' ? 'good' : row.connection === 'offline' ? 'warning' : 'neutral'}>{connectionLabels[row.connection]}</AdminBadge>;

export function AdminDevices() {
  const resource = useAdminResource<{ devices: Device[]; freshnessSeconds: number }>('/api/admin/devices', 15_000);
  const [assignmentVersion, setAssignmentVersion] = useState(0);
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Connection | ''>('');
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [replacement, setReplacement] = useState<{ deviceId: number; deviceKey: string } | null>(null);
  const rows = resource.data?.devices ?? [];
  const shown = rows.filter(row => (!filter || (!resource.error && row.connection === filter)) &&
    [`#${row.id}`, row.device_name, row.owner_name, row.fishpen_name].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  const selectedDevice = rows.find(row => row.id === selected);
  const assignMonitor = async (row: Device) => {
    if (!row.owner_user_id || !window.confirm(`Use ESP32 #${row.id} for ${row.owner_name}'s assigned fishpen? Other active keys for this owner will be disabled. Past records are kept.`)) return;
    setBusy(true); setMessage(null);
    const r = await apiJson(`/api/admin/owners/${row.owner_user_id}/monitoring-device`, { method: 'PUT', body: JSON.stringify({ deviceId: row.id }) });
    setMessage({ text: r.error || `ESP32 #${row.id} is now the fishpen monitor.`, error: !!r.error });
    if (!r.error) { await resource.refresh(); setAssignmentVersion(n => n + 1); }
    setBusy(false);
  };
  const replaceKey = async (row: Device) => {
    if (!row.owner_user_id || !window.confirm(`Replace the key for ESP32 #${row.id}? The old key will stop working immediately.`)) return;
    setBusy(true); setMessage(null);
    const r = await apiJson<{ deviceId: number; deviceKey: string }>(`/api/admin/owners/${row.owner_user_id}/device-key`, { method: 'POST', body: JSON.stringify({ expectedDeviceId: row.id }) });
    if (r.data) { setReplacement(r.data); await resource.refresh(); }
    else setMessage({ text: r.error || 'Could not confirm key replacement. Check the device before retrying.', error: true });
    setBusy(false);
  };
  return <>
    <AdminHeading title="ESP32 Devices"><AdminRefresh busy={resource.busy} refresh={resource.refresh} /></AdminHeading>
    {!selectedDevice && <ActionMessage message={message} />}
    <section className="admin-panel">
      <header className="admin-section-heading admin-filters">
        <input type="search" aria-label="Search devices" placeholder="Search devices" value={search} onChange={e => setSearch(e.target.value)} />
        <select aria-label="Filter by connection" value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option value="">All connections</option>{Object.entries(connectionLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      </header>
      <AdminLoad resource={resource} />
      {resource.data && <AdminTable label="ESP32 devices" headings={['ESP32 Device ID', 'Assigned farmer', 'Assigned fishpen', 'Connection status', 'Last successful upload', 'Key']} empty="No devices match."
        rows={shown.map(row => ({ id: row.id, cells: [
          <button type="button" className="admin-detail-link" aria-label={`View ESP32 #${row.id}`} onClick={() => { setSelected(row.id); setMessage(null); }}>#{row.id}</button>,
          row.owner_name || 'Unassigned', row.fishpen_name || 'Unassigned', deviceStatus(row, !!resource.error), adminTime(row.current_upload_at) || missing,
          row.owner_user_id && Number(row.is_active) === 1 && row.monitoring_fishpen_id
            ? <button type="button" className="soft-button" disabled={busy || !!resource.error} onClick={() => void replaceKey(row)}><KeyRound size={15} aria-hidden="true" /> Replace key</button>
            : missing
        ] }))} />}
    </section>
    <details className="admin-panel admin-assignments" onToggle={event => setAssignmentsOpen(event.currentTarget.open)}>
      <summary>Fishpen assignments</summary>
      {assignmentsOpen && <AdminFishpenAssignments key={assignmentVersion} onSaved={resource.refresh} />}
    </details>
    {selectedDevice && <AdminDetails title={`ESP32 #${selectedDevice.id}`} close={() => setSelected(null)} locked={busy}><dl className="admin-definition">
      <div><dt>Name</dt><dd>{selectedDevice.device_name}</dd></div><div><dt>Farmer</dt><dd>{selectedDevice.owner_name || 'Unassigned'}</dd></div>
      <div><dt>Fishpen</dt><dd>{selectedDevice.fishpen_name || 'Unassigned'}</dd></div><div><dt>Connection</dt><dd>{deviceStatus(selectedDevice, !!resource.error)}</dd></div>
      <div><dt>Last successful upload</dt><dd>{adminTime(selectedDevice.current_upload_at) || missing}</dd></div>
    </dl>
      {!!selectedDevice.owner_user_id && Number(selectedDevice.is_active) === 1 && !selectedDevice.monitoring_fishpen_id &&
        <button type="button" className="soft-button" disabled={busy || !!resource.error} onClick={() => void assignMonitor(selectedDevice)}><Radio size={15} aria-hidden="true" /> Use as fishpen monitor</button>}
      <ActionMessage message={message} />
      <DeviceRecords deviceId={selectedDevice.id} />
    </AdminDetails>}
    {replacement && <AdminDetails title="Replacement device key" close={() => setReplacement(null)}>
      <p className="admin-muted">The old key no longer works. Update this ESP32 with the new key before it can upload again.</p>
      <DeviceKeyOnce deviceId={replacement.deviceId} value={replacement.deviceKey} />
      <button type="button" className="soft-button" onClick={() => setReplacement(null)}>Hide key</button>
    </AdminDetails>}
  </>;
}
