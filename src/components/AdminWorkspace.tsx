import { useState } from 'react';
import { Gauge, LayoutDashboard, LogOut, Radio, RadioTower, Settings, UserPlus, Users, Wifi } from 'lucide-react';
import { apiJson } from '../lib/api';
import { farmerBrand } from '../lib/farmerBrand';
import { AdminDetails, AdminHeading, AdminLoad, AdminRefresh, useAdminResource } from './AdminControls';
import { AdminDeviceSettings } from './AdminDeviceSecurity';
import { AdminUsers } from './AdminPeople';
import { SharedHardware, type HardwareRow } from './SharedHardware';
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
  const [passkeysOpen, setPasskeysOpen] = useState(false);
  const [createFarmer, setCreateFarmer] = useState(false);
  const [error, setError] = useState('');
  const active = menu.find(item => item.path === path) ?? menu[0];
  const logout = async () => {
    setSigningOut(true); setError('');
    const response = await apiJson('/api/admin/logout', { method: 'POST', body: '{}' });
    if (!response.error || response.status === 401 || response.status === 403) navigate('/admin/login');
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
        <button type="button" className="admin-settings" aria-label="Passkey settings" title="Passkey settings" aria-haspopup="dialog" onClick={() => setPasskeysOpen(true)}>
          <Settings size={18} aria-hidden="true" />
        </button>
      </footer>
    </aside>
    <header className="admin-topbar">
      <span className="admin-top-title">Admin Console</span>
    </header>
    <main className="admin-main">
      {error && <p className="admin-notice" data-tone="warning" role="alert">{error}</p>}
      {active.path === '/admin/dashboard' && <AdminOverview navigate={navigate} onCreate={() => { setCreateFarmer(true); navigate('/admin/users'); }} />}
      {active.path === '/admin/users' && <AdminUsers openCreate={createFarmer} />}
      {active.path === '/admin/devices' && <SharedHardware />}
      {active.path === '/admin/thresholds' && <AdminThresholds />}
    </main>
    {passkeysOpen && <AdminDetails title="Passkeys" close={() => setPasskeysOpen(false)}><AdminDeviceSettings onTerminated={() => navigate('/admin/login')} /></AdminDetails>}
  </div>;
}

type Overview = {
  counts: { farmers: number };
};

function AdminOverview({ navigate, onCreate }: { navigate: (path: string) => void; onCreate: () => void }) {
  const overview = useAdminResource<Overview>('/api/admin/overview', 30_000);
  const inventory = useAdminResource<{ hardware: HardwareRow[] }>('/api/admin/hardware', 30_000);
  const data = overview.error ? null : overview.data;
  const devices = inventory.error ? undefined : inventory.data?.hardware;
  const fleetValue = (value: (row: HardwareRow) => string) => !devices ? undefined :
    devices.length === 0 ? 'Not Registered' : devices.length === 1 ? value(devices[0]) :
      <ul>{devices.map(row => <li key={row.id}><span>{row.name}: </span>{value(row)}</li>)}</ul>;
  const counts = [
    ['Total Farmers', data?.counts.farmers, Users],
    ['Registered Hardware', devices?.length, RadioTower],
    ['Hardware Status', fleetValue(row => row.status), Wifi],
    ['Currently Assigned Farmer', devices?.length === 0 ? 'None' : fleetValue(row => row.farmer ?? 'None'), UserPlus]
  ] as const;
  return <>
    <AdminHeading title="Dashboard"><AdminRefresh busy={overview.busy || inventory.busy} refresh={() => { void overview.refresh(); void inventory.refresh(); }} /></AdminHeading>
    <AdminLoad resource={{ ...overview, data }} />
    <AdminLoad resource={{ ...inventory, data: inventory.error ? null : inventory.data }} />
    <dl className="admin-metrics">{counts.map(([label, value, Icon]) => <div className="admin-panel admin-metric" key={label}>
      <dt><Icon size={17} aria-hidden="true" /> {label}</dt><dd className={typeof value !== 'number' ? 'admin-metric-label' : undefined}>
        {typeof value === 'number' ? value.toLocaleString('en-PH') : value ?? 'Unavailable'}
      </dd>
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
