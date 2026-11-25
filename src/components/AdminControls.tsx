import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Eye, EyeOff, RefreshCw, X } from 'lucide-react';
import { apiJson } from '../lib/api';

export function useAdminResource<T>(url: string, interval = 0) {
  const [state, setState] = useState<{ data: T | null; error: string | null; busy: boolean }>({ data: null, error: null, busy: true });
  const version = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++version.current;
    setState(before => ({ ...before, busy: true }));
    const result = await apiJson<T>(url);
    if (request === version.current) setState(before => ({ data: result.data ?? before.data, error: result.error, busy: false }));
  }, [url]);
  useEffect(() => {
    void refresh();
    const timer = interval ? window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, interval) : undefined;
    return () => { version.current++; window.clearInterval(timer); };
  }, [interval, refresh]);
  return { ...state, refresh };
}

export function AdminHeading({ title, caption, children }: { title: string; caption?: string; children?: ReactNode }) {
  return <header className="admin-page-heading"><div><h1>{title}</h1>{caption && <p>{caption}</p>}</div>{children}</header>;
}

export function AdminRefresh({ refresh, busy }: { refresh: () => void; busy: boolean }) {
  return <button type="button" className="soft-button admin-icon-button" aria-label="Refresh" title="Refresh" disabled={busy} onClick={refresh}><RefreshCw size={17} aria-hidden="true" /></button>;
}

export function AdminLoad({ resource }: { resource: { busy: boolean; error: string | null; data: unknown; refresh: () => void } }) {
  if (resource.error) return <div className="admin-notice" data-tone="warning" role="alert"><p>{resource.error}{resource.data ? ' Showing last loaded data.' : ''}</p><button type="button" className="soft-button" disabled={resource.busy} onClick={resource.refresh}>Try again</button></div>;
  if (!resource.data && resource.busy) return <p role="status" className="admin-muted">Loading...</p>;
  return null;
}

export function AdminBadge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warning' | 'danger'; children: ReactNode }) {
  return <span className="admin-badge" data-tone={tone}>{children}</span>;
}

export function AdminTable({ label, headings, rows, empty }: { label: string; headings: string[]; rows: { id: string | number; cells: ReactNode[] }[]; empty: string }) {
  if (!rows.length) return <p className="admin-empty">{empty}</p>;
  return <div className="admin-table-scroll" tabIndex={0} role="region" aria-label={label}><table className="admin-table" role="table" aria-label={label}>
    <thead role="rowgroup"><tr role="row">{headings.map(heading => <th key={heading} scope="col" role="columnheader">{heading}</th>)}</tr></thead>
    <tbody role="rowgroup">{rows.map(row => <tr key={row.id} role="row">{row.cells.map((cell, index) => <td key={headings[index]} data-label={headings[index]} role="cell"><div>{cell}</div></td>)}</tr>)}</tbody>
  </table></div>;
}

export function AdminDetails({ title, close, children, locked = false }: { title: string; close: () => void; children: ReactNode; locked?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const opener = document.activeElement;
    node?.showModal();
    return () => { node?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  return <dialog ref={dialog} className="admin-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!locked) close(); }}>
    <header><h2>{title}</h2><button type="button" className="soft-button admin-icon-button" onClick={close} disabled={locked} aria-label="Close" title="Close" autoFocus><X size={17} aria-hidden="true" /></button></header>
    {children}
  </dialog>;
}

export function DeviceKeyOnce({ deviceId, value, label = 'device' }: { deviceId: number; value: string; label?: string }) {
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState('');
  return <div className="admin-key-once">
    <p><strong>ESP32 key for {label} #{deviceId}</strong> <span className="admin-muted">Available in this view only.</span></p>
    {visible && <code className="admin-secret">{value}</code>}
    <div className="admin-actions">
      <button type="button" className="soft-button" onClick={async () => {
        try { await navigator.clipboard.writeText(value); setMessage('Key copied. Paste it only into the private device configuration.'); }
        catch { setMessage('Clipboard unavailable. Reveal the key to copy it manually.'); }
      }}><Copy size={16} aria-hidden="true" /> Copy Key</button>
      <button type="button" className="soft-button" aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}{visible ? 'Mask key' : 'Reveal key'}</button>
    </div>
    {message && <p role="status" className="admin-muted">{message}</p>}
  </div>;
}

const timestamp = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' });
export function adminTime(value: unknown) {
  if (!value || !Number.isFinite(Date.parse(String(value)))) return null;
  return `${timestamp.format(new Date(String(value)))} PHT`;
}

export function csvCell(value: unknown) {
  let text = value == null ? '' : String(value);
  if (typeof value === 'string' && /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportAdminCsv(filename: string, headers: string[], rows: unknown[][]) {
  const contents = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
