import { useState } from 'react';
import { Gauge, LayoutDashboard, LogOut, Radio, RadioTower, ShieldCheck, UserPlus, Users, Wifi, WifiOff } from 'lucide-react';
import { apiJson } from '../lib/api';
import { farmerBrand } from '../lib/farmerBrand';
import { AdminDetails, AdminHeading, AdminLoad, AdminRefresh, useAdminResource } from './AdminControls';
import { AdminDeviceSettings } from './AdminDeviceSecurity';
import { AdminDevices, AdminUsers } from './AdminPeople';
import { AdminThresholds } from './AdminPreferences';
import './admin.css';

const menu = [
  { path: '/admin/dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { path: '/admin/users', label: 'Users', Icon: Users },
  { path: '/admin/devices', label: 'Devices', Icon: Radio },
  { path: '/admin/thresholds', label: 'Thresholds', Icon: Gauge }
] as const;

export type AdminSection = typeof menu[number]['path'];
export function isAdminSection(path: string): path is AdminSection {
  return menu.some(item => item.path === path);
}
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

export function AdminWorkspace({ path, navigate }: { path: AdminSection; navigate: (path: string) => void }) {
  const [signingOut, setSigningOut] = useState(false);
  const [security, setSecurity] = useState(false);
  const [createFarmer, setCreateFarmer] = useState(false);
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
          e.preventDefault();
          if (href !== path) { setCreateFarmer(false); navigate(href); }
        }}><Icon size={18} aria-hidden="true" /> <span>{label}</span></a>)}
      </nav>
      <footer className="admin-sidebar-footer">
        <button type="button" className="admin-logout" disabled={signingOut} onClick={() => void logout()}><LogOut size={17} aria-hidden="true" /> {signingOut ? 'Logging out...' : 'Logout'}</button>
      </footer>
    </aside>
    <header className="admin-topbar">
      <span className="admin-top-title">Admin Console</span>
      <button type="button" className="soft-button" onClick={() => setSecurity(true)}><ShieldCheck size={17} aria-hidden="true" /> Login security</button>
    </header>
    <main className="admin-main">
      {error && <p className="admin-notice" data-tone="warning" role="alert">{error}</p>}
      {active.path === '/admin/dashboard' && <AdminOverview navigate={navigate} onCreate={() => { setCreateFarmer(true); navigate('/admin/users'); }} />}
      {active.path === '/admin/users' && <AdminUsers openCreate={createFarmer} />}
      {active.path === '/admin/devices' && <AdminDevices />}
      {active.path === '/admin/thresholds' && <AdminThresholds />}
    </main>
    {security && <AdminDetails title="Login security" close={() => setSecurity(false)}><AdminDeviceSettings /></AdminDetails>}
  </div>;
}

type Overview = {
  counts: { farmers: number };
  devices: { online: number; offline: number; never: number; inactive: number };
};

function AdminOverview({ navigate, onCreate }: { navigate: (path: string) => void; onCreate: () => void }) {
  const overview = useAdminResource<Overview>('/api/admin/overview', 30_000);
  const data = overview.error ? null : overview.data;
  const devices = data?.devices;
  const total = devices ? devices.online + devices.offline + devices.never + devices.inactive : undefined;
  const counts = [
    ['Total Farmers', data?.counts.farmers, Users],
    ['Total ESP32 Devices', total, RadioTower],
    ['Online Devices', devices?.online, Wifi],
    ['Offline Devices', devices?.offline, WifiOff]
  ] as const;
  const count = (value?: number) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-PH') : '\u2014';
  return <>
    <AdminHeading title="Dashboard"><AdminRefresh busy={overview.busy} refresh={overview.refresh} /></AdminHeading>
    <AdminLoad resource={{ ...overview, data }} />
    <dl className="admin-metrics">{counts.map(([label, value, Icon]) => <div className="admin-panel admin-metric" key={label}>
      <dt><Icon size={17} aria-hidden="true" /> {label}</dt><dd>{count(value)}</dd>
    </div>)}</dl>
    <section className="admin-quick" aria-labelledby="admin-quick-title">
      <h2 id="admin-quick-title">Quick actions</h2>
      <div className="admin-actions">
        <button type="button" className="primary-button" onClick={onCreate}><UserPlus size={17} aria-hidden="true" /> Create farmer account</button>
        <button type="button" className="soft-button" onClick={() => navigate('/admin/devices')}><Radio size={17} aria-hidden="true" /> Manage devices</button>
        <button type="button" className="soft-button" onClick={() => navigate('/admin/thresholds')}><Gauge size={17} aria-hidden="true" /> Configure thresholds</button>
      </div>
    </section>
  </>;
}
