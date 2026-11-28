import { useEffect, useId, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON, PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { apiJson } from '../lib/api';

async function promptForAdminPasskey<T>(rpID: string | undefined, operation: 'sign-in' | 'device-bound' | 'sync-eligible', prompt: () => Promise<T>) {
  if (!window.isSecureContext || window.self !== window.top || !browserSupportsWebAuthn()) {
    throw new Error('Open the Admin Login URL directly in a browser that supports passkeys. No passkey was sent to the server.');
  }
  if (rpID !== window.location.hostname) {
    throw new Error('The passkey configuration does not match this Admin Login address. Contact the system operator.');
  }
  try {
    return await prompt();
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'SecurityError') {
      throw new Error('This browser context cannot use the admin passkey. Open the Admin Login URL directly and try again.');
    }
    if (name === 'NotAllowedError' || name === 'AbortError' || name === 'NotSupportedError') {
      const next = operation === 'sign-in'
        ? 'Use an enrolled passkey for this site.'
        : operation === 'device-bound'
          ? 'This request requires a device-bound passkey. A synced passkey needs separate approval.'
          : 'Check that your phone has a passkey provider and a screen lock, then start a new request.';
      throw new Error(`No passkey was sent to the server. ${next}`);
    }
    throw error;
  }
}

type CredentialPolicy = 'device-bound' | 'sync-eligible';
const syncNotice = 'This passkey may be available on other devices signed in to the same Apple or Google account. Revoking it blocks all copies.';

function CredentialTypeField({ label, value, onChange, disabled }: { label: string; value: CredentialPolicy; onChange: (policy: CredentialPolicy) => void; disabled?: boolean }) {
  const id = useId();
  return <div>
    <label htmlFor={id} className="block text-sm font-semibold">{label}</label>
    <select id={id} value={value} disabled={disabled} onChange={e => onChange(e.target.value === 'sync-eligible' ? 'sync-eligible' : 'device-bound')} className="auth-input mt-1 w-full border p-3">
      <option value="device-bound">Device-bound passkey (e.g. Windows Hello)</option>
      <option value="sync-eligible">Sync-eligible mobile passkey</option>
    </select>
  </div>;
}

export async function verifyAdminDevice(token: string, optionsJSON: PublicKeyCredentialRequestOptionsJSON) {
  const response = await promptForAdminPasskey(optionsJSON.rpId, 'sign-in', () => startAuthentication({ optionsJSON }));
  const result = await apiJson<{ verified: boolean }>('/api/admin/security/authenticate/verify', { method: 'POST', body: JSON.stringify({ token, response }) });
  if (!result.data?.verified) throw new Error(result.error || 'The server did not accept this passkey. Use an enrolled device or log in again to retry.');
}

export function AdminDeviceEnrollment({ token, bootstrap, onDone }: { token: string; bootstrap: boolean; onDone: () => void }) {
  const [secret, setSecret] = useState('');
  const [label, setLabel] = useState('Administrator device');
  const [policy, setPolicy] = useState<CredentialPolicy>('device-bound');
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const enroll = async () => {
    setBusy(true); setError('');
    try {
      const options = await apiJson<{ options: PublicKeyCredentialCreationOptionsJSON }>('/api/admin/security/enroll/options', { method: 'POST', body: JSON.stringify({ token, bootstrapSecret: secret }) });
      if (!options.data) throw new Error(options.error || 'Enrollment not approved.');
      const { options: optionsJSON } = options.data;
      const response = await promptForAdminPasskey(optionsJSON.rp.id, policy, () => startRegistration({ optionsJSON }));
      const result = await apiJson<{ verified: boolean }>('/api/admin/security/enroll/verify', { method: 'POST', body: JSON.stringify({ token, response, label }) });
      if (!result.data?.verified) throw new Error(result.error || 'Device registration failed.');
      setSecret(''); onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3 border-t border-slate-200 pt-4">
    <h2 className="font-bold">{bootstrap ? 'Register the first administrator device' : 'Register this administrator device'}</h2>
    {bootstrap ? <label className="block text-sm">Operator bootstrap secret<input type="password" autoComplete="off" className="auth-input mt-1 w-full border p-3" value={secret} onChange={e => setSecret(e.target.value)} /></label> : <>
      <p className="text-sm text-slate-600">Approve the request at <code>/admin/passkeys</code> after signing in with an enrolled device-bound passkey.</p>
      <CredentialTypeField label="Credential type" value={policy} onChange={setPolicy} disabled={busy || requested} />
      {policy === 'sync-eligible' && <p className="text-sm text-amber-800">{syncNotice}</p>}
      {!requested ? <button disabled={busy} className="soft-button" onClick={async () => {
        setBusy(true); setError('');
        const result = await apiJson('/api/admin/security/enroll/request', { method: 'POST', body: JSON.stringify({ token, policy }) });
        if (result.error) setError(result.error); else setRequested(true);
        setBusy(false);
      }}>Request device approval</button> : <label className="block text-sm">Enrollment request (expires in 10 minutes)<input readOnly className="mt-1 w-full border p-3 text-sm" value={token} onFocus={e => e.target.select()} /></label>}
    </>}
    <label className="block text-sm">Device name<input className="auth-input mt-1 w-full border p-3" maxLength={100} value={label} onChange={e => setLabel(e.target.value)} /></label>
    <button className="primary-button w-full" disabled={busy || (!bootstrap && !requested)} onClick={() => void enroll()}>{busy ? 'Verifying device…' : bootstrap ? 'Set up Windows Hello / device verification' : 'Continue after approval'}</button>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </div>;
}

type Device = { id: number; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null; credential_policy: CredentialPolicy; backup_eligible: 0 | 1 | null; backed_up: 0 | 1 | null };
export function AdminDeviceSettings({ onTerminated }: { onTerminated: () => void }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [maxCredentials, setMaxCredentials] = useState<number | null>(null);
  const [request, setRequest] = useState('');
  const [approvalPolicy, setApprovalPolicy] = useState<CredentialPolicy>('device-bound');
  const [current, setCurrent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = async () => {
    const result = await apiJson<{ devices: Device[]; currentCredentialId: number | null; maxCredentials: number }>('/api/admin/security/devices');
    if (result.data) {
      setDevices(result.data.devices);
      setCurrent(result.data.currentCredentialId);
      setMaxCredentials(result.data.maxCredentials);
    }
    else setMessage(result.error || 'Unable to load devices.');
  };
  useEffect(() => { void load(); }, []);
  const activeCount = devices.filter(device => !device.revoked_at).length;
  const currentIsDeviceBound = devices.some(device => device.id === current && !device.revoked_at && device.credential_policy === 'device-bound');
  const action = async (url: string, body: object) => {
    setBusy(true); setMessage('');
    const result = await apiJson(url, { method: 'POST', body: JSON.stringify(body) });
    setMessage(result.error || 'Saved.');
    if (!result.error) { setRequest(''); await load(); }
    setBusy(false);
  };
  return <section className="space-y-4">
    <h3 className="font-semibold">Authorized login devices</h3>
    {maxCredentials != null && <p className="text-sm text-slate-600">{activeCount} of {maxCredentials} credentials enrolled. Log in again before approving or revoking devices if verification is older than 5 minutes.</p>}
    {current != null && !currentIsDeviceBound && <p className="text-sm text-slate-600">Use an enrolled device-bound passkey to approve enrollment or revoke a device-bound passkey.</p>}
    <ul className="divide-y divide-slate-200">{devices.map(device => <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div><strong>{device.label}{device.id === current ? ' (this session)' : ''}</strong>
        <p className="text-sm text-slate-600">{device.credential_policy === 'sync-eligible' ? 'Sync-eligible passkey' : 'Device-bound passkey'} · {device.revoked_at ? 'Revoked' : 'Authorized'}</p>
        <p className="text-sm text-slate-600">Backup state: {device.backed_up == null ? 'Not recorded' : device.backed_up ? 'Backed up' : 'Not backed up'} · Last verification: {device.last_used_at ? new Date(device.last_used_at).toLocaleString() : 'Enrollment'}</p>
      </div>
      {!device.revoked_at && <button className="soft-button" disabled={busy || !current || (device.credential_policy === 'device-bound' && !currentIsDeviceBound)} onClick={() => {
        if (window.confirm(`Revoke ${device.label}? Its sessions and any synced copies will be blocked.`)) void action(`/api/admin/security/devices/${device.id}/revoke`, {});
      }}>Revoke</button>}
    </li>)}</ul>
    {currentIsDeviceBound && (maxCredentials == null || activeCount < maxCredentials) && <details className="admin-detail-section">
      <summary>Approve a new login device</summary>
      <p className="text-sm text-slate-600">Confirm the request with the person enrolling before approving.</p>
      <label className="block text-sm font-semibold">Enrollment request<input value={request} onChange={e => setRequest(e.target.value)} autoComplete="off" /></label>
      <CredentialTypeField label="Credential type to approve" value={approvalPolicy} onChange={setApprovalPolicy} disabled={busy} />
      {approvalPolicy === 'sync-eligible' && <p className="text-sm text-amber-800">{syncNotice}</p>}
      <button className="soft-button" disabled={busy || !request.trim()} onClick={() => {
        const confirmation = approvalPolicy === 'sync-eligible'
          ? `Authorize a sync-eligible passkey? ${syncNotice}`
          : 'Authorize this device-bound passkey? Verify the request with its operator first.';
        if (window.confirm(confirmation)) void action('/api/admin/security/enroll/approve', { token: request.trim(), policy: approvalPolicy });
      }}>Approve device enrollment</button>
    </details>}
    {current != null && <button type="button" className="soft-button" disabled={busy} onClick={async () => {
      if (!window.confirm('End all administrator sessions, including this one?')) return;
      setBusy(true); setMessage('');
      const result = await apiJson<{ terminated: boolean }>('/api/admin/security/sessions/terminate', { method: 'POST', body: '{}' });
      if (result.data?.terminated) onTerminated();
      else { setMessage(result.error || 'Could not end sessions.'); setBusy(false); }
    }}>End all admin sessions</button>}
    <details className="admin-detail-section">
      <summary>Recover access</summary>
      <p className="text-sm text-slate-600">Use another authorized device to approve a replacement. If none are available, contact the system operator for verified recovery.</p>
    </details>
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
