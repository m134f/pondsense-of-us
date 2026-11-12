import { useEffect, useState } from 'react';
import { Bell, Plus, Save, LoaderCircle } from 'lucide-react';
import { apiJson } from '../lib/api';

type Pen = { id: number; name: string; device_id: number | null; owner_enabled: number; caretaker_phone: string | null; caretaker_enabled: number };
type Settings = { fishpens: Pen[]; devices: Array<{ id: number; device_name: string }>; ownerPhone: string; configured: boolean; policy: { reviewed: boolean } };
export const manualSmsPenKey = (owner: string | number) => `pondsense:manual-sms-fishpen:${owner}`;

export function FishpenSmsSettings({ ownerId, lang }: { ownerId: string | number; lang: string }) {
  const tl = lang === 'tl';
  const t = (en: string, fil: string) => tl ? fil : en;
  const [data, setData] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState('new');
  const [form, setForm] = useState({ name: '', deviceId: '', ownerEnabled: true, caretakerPhone: '', caretakerEnabled: false });
  const [manual, setManual] = useState(() => localStorage.getItem(manualSmsPenKey(ownerId)) || '');
  useEffect(() => {
    let cancelled = false;
    apiJson<Settings>('/api/fishpen-sms').then(result => {
      if (cancelled) return;
      if (result.error) setError(result.error);
      else setData(result.data);
    });
    return () => { cancelled = true; };
  }, [ownerId]);
  function choose(id: string, settings = data) {
    setSelected(id); setMessage(''); setError('');
    const pen = settings?.fishpens.find(p => String(p.id) === id);
    setForm(pen ? { name: pen.name, deviceId: pen.device_id === null ? '' : String(pen.device_id), ownerEnabled: Boolean(pen.owner_enabled), caretakerPhone: pen.caretaker_phone || '', caretakerEnabled: Boolean(pen.caretaker_enabled) }
      : { name: '', deviceId: '', ownerEnabled: true, caretakerPhone: '', caretakerEnabled: false });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    try {
      const result = await apiJson<{ id: number }>(`/api/fishpen-sms/${selected}`, { method: 'PUT', body: JSON.stringify({ ...form, deviceId: form.deviceId ? Number(form.deviceId) : null }) });
      if (result.error || !result.data) { setError(result.error || t('Could not save.', 'Hindi na-save.')); return; }
      const refreshed = await apiJson<Settings>('/api/fishpen-sms');
      if (refreshed.data) { setData(refreshed.data); choose(String(result.data.id), refreshed.data); }
      else setError(refreshed.error || '');
      setMessage(t('SMS contacts saved.', 'Na-save ang mga SMS contact.'));
    } finally { setSaving(false); }
  }
  const input = 'mt-1 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-100';
  return <details className="rounded-lg border border-slate-200 bg-white p-4">
    <summary className="cursor-pointer text-base font-bold text-slate-900"><Bell size={18} className="mr-2 inline" />{t('SMS Alert Settings', 'Mga Setting ng SMS')}</summary>
    <div className="mt-4 space-y-4">
      {!data && !error && <p role="status">{t('Loading contacts...', 'Kinukuha ang mga contact...')}</p>}
      {data && <>
        <p className="text-sm text-slate-600">{t('Water alerts go to enabled contacts for the selected fishpen. Harvest reminders keep their existing settings.', 'Ang babala sa tubig ay para sa naka-enable na contact ng fishpen. Hiwalay ang setting ng paalala sa ani.')}</p>
        {(!data.configured || !data.policy.reviewed) && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{!data.policy.reviewed ? t('Automatic water SMS is awaiting administrator threshold review.', 'Naghihintay ng pagsusuri ng admin sa mga limitasyon bago magpadala ng awtomatikong SMS.') : t('SMS is temporarily unavailable. Your contacts can still be saved.', 'Pansamantalang hindi magamit ang SMS. Maaari pa ring i-save ang mga contact.')}</p>}
        <label className="block text-sm font-semibold">{t('Fishpen', 'Fishpen')}
          <select className={input} value={selected} disabled={saving} onChange={e => choose(e.target.value)}>
            <option value="new">{t('Add a fishpen', 'Magdagdag ng fishpen')}</option>
            {data.fishpens.map(p => <option key={p.id} value={p.id}>{p.name} ({p.owner_enabled || p.caretaker_enabled ? t('Enabled', 'Naka-enable') : t('Disabled', 'Naka-disable')})</option>)}
          </select>
        </label>
        <form onSubmit={save} className="space-y-4">
          <fieldset disabled={saving} className="space-y-4 disabled:opacity-60">
            <label className="block text-sm font-semibold">{t('Fishpen name', 'Pangalan ng fishpen')}<input className={input} value={form.name} maxLength={100} required onChange={e => setForm({ ...form, name: e.target.value })} /></label>
            <label className="block text-sm font-semibold">{t('Assigned monitoring device', 'Nakatalagang sensor')}<select className={input} value={form.deviceId} onChange={e => setForm({ ...form, deviceId: e.target.value })}>
              <option value="">{t('Manual measurements only', 'Manwal na sukat lamang')}</option>
              {data.devices.map(d => <option key={d.id} value={d.id}>{d.device_name} #{d.id}</option>)}
            </select></label>
            <div className="border-t border-slate-200 pt-3"><p className="text-sm text-slate-600">{t('Owner (registered number)', 'May-ari (rehistradong numero)')}</p><p className="break-all font-semibold">{data.ownerPhone}</p></div>
            <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-teal-600" checked={form.ownerEnabled} onChange={e => setForm({ ...form, ownerEnabled: e.target.checked })} />{t('Send water SMS to owner', 'Ipadala ang SMS sa may-ari')}</label>
            <label className="block text-sm font-semibold">{t('Caretaker mobile number (optional)', 'Numero ng tagapag-alaga (opsyonal)')}<input type="tel" autoComplete="off" inputMode="tel" placeholder="09XXXXXXXXX" maxLength={25} className={input} value={form.caretakerPhone} onChange={e => setForm({ ...form, caretakerPhone: e.target.value })} /></label>
            <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-teal-600" checked={form.caretakerEnabled} onChange={e => setForm({ ...form, caretakerEnabled: e.target.checked })} />{t('Send water SMS to caretaker', 'Ipadala ang SMS sa tagapag-alaga')}</label>
            <p className="text-sm text-slate-600">{t('Get the caretaker\'s consent before enabling texts. Network availability and SMS credits affect sending.', 'Humingi ng pahintulot ng tagapag-alaga bago mag-enable. Nakadepende ang pagpapadala sa network at SMS credits.')}</p>
            <button type="submit" className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 py-3 font-bold text-white hover:bg-teal-800 disabled:opacity-60">{saving ? <LoaderCircle size={18} className="animate-spin" /> : selected === 'new' ? <Plus size={18} /> : <Save size={18} />}{saving ? t('Saving...', 'Sine-save...') : t('Save contacts', 'I-save ang mga contact')}</button>
          </fieldset>
        </form>
        <label className="block border-t border-slate-200 pt-3 text-sm font-semibold">{t('Fishpen for manual water alerts', 'Fishpen para sa manwal na babala')}<select className={input} value={manual} onChange={e => { setManual(e.target.value); localStorage.setItem(manualSmsPenKey(ownerId), e.target.value); }}>
          <option value="">{t('No manual SMS', 'Walang manwal na SMS')}</option>
          {data.fishpens.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
      </>}
      {error && <p role="alert" className="text-sm text-red-700">{t('Unable to save or load settings. ', 'Hindi ma-save o makuha ang settings. ')}{error}</p>}
      {message && <p role="status" className="text-sm text-teal-800">{message}</p>}
    </div>
  </details>;
}
