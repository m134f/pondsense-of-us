import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { apiJson } from '../lib/api';
import { showErrorToast, showSuccessToast } from '../lib/actionAlerts';

export function ProvisionOwner({ onSaved, initiallyOpen = false }: { onSaved: () => void; initiallyOpen?: boolean }) {
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [fishpen, setFishpen] = useState('');
  const [secret, setSecret] = useState<string | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <details className="admin-panel admin-create" open={initiallyOpen || undefined}>
    <summary>Create farmer account</summary>
    <form onSubmit={async e => {
      e.preventDefault();
      if (busy || secret) return;
      setBusy(true); setError('');
      const number = phone.trim().replace(/^09/, '+639').replace(/^639/, '+639');
      const r = await apiJson<{ temporaryPassword: string }>('/api/admin/owners', {
        method: 'POST', body: JSON.stringify({ fullName: name, phone: number, fishpenName: fishpen })
      });
      setBusy(false);
      if (r.error || !r.data?.temporaryPassword) {
        setError(r.error || 'Could not confirm account creation. Check the account list before retrying.');
        void showErrorToast('Account creation not confirmed.');
        return;
      }
      setSecret(r.data.temporaryPassword);
      setName(''); setPhone(''); setFishpen(''); onSaved();
      void showSuccessToast('Farmer account and fishpen created.');
    }}>
      <fieldset className="admin-form-grid" disabled={busy || !!secret}>
        <label>Farmer name<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Mobile number<input required type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="09XXXXXXXXX" /></label>
        <label>Assigned fishpen name<input required maxLength={100} value={fishpen} onChange={e => setFishpen(e.target.value)} /></label>
        <button className="primary-button" disabled={busy || !!secret}><UserPlus size={17} aria-hidden="true" />{busy ? 'Creating...' : 'Create owner and fishpen'}</button>
      </fieldset>
    </form>
    {error && <p role="alert" className="admin-action-error">{error}</p>}
    {secret && <section className="admin-credential" aria-label="One-time farmer credentials">
      <p role="status"><strong>Farmer account and fishpen created.</strong></p>
      <p>Temporary password (expires in 24 hours)</p><code className="admin-secret">{secret}</code>
      <button type="button" className="soft-button" onClick={() => setSecret(null)}>Hide credentials</button>
    </section>}
  </details>;
}
