import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { apiJson } from '../lib/api';
import { DeviceKeyOnce } from './AdminControls';

export function ProvisionOwner({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [fishpen, setFishpen] = useState('');
  const [secret, setSecret] = useState<{ password: string; deviceKey: string; deviceId: number } | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <details className="admin-panel admin-create">
    <summary>Create farmer account</summary>
    <form onSubmit={async e => {
      e.preventDefault();
      if (busy || secret) return;
      setBusy(true); setError('');
      const number = phone.trim().replace(/^09/, '+639').replace(/^639/, '+639');
      const r = await apiJson<{ temporaryPassword: string; deviceKey: string; deviceId: number }>('/api/admin/owners', {
        method: 'POST', body: JSON.stringify({ fullName: name, phone: number, fishpenName: fishpen })
      });
      setBusy(false);
      if (r.error || !r.data) { setError(r.error || 'Could not confirm account creation. Check the account list before retrying.'); return; }
      setSecret({ password: r.data.temporaryPassword, deviceKey: r.data.deviceKey, deviceId: r.data.deviceId });
      setName(''); setPhone(''); setFishpen(''); onSaved();
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
      <p role="status"><strong>Account, fishpen, and ESP32 credential created.</strong></p>
      <p>Temporary password (expires in 24 hours)</p><code className="admin-secret">{secret.password}</code>
      <DeviceKeyOnce deviceId={secret.deviceId} value={secret.deviceKey} />
      <p className="admin-muted">Configure the physical ESP32 with this key before it can upload. Share the password privately.</p>
      <button type="button" className="soft-button" onClick={() => setSecret(null)}>Hide credentials</button>
    </section>}
  </details>;
}
