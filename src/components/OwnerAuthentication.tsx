import { useState } from 'react';
import { apiJson } from '../lib/api';
import { showSuccessToast } from '../lib/actionAlerts';
import { farmerBrand } from '../lib/farmerBrand';
import type { AppUser } from '../lib/storage';

export type OwnerSession = { user: { id: number; fullName: string; phone: string; role: 'farmer' | 'admin'; createdAt?: string; mustChangePassword: boolean }; fishpenAssignment: { id: number; name: string; deviceId: number | null } | null };
export function sessionOwner(session: OwnerSession): AppUser {
  return { id: String(session.user.id), fullName: session.user.fullName, phone: session.user.phone, role: session.user.role, createdAt: session.user.createdAt || '', mustChangePassword: session.user.mustChangePassword, fishpenAssignment: session.fishpenAssignment };
}

export function OwnerLogin({ onLogin }: { onLogin: (user: AppUser, message: string) => void; navigate: (path: string) => void }) {
  const [phone, setPhone] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <main className="relative grid min-h-screen place-items-center bg-slate-800 bg-cover bg-center px-4 py-8" style={{ backgroundImage: 'url(/laguna-de-bay-enhanced.jpg)' }}>
    <div className="absolute inset-0 bg-black/30" aria-hidden="true" />
    <section className="relative w-full max-w-md overflow-hidden rounded-lg border border-white/40 bg-white shadow-xl" aria-labelledby="owner-login-title">
    <header className="bg-teal-700 p-6 text-white sm:p-8">
      <div className="flex items-center gap-3">
        <img src={farmerBrand.logo} alt="" width={52} height={52} className="h-[52px] w-[52px] shrink-0 rounded-md bg-white object-contain"/>
        <div className="min-w-0"><h1 id="owner-login-title" className="text-2xl font-bold leading-tight">{farmerBrand.name}</h1><p className="mt-1 text-sm text-teal-50">Fishpen Monitoring</p></div>
      </div>
    </header>
    <div className="p-6 sm:p-8"><h2 className="text-xl font-bold text-slate-950">Login</h2><p className="mt-2 text-sm leading-relaxed text-slate-600">Sign in to your fishpen dashboard.</p>
    <form className="mt-6 space-y-5" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      const clean = phone.trim().replace(/\s/g, '').replace(/^09/, '+639').replace(/^639/, '+639');
      const result = await apiJson('/api/login', { method: 'POST', body: JSON.stringify({ phone: clean, password }) });
      if (result.error) { setBusy(false); setError(result.error); return; }
      const verified = await apiJson<OwnerSession>('/api/session');
      setBusy(false); setPassword('');
      if (!verified.data || verified.data.user.role !== 'farmer') { setError('Unable to verify your owner session. Please try again.'); return; }
      onLogin(sessionOwner(verified.data), 'Login successful.');
    }}>
      <label className="block text-sm font-semibold text-slate-800">Mobile number<input required type="tel" autoComplete="username" className="mt-2 min-h-12 w-full rounded-md border border-slate-300 bg-slate-50 p-3 text-base outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20" value={phone} onChange={e => setPhone(e.target.value)} placeholder="09XXXXXXXXX"/></label>
      <label className="block text-sm font-semibold text-slate-800">Password<input required type="password" autoComplete="current-password" className="mt-2 min-h-12 w-full rounded-md border border-slate-300 bg-slate-50 p-3 text-base outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20" value={password} onChange={e => setPassword(e.target.value)}/></label>
      {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm leading-relaxed text-red-700">{error}</p>}
      <button className="primary-button min-h-12 w-full text-base" disabled={busy}>{busy ? 'Signing in…' : 'Login'}</button>
    </form><p className="mt-6 border-t border-slate-100 pt-5 text-sm leading-relaxed text-slate-600">Need access or forgot your password? Contact your fishpen administrator.</p>
    </div></section></main>;
}

export function OwnerPasswordForm({ onDone, lang = 'en', temporary = false }: { onDone?: () => void; lang?: 'en' | 'tl'; temporary?: boolean }) {
  const tl = lang === 'tl';
  const [current, setCurrent] = useState(''); const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const fields = [
    { value: current, set: setCurrent, label: temporary ? (tl ? 'Pansamantalang password' : 'Current temporary password') : (tl ? 'Kasalukuyang password' : 'Current password'), auto: 'current-password' },
    { value: password, set: setPassword, label: tl ? 'Bagong password' : 'New password', auto: 'new-password' },
    { value: confirm, set: setConfirm, label: tl ? 'Ulitin ang bagong password' : 'Confirm new password', auto: 'new-password' },
  ];
  return <form className="mt-3 space-y-4" onSubmit={async e => {
    e.preventDefault(); if (password !== confirm) return setError(tl ? 'Hindi magkatugma ang password.' : 'Passwords do not match.');
    setBusy(true); setError('');
    const result = await apiJson<{ changed: boolean }>('/api/owner/password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: password }) });
    setBusy(false);
    if (!result.data?.changed) setError(result.error || (tl ? 'Hindi napalitan ang password.' : 'Password could not be changed.'));
    else {
      setCurrent(''); setPassword(''); setConfirm('');
      if (!temporary) void showSuccessToast(tl ? 'Napalitan na ang password.' : 'Password changed.');
      onDone?.();
    }
  }}>
    <p className="text-sm text-slate-600">{tl ? 'Gumamit ng hindi bababa sa 12 character.' : 'Use at least 12 characters.'}</p>
    {fields.map(({ value, set, label, auto }) => <label key={label} className="block text-sm font-semibold">{label}<input required disabled={busy} type="password" minLength={auto === 'new-password' ? 12 : undefined} autoComplete={auto} className="mt-2 w-full rounded-md border border-slate-300 p-3 text-base" value={value} onChange={e => set(e.target.value)} /></label>)}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button className="primary-button" disabled={busy}>{busy ? (tl ? 'Sine-save...' : 'Saving...') : (tl ? 'I-save ang bagong password' : 'Save new password')}</button>
  </form>;
}

export function OwnerPasswordChange({ onDone, onLogout, lang = 'en' }: { onDone: () => void; onLogout: () => void; lang?: 'en' | 'tl' }) {
  return <main className="mx-auto max-w-lg px-4 py-10"><h1 className="text-xl font-bold">{lang === 'tl' ? 'Palitan ang pansamantalang password' : 'Change your temporary password'}</h1><OwnerPasswordForm onDone={onDone} lang={lang} temporary /><button type="button" className="soft-button mt-3" onClick={onLogout}>{lang === 'tl' ? 'Mag-logout' : 'Logout'}</button></main>;
}
