import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON, PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { apiJson } from '../lib/api';

export async function verifyAdminDevice(token: string) {
  const options = await apiJson<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/admin/security/authenticate/options', { method: 'POST', body: JSON.stringify({ token }) });
  if (!options.data) throw new Error(options.error || 'Cannot start device verification.');
  const response = await startAuthentication({ optionsJSON: options.data.options });
  const result = await apiJson<{ verified: boolean }>('/api/admin/security/authenticate/verify', { method: 'POST', body: JSON.stringify({ token, response }) });
  if (!result.data?.verified) throw new Error(result.error || 'This device is not authorized. Log in again to retry.');
}

export function AdminDeviceEnrollment({ token, bootstrap, onDone }: { token: string; bootstrap: boolean; onDone: () => void }) {
  const [secret, setSecret] = useState('');
  const [label, setLabel] = useState('Administrator laptop');
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const enroll = async () => {
    setBusy(true); setError('');
    try {
      const options = await apiJson<{ options: PublicKeyCredentialCreationOptionsJSON }>('/api/admin/security/enroll/options', { method: 'POST', body: JSON.stringify({ token, bootstrapSecret: secret }) });
      if (!options.data) throw new Error(options.error || 'Enrollment not approved.');
      const response = await startRegistration({ optionsJSON: options.data.options });
      const result = await apiJson<{ verified: boolean }>('/api/admin/security/enroll/verify', { method: 'POST', body: JSON.stringify({ token, response, label }) });
      if (!result.data?.verified) throw new Error(result.error || 'Device registration failed.');
      setSecret(''); onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3 border-t border-slate-200 pt-4">
    <h2 className="font-bold">{bootstrap ? 'Register the first administrator device' : 'Register this administrator device'}</h2>
    {bootstrap ? <label className="block text-sm">Operator bootstrap secret<input type="password" autoComplete="off" className="auth-input mt-1 w-full border p-3" value={secret} onChange={e => setSecret(e.target.value)} /></label> : <>
      <p className="text-sm text-slate-600">Request approval, then enter this request on an already enrolled device under Admin Settings.</p>
      {!requested ? <button disabled={busy} className="soft-button" onClick={async () => {
        setBusy(true); setError('');
        const result = await apiJson('/api/admin/security/enroll/request', { method: 'POST', body: JSON.stringify({ token }) });
        if (result.error) setError(result.error); else setRequested(true);
        setBusy(false);
      }}>Request device approval</button> : <label className="block text-sm">Enrollment request (expires in 10 minutes)<input readOnly className="mt-1 w-full border p-3 text-sm" value={token} onFocus={e => e.target.select()} /></label>}
    </>}
    <label className="block text-sm">Device name<input className="auth-input mt-1 w-full border p-3" maxLength={100} value={label} onChange={e => setLabel(e.target.value)} /></label>
    <button className="primary-button w-full" disabled={busy || (!bootstrap && !requested)} onClick={() => void enroll()}>{busy ? 'Verifying device…' : bootstrap ? 'Set up Windows Hello / device verification' : 'Continue after approval'}</button>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </div>;
}

type Device = { id: number; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null };
export function AdminDeviceSettings() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [request, setRequest] = useState('');
  const [current, setCurrent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = async () => {
    const result = await apiJson<{ devices: Device[]; currentCredentialId: number | null }>('/api/admin/security/devices');
    if (result.data) { setDevices(result.data.devices); setCurrent(result.data.currentCredentialId); }
    else setMessage(result.error || 'Unable to load devices.');
  };
  useEffect(() => { void load(); }, []);
  const action = async (url: string, body: object) => {
    setBusy(true); setMessage('');
    const result = await apiJson(url, { method: 'POST', body: JSON.stringify(body) });
    setMessage(result.error || 'Saved.');
    if (!result.error) { setRequest(''); await load(); }
    setBusy(false);
  };
  return <section className="card space-y-4 p-5">
    <h2 className="text-lg font-bold">Authorized administrator devices</h2>
    <p className="text-sm text-slate-600">{devices.filter(d => !d.revoked_at).length} of 3 credentials enrolled. Log in again before approving or revoking devices if verification is older than 5 minutes.</p>
    {!current && <p className="text-sm text-amber-800">Device protection is not activated. Log out and log in to enroll the first device using the operator bootstrap secret.</p>}
    <ul className="divide-y divide-slate-200">{devices.map(device => <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><strong>{device.label}{device.id === current ? ' (this session)' : ''}</strong><p className="text-sm text-slate-600">{device.revoked_at ? 'Revoked' : 'Authorized'} · Last verification: {device.last_used_at ? new Date(device.last_used_at).toLocaleString() : 'Enrollment'}</p></div>{!device.revoked_at && <button className="soft-button" disabled={busy || !current} onClick={() => { if (window.confirm(`Revoke ${device.label}? Its sessions will be blocked.`)) void action(`/api/admin/security/devices/${device.id}/revoke`, {}); }}>Revoke</button>}</li>)}</ul>
    <label className="block text-sm font-semibold">Request from another laptop<input className="mt-2 w-full border border-slate-300 p-3" value={request} onChange={e => setRequest(e.target.value)} autoComplete="off" /></label>
    <button className="soft-button" disabled={busy || !current || !request.trim()} onClick={() => { if (window.confirm('Authorize enrollment of the requesting laptop? Verify the request with its operator first.')) void action('/api/admin/security/enroll/approve', { token: request.trim() }); }}>Approve device enrollment</button>
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
