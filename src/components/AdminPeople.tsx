import { useState } from 'react';
import { Eye, KeyRound } from 'lucide-react';
import { apiJson } from '../lib/api';
import { AdminFishpenAssignments } from './AdminFishpenAssignments';
import { ProvisionOwner } from './ProvisionOwner';
import { AdminBadge, AdminDetails, AdminHeading, AdminLoad, AdminRefresh, AdminTable, DeviceKeyOnce, adminTime, useAdminResource } from './AdminControls';
import type { AdminAccount } from './AdminWorkspace';

const missing = '\u2014';
type Message = { text: string; error: boolean };
function ActionMessage({ message }: { message: Message | null }) {
  return message && <p role={message.error ? 'alert' : 'status'} className="admin-notice" data-tone={message.error ? 'warning' : 'good'}>{message.text}</p>;
}

export function AdminUsers() {
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
    if (r.data) setPassword({ name: row.fullName, value: r.data.temporaryPassword });
    else setMessage({ text: r.error || 'Could not confirm password reset.', error: true });
    setBusy(false);
  };
  const statusBadge = (status?: AdminAccount['accountStatus']) => <AdminBadge tone={status === 'ACTIVE' ? 'good' : status === 'SUSPENDED' ? 'warning' : 'neutral'}>{status ? `${status[0]}${status.slice(1).toLowerCase()}` : 'Unknown'}</AdminBadge>;
  return <>
    <AdminHeading title="Users" caption="Farmer accounts and fishpen access"><AdminRefresh busy={users.busy} refresh={users.refresh} /></AdminHeading>
    <ProvisionOwner onSaved={users.refresh} />
    <ActionMessage message={message} />
    <section className="admin-panel">
      <header className="admin-section-heading">
        <div><h2>Farmer accounts</h2>{users.data && <p className="admin-muted">{shown.length} of {accounts.length} shown</p>}</div>
        <input type="search" aria-label="Search farmer accounts" placeholder="Search accounts" value={search} onChange={e => setSearch(e.target.value)} />
      </header>
      <AdminLoad resource={users} />
      {users.data && <AdminTable label="Farmer accounts" headings={['Farmer name', 'Fishpen', 'Mobile number', 'Account status', 'Assigned ESP32', 'Actions']} empty="No farmer accounts match."
        rows={shown.map(row => ({ id: row.id, cells: [<strong>{row.fullName}</strong>, row.fishpenName || 'Unassigned', row.phone || missing, statusBadge(row.accountStatus), row.deviceId ? `#${row.deviceId}` : 'Unassigned',
          <div className="admin-actions">
            <button type="button" className="soft-button" onClick={() => setSelected(row.id)}><Eye size={15} aria-hidden="true" /> View</button>
            {row.accountStatus && <button type="button" className="soft-button" disabled={busy || !!users.error} onClick={() => void changeStatus(row, row.accountStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE')}>{row.accountStatus === 'ACTIVE' ? 'Suspend' : 'Reactivate'}</button>}
            <button type="button" className="soft-button" disabled={busy || !!users.error} onClick={() => void resetPassword(row)}>Reset password</button>
          </div>] }))} />}
    </section>
    {owner && <AdminDetails title={owner.fullName} close={() => setSelected(null)}><dl className="admin-definition">
      <div><dt>Fishpen</dt><dd>{owner.fishpenName || 'Unassigned'}</dd></div>
      <div><dt>Mobile number</dt><dd>{owner.phone || missing}</dd></div>
      <div><dt>Account status</dt><dd>{statusBadge(owner.accountStatus)}</dd></div>
      <div><dt>Assigned ESP32</dt><dd>{owner.deviceId ? `#${owner.deviceId}` : 'Unassigned'}</dd></div>
      <div><dt>Created</dt><dd>{adminTime(owner.createdAt) || missing}</dd></div>
    </dl></AdminDetails>}
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
const credentialStatus = (row: Device, stale: boolean) => stale ? 'Unknown' : Number(row.is_active) === 1 ? 'Enabled' : 'Disabled';

export function AdminDevices() {
  const resource = useAdminResource<{ devices: Device[]; freshnessSeconds: number }>('/api/admin/devices', 15_000);
  const [assignmentVersion, setAssignmentVersion] = useState(0);
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
    <AdminHeading title="ESP32 Devices" caption="Connectivity, fishpen assignments, and credentials"><AdminRefresh busy={resource.busy} refresh={resource.refresh} /></AdminHeading>
    <ActionMessage message={message} />
    <section className="admin-panel">
      <header className="admin-section-heading"><div><h2>Sensor devices</h2>{resource.data && <p className="admin-muted">Online window: {resource.data.freshnessSeconds} seconds from a valid sample.</p>}</div>
        <div className="admin-filters"><input type="search" aria-label="Search devices" placeholder="Search devices" value={search} onChange={e => setSearch(e.target.value)} />
          <select aria-label="Connection status" value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option value="">All connections</option>{Object.entries(connectionLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        </div>
      </header>
      <AdminLoad resource={resource} />
      {resource.data && <AdminTable label="ESP32 devices" headings={['Device ID', 'Assigned farmer', 'Assigned fishpen', 'Last successful upload', 'Connection', 'Credential', 'Actions']} empty="No devices match."
        rows={shown.map(row => ({ id: row.id, cells: [<><strong>#{row.id}</strong><span className="admin-secondary-line">{row.device_name}</span></>, row.owner_name || 'Unassigned', row.fishpen_name || 'Unassigned', adminTime(row.current_upload_at) || missing,
          deviceStatus(row, !!resource.error), credentialStatus(row, !!resource.error), <div className="admin-actions">
            <button type="button" className="soft-button" onClick={() => setSelected(row.id)}><Eye size={15} aria-hidden="true" /> View details</button>
            {row.owner_user_id && Number(row.is_active) === 1 && (row.monitoring_fishpen_id ? <button type="button" className="soft-button" disabled={busy || !!resource.error} onClick={() => void replaceKey(row)}><KeyRound size={15} aria-hidden="true" /> Replace key</button> :
              <button type="button" className="soft-button" disabled={busy || !!resource.error} onClick={() => void assignMonitor(row)}>Assign device</button>)}
          </div>] }))} />}
    </section>
    <AdminFishpenAssignments key={assignmentVersion} onSaved={resource.refresh} />
    {selectedDevice && <AdminDetails title={`ESP32 #${selectedDevice.id}`} close={() => setSelected(null)}><dl className="admin-definition">
      <div><dt>Name</dt><dd>{selectedDevice.device_name}</dd></div><div><dt>Farmer</dt><dd>{selectedDevice.owner_name || 'Unassigned'}</dd></div>
      <div><dt>Fishpen</dt><dd>{selectedDevice.fishpen_name || 'Unassigned'}</dd></div><div><dt>Connection</dt><dd>{deviceStatus(selectedDevice, !!resource.error)}</dd></div>
      <div><dt>Credential</dt><dd>{credentialStatus(selectedDevice, !!resource.error)}</dd></div><div><dt>Last upload for current owner</dt><dd>{adminTime(selectedDevice.current_upload_at) || missing}</dd></div>
      <div><dt>Last upload across assignments</dt><dd>{adminTime(selectedDevice.last_reading_at) || missing}</dd></div>
    </dl></AdminDetails>}
    {replacement && <AdminDetails title="Replacement device key" close={() => setReplacement(null)}>
      <p className="admin-muted">The old key no longer works. Update this ESP32 with the new key before it can upload again.</p>
      <DeviceKeyOnce deviceId={replacement.deviceId} value={replacement.deviceKey} />
      <button type="button" className="soft-button" onClick={() => setReplacement(null)}>Hide key</button>
    </AdminDetails>}
  </>;
}
