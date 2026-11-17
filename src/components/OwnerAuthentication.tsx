import { useState } from 'react';
import { apiJson } from '../lib/api';
import type { AppUser } from '../lib/storage';

export type OwnerSession = { user: { id: number; fullName: string; phone: string; role: 'farmer' | 'admin'; createdAt?: string; mustChangePassword: boolean }; fishpenAssignment: { id: number; name: string; deviceId: number | null } | null };
export function sessionOwner(session: OwnerSession): AppUser {
  return { id: String(session.user.id), fullName: session.user.fullName, phone: session.user.phone, role: session.user.role, createdAt: session.user.createdAt || '', mustChangePassword: session.user.mustChangePassword, fishpenAssignment: session.fishpenAssignment };
}

export function OwnerLogin({ onLogin, navigate }: { onLogin: (user: AppUser, message: string) => void; navigate: (path: string) => void }) {
  const [phone, setPhone] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <main className="grid min-h-screen place-items-center bg-slate-50 px-4 py-8"><section className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm"><img src="/logofishpond.png" alt="" className="mb-4 h-14 w-14 object-contain"/><h1 className="text-xl font-bold">PondSense of Us</h1><h2 className="mt-4 text-lg font-semibold">Owner Login / Login ng May-ari</h2><p className="mt-2 text-sm text-slate-600">Use the account provided by your administrator. / Gamitin ang account na ibinigay ng administrator.</p>
    <form className="mt-5 space-y-4" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      const clean = phone.trim().replace(/\s/g, '').replace(/^09/, '+639').replace(/^639/, '+639');
      const result = await apiJson('/api/login', { method: 'POST', body: JSON.stringify({ phone: clean, password }) });
      if (result.error) { setBusy(false); setError(result.error); return; }
      const verified = await apiJson<OwnerSession>('/api/session');
      setBusy(false); setPassword('');
      if (!verified.data || verified.data.user.role !== 'farmer') { setError('Unable to verify your owner session. Please try again.'); return; }
      onLogin(sessionOwner(verified.data), 'Login successful.');
    }}>
      <label className="block text-sm font-semibold">Mobile number / Numero ng cellphone<input required type="tel" autoComplete="username" className="mt-2 w-full rounded-md border p-3 text-base" value={phone} onChange={e => setPhone(e.target.value)} placeholder="09XXXXXXXXX"/></label>
      <label className="block text-sm font-semibold">Password<input required type="password" autoComplete="current-password" className="mt-2 w-full rounded-md border p-3 text-base" value={password} onChange={e => setPassword(e.target.value)}/></label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button className="primary-button w-full" disabled={busy}>{busy ? 'Signing in…' : 'Login / Mag-login'}</button>
    </form><p className="mt-4 text-sm text-slate-600">Need an account or password reset? Contact your administrator. / Makipag-ugnayan sa administrator.</p><button className="soft-button mt-4" onClick={() => navigate('/admin/login')}>Administrator login</button>
  </section></main>;
}

export function OwnerPasswordChange({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  const [current, setCurrent] = useState(''); const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <main className="mx-auto max-w-lg px-4 py-10"><h1 className="text-xl font-bold">Change your temporary password</h1><p className="mt-3 text-sm text-slate-600">Palitan muna ang pansamantalang password bago gamitin ang fishpen dashboard. Use at least 12 characters.</p><form className="mt-5 space-y-4" onSubmit={async e => {
    e.preventDefault(); if (password !== confirm) return setError('Passwords do not match. / Hindi magkatugma ang password.');
    setBusy(true); setError('');
    const result = await apiJson('/api/owner/password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: password }) });
    setBusy(false); if (result.error) setError(result.error); else { setCurrent(''); setPassword(''); setConfirm(''); onDone(); }
  }}>{[[current, setCurrent, 'Current temporary password', 'current-password'], [password, setPassword, 'New password', 'new-password'], [confirm, setConfirm, 'Confirm new password', 'new-password']].map(([value, setter, label, auto]) => <label key={label as string} className="block text-sm font-semibold">{label as string}<input required type="password" minLength={auto === 'new-password' ? 12 : undefined} autoComplete={auto as string} className="mt-2 w-full rounded-md border p-3 text-base" value={value as string} onChange={e => (setter as (value: string) => void)(e.target.value)}/></label>)}{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button><button type="button" className="soft-button ml-3" onClick={onLogout}>Logout</button></form></main>;
}
