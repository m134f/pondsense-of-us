import { useState } from 'react';
import { Eye, KeyRound, Trash2 } from 'lucide-react';
import { apiJson } from '../lib/api';
import { confirmAction, showErrorToast, showSuccessToast } from '../lib/actionAlerts';
import { ProvisionOwner } from './ProvisionOwner';
import { FarmerRecords } from './AdminRecords';
import { AdminSmsRecipients } from './AdminSmsRecipients';
import { AdminBadge, AdminDetails, AdminHeading, AdminLoad, AdminRefresh, AdminTable, adminTime, useAdminResource } from './AdminControls';
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
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const query = search.trim().toLowerCase();
  const accounts = users.data?.users.filter(row => row.role === 'farmer' && row.phone !== '+639000000000') ?? [];
  const shown = accounts.filter(row => [row.fullName, row.fishpenName, row.phone, row.accountStatus, row.deviceId && `#${row.deviceId}`].join(' ').toLowerCase().includes(query));
  const owner = accounts.find(row => row.id === selected);
  const changeStatus = async (row: AdminAccount, status: 'ACTIVE' | 'SUSPENDED', source: HTMLElement) => {
    if (busy) return;
    const suspend = status === 'SUSPENDED';
    setBusy(true);
    try {
      if (!await confirmAction({
        source, title: `${suspend ? 'Suspend' : 'Reactivate'} ${row.fullName}?`,
        text: suspend ? 'This blocks farmer access without deleting their saved records.' : 'This restores farmer access to their existing records.',
        label: suspend ? 'Suspend account' : 'Reactivate account', danger: suspend
      })) return;
      setMessage(null);
      const r = await apiJson(`/api/admin/users/${row.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      if (r.error) {
        setMessage({ text: r.error, error: true });
        void showErrorToast('Account status change not confirmed.');
      } else {
        await users.refresh();
        void showSuccessToast(suspend ? 'Farmer account suspended.' : 'Farmer account reactivated.');
      }
    } finally { setBusy(false); }
  };
  const resetPassword = async (row: AdminAccount, source: HTMLElement) => {
    if (busy) return;
    setBusy(true);
    try {
      if (!await confirmAction({ source, title: `Reset the password for ${row.fullName}?`,
        text: 'Existing sessions will be invalidated. The farmer will need a temporary password.',
        label: 'Reset password', danger: true })) return;
      setMessage(null); setPassword(null);
      const r = await apiJson<{ temporaryPassword: string }>(`/api/admin/owners/${row.id}/reset-password`, { method: 'POST', body: '{}' });
      if (r.data?.temporaryPassword) {
        setSelected(null); setPassword({ name: row.fullName, value: r.data.temporaryPassword });
        void showSuccessToast('Farmer password reset.');
      } else {
        setMessage({ text: r.error || 'Could not confirm password reset.', error: true });
        void showErrorToast('Password reset not confirmed.');
      }
    } finally { setBusy(false); }
  };
  const deleteFarmer = async (row: AdminAccount) => {
    if (busy || confirmation !== 'DELETE' || row.accountStatus !== 'SUSPENDED') return;
    setBusy(true); setMessage(null);
    const r = await apiJson<{ deleted: boolean }>(`/api/admin/owners/${row.id}`, { method: 'DELETE', body: JSON.stringify({ confirm: confirmation }) });
    if (r.data?.deleted) {
      setSelected(null);
      setConfirmation(null);
      await users.refresh();
      void showSuccessToast('Farmer account deleted.');
    } else {
      setMessage({ text: r.error || 'Could not confirm account deletion.', error: true });
      void showErrorToast('Account deletion not confirmed.');
    }
    setBusy(false);
  };
  const cancelDelete = () => { setConfirmation(null); setMessage(null); };
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
      {users.data && <AdminTable label="Farmer accounts" headings={['Farmer name', 'Fishpen', 'Mobile number', 'Status', 'Monitoring', 'Details']} empty="No farmer accounts match."
        rows={shown.map(row => ({ id: row.id, cells: [<strong>{row.fullName}</strong>, row.fishpenName || 'Unassigned', row.phone || missing, statusBadge(row.accountStatus), row.deviceId ? `Hardware #${row.deviceId}` : 'Not assigned',
          <button type="button" className="soft-button" onClick={() => { setSelected(row.id); setMessage(null); }}><Eye size={15} aria-hidden="true" /> View</button>] }))} />}
    </section>
    {owner && confirmation === null && <AdminDetails title={owner.fullName} close={() => setSelected(null)} locked={busy}><dl className="admin-definition">
      <div><dt>Fishpen</dt><dd>{owner.fishpenName || 'Unassigned'}</dd></div>
      <div><dt>Mobile number</dt><dd>{owner.phone || missing}</dd></div>
      <div><dt>Account status</dt><dd>{statusBadge(owner.accountStatus)}</dd></div>
      <div><dt>Monitoring hardware</dt><dd>{owner.deviceId ? `#${owner.deviceId}` : 'Unassigned'}</dd></div>
      <div><dt>Created</dt><dd>{adminTime(owner.createdAt) || missing}</dd></div>
    </dl>
      <div className="admin-actions">
        {owner.accountStatus && <button type="button" className="soft-button" disabled={busy || !!users.error} onClick={event => void changeStatus(owner, owner.accountStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE', event.currentTarget)}>{owner.accountStatus === 'ACTIVE' ? 'Suspend account' : 'Reactivate account'}</button>}
        <button type="button" className="soft-button" disabled={busy || !!users.error} onClick={event => void resetPassword(owner, event.currentTarget)}><KeyRound size={15} aria-hidden="true" /> Reset password</button>
        {owner.accountStatus === 'SUSPENDED' && <button type="button" className="soft-button admin-danger-button" disabled={busy || !!users.error} onClick={() => { setMessage(null); setConfirmation(''); }}><Trash2 size={15} aria-hidden="true" /> Delete account</button>}
      </div>
      <ActionMessage message={message} />
      <AdminSmsRecipients key={owner.id} ownerId={owner.id} />
      <FarmerRecords ownerId={owner.id} />
    </AdminDetails>}
    {owner && confirmation !== null && <AdminDetails title="Delete farmer account" close={cancelDelete} locked={busy}>
      <p>Permanently delete <strong>{owner.fullName}</strong>? The account and its unused fishpen setup will be removed. Accounts with linked records cannot be deleted.</p>
      <form onSubmit={event => { event.preventDefault(); void deleteFarmer(owner); }}>
        <label>Type DELETE to confirm<input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" disabled={busy} /></label>
        <div className="admin-actions">
          <button type="button" className="soft-button" disabled={busy} onClick={cancelDelete}>Cancel</button>
          <button type="submit" className="soft-button admin-danger-button" disabled={busy || confirmation !== 'DELETE'}><Trash2 size={15} aria-hidden="true" /> {busy ? 'Deleting...' : 'Delete permanently'}</button>
        </div>
      </form>
      <ActionMessage message={message} />
    </AdminDetails>}
    {password && <AdminDetails title="Temporary password" close={() => setPassword(null)}>
      <p className="admin-muted">For {password.name}. Expires in 24 hours. Share privately.</p><code className="admin-secret">{password.value}</code>
      <button type="button" className="soft-button" onClick={() => setPassword(null)}>Hide password</button>
    </AdminDetails>}
  </>;
}
