import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiJson } from '../lib/api';
type Log = { id: number; fishpen_name: string; recipient_type: string; recipient_phone: string; parameter_name: string; severity: string; reading_value: number; measured_at: string; status: string; created_at: string; provider_response: string | null; provider_message_id: string | null };
export function WaterSmsLogs() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true); setError('');
    const result = await apiJson<{ logs: Log[] }>('/api/admin/water-sms');
    if (result.error) setError(result.error);
    else setLogs(result.data?.logs || []);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);
  return <section className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
    <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-bold">Fishpen Water SMS Logs</h2><button type="button" onClick={load} disabled={loading} aria-label="Refresh water SMS logs" title="Refresh water SMS logs" className="rounded-lg border p-3 disabled:opacity-50"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button></div>
    <p className="mt-2 text-sm text-slate-600">Accepted means the provider accepted the message, not confirmed handset delivery. Failed and unknown attempts are not automatically retried. Latest 200 attempts.</p>
    {error && <p role="alert" className="mt-3 text-red-700">{error}</p>}
    {!logs.length && !loading && <p className="mt-4 text-slate-600">No fishpen water SMS attempts yet.</p>}
    <ul className="mt-4 max-h-[600px] divide-y overflow-auto">
      {logs.map(log => <li key={log.id} className="space-y-1 py-3 text-sm">
        <p className="font-bold">{log.fishpen_name} · {log.parameter_name}: {log.reading_value} · {log.severity}</p>
        <p className="capitalize">{log.recipient_type}: {log.recipient_phone}</p>
        <p className={log.status === 'accepted' ? 'font-semibold text-teal-800' : 'font-semibold text-amber-900'}>{log.status === 'accepted' ? 'Provider accepted (delivery unconfirmed)' : log.status}</p>
        <p className="text-slate-600">Reading: {new Date(log.measured_at).toLocaleString()} | Logged: {new Date(log.created_at).toLocaleString()}</p>
        <p className="break-words text-slate-600">{log.provider_response || 'Awaiting provider submission'}{log.provider_message_id ? ` | Provider ID: ${log.provider_message_id}` : ''}</p>
      </li>)}
    </ul>
  </section>;
}
