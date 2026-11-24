import { useState } from 'react';
import { Activity, ArrowUpRight, ClipboardList, Gauge, LayoutDashboard, LogOut, Radio, Settings, ShieldCheck, Users } from 'lucide-react';
import { apiJson } from '../lib/api';
import { farmerBrand } from '../lib/farmerBrand';
import { AdminBadge, AdminHeading, AdminLoad, AdminRefresh, adminTime, useAdminResource } from './AdminControls';
import { AdminDevices, AdminUsers } from './AdminPeople';
import { AdminLogs } from './AdminLogs';
import { AdminSettings, AdminThresholds } from './AdminPreferences';
import './admin.css';

const menu = [
  { path: '/admin/dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { path: '/admin/users', label: 'Users', Icon: Users },
  { path: '/admin/devices', label: 'Devices', Icon: Radio },
  { path: '/admin/logs', label: 'Logs', Icon: ClipboardList },
  { path: '/admin/thresholds', label: 'Thresholds', Icon: Gauge },
  { path: '/admin/settings', label: 'Settings', Icon: Settings }
] as const;

export type AdminSection = typeof menu[number]['path'];
export type AdminAccount = {
  id: number;
  fullName: string;
  username?: string | null;
  email?: string | null;
  phone?: string | null;
  role: 'admin' | 'farmer';
  accountStatus?: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED';
  createdAt?: string;
  fishpenName?: string | null;
  deviceId?: number | null;
};

export function AdminWorkspace({ path, admin, navigate }: { path: AdminSection; admin: AdminAccount; navigate: (path: string) => void }) {
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const active = menu.find(item => item.path === path) ?? menu[0];
  const logout = async () => {
    setSigningOut(true); setError('');
    const response = await apiJson('/api/admin/logout', { method: 'POST', body: '{}' });
    if (!response.error || response.status === 401) navigate('/admin/login');
    else setError(response.error);
    setSigningOut(false);
  };
  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <a href="/admin/dashboard" className="admin-brand"><img alt="" src={farmerBrand.logo} width="30" height="30" /><span>{farmerBrand.name}</span></a>
      <nav aria-label="Admin navigation">
        {menu.map(({ path: href, label, Icon }) => <a key={href} href={href} aria-current={active.path === href ? 'page' : undefined} onClick={e => {
          if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault(); if (href !== path) navigate(href);
        }}><Icon size={18} aria-hidden="true" /> <span>{label}</span></a>)}
      </nav>
    </aside>
    <header className="admin-topbar">
      <span className="admin-top-title"><ShieldCheck size={18} aria-hidden="true" /> Admin Console</span>
      <div className="admin-actions">
        <span className="admin-signed-in">{admin.fullName}</span>
        <a className="soft-button" href="/">Farmer Dashboard <ArrowUpRight size={15} aria-hidden="true" /></a>
        <button type="button" className="soft-button admin-icon-button" disabled={signingOut} aria-label="Logout" title="Logout" onClick={() => void logout()}><LogOut size={17} aria-hidden="true" /></button>
      </div>
    </header>
    <main className="admin-main">
      {error && <p className="admin-notice" data-tone="warning" role="alert">{error}</p>}
      {active.path === '/admin/dashboard' && <AdminOverview navigate={navigate} />}
      {active.path === '/admin/users' && <AdminUsers />}
      {active.path === '/admin/devices' && <AdminDevices />}
      {active.path === '/admin/logs' && <AdminLogs />}
      {active.path === '/admin/thresholds' && <AdminThresholds />}
      {active.path === '/admin/settings' && <AdminSettings admin={admin} navigate={navigate} />}
    </main>
  </div>;
}

type Overview = {
  counts: { farmers: number; sensorReadings: number; criticalToday: number; smsToday: number };
  devices: { online: number; offline: number; never: number; inactive: number; assigned: number };
  activity: { id: number; kind: 'upload' | 'admin'; label: string; device_id: number | null; happened_at: string }[];
  freshnessSeconds: number;
};

function AdminOverview({ navigate }: { navigate: (path: string) => void }) {
  const overview = useAdminResource<Overview>('/api/admin/overview', 30_000);
  const data = overview.data;
  const counts = [
    ['Total Farmers', data?.counts.farmers, Users, 'Registered farmer accounts'],
    ['Total Sensor Readings', data?.counts.sensorReadings, Activity, 'Saved ESP32 uploads'],
    ['Critical Alerts Today', data?.counts.criticalToday, Gauge, 'Confirmed incidents opened today (PHT)'],
    ['SMS Accepted Today', data?.counts.smsToday, Radio, 'Provider accepted, delivery unconfirmed (PHT)']
  ] as const;
  const count = (value?: number) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-PH') : '\u2014';
  return <>
    <AdminHeading title="Admin Overview" caption="Fishpen operations"><AdminRefresh busy={overview.busy} refresh={overview.refresh} /></AdminHeading>
    <AdminLoad resource={overview} />
    <dl className="admin-metrics">{counts.map(([label, value, Icon, description]) => <div className="admin-panel admin-metric" key={label}>
      <dt><Icon size={17} aria-hidden="true" /> {label}</dt><dd><strong>{count(value)}</strong><small>{description}</small></dd>
    </div>)}</dl>
    <section className="admin-panel">
      <header className="admin-section-heading"><h2>Device Overview</h2><button type="button" className="soft-button" onClick={() => navigate('/admin/devices')}>View devices <ArrowUpRight size={15} aria-hidden="true" /></button></header>
      <dl className="admin-device-summary">
        {([['Assigned monitors', 'assigned'], ['Online', 'online'], ['Offline', 'offline'], ['Never uploaded', 'never'], ['Inactive', 'inactive']] as const).map(([label, key]) =>
          <div key={key}><dt>{label}</dt><dd>{count(data?.devices[key])}</dd></div>)}
      </dl>
      {data && <p className="admin-muted">Online requires a valid sample uploaded within {data.freshnessSeconds} seconds.</p>}
    </section>
    <section className="admin-panel">
      <header className="admin-section-heading"><h2>Recent Activity</h2><button type="button" className="soft-button" onClick={() => navigate('/admin/logs')}>View logs <ArrowUpRight size={15} aria-hidden="true" /></button></header>
      {data?.activity.length ? <ul className="admin-activity">{data.activity.map(row => <li key={`${row.kind}-${row.id}`}>
        <AdminBadge tone={row.kind === 'upload' ? 'good' : 'neutral'}>{row.kind === 'upload' ? 'ESP32 upload' : 'Admin action'}</AdminBadge>
        <span>{row.kind === 'upload' ? `${row.label} #${row.device_id}` : row.label.replaceAll('_', ' ')}</span>
        <time dateTime={row.happened_at}>{adminTime(row.happened_at) ?? 'Time unavailable'}</time>
      </li>)}</ul> : <p className="admin-empty">{data ? 'No activity recorded yet.' : 'Activity unavailable.'}</p>}
    </section>
  </>;
}
