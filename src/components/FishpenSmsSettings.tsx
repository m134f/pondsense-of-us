import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { apiJson } from '../lib/api';

type Pen = { id: number; name: string; owner_enabled: boolean; caretaker_phone: string | null; caretaker_enabled: boolean };
type Settings = { fishpens: Pen[]; ownerPhone: string | null; configured: boolean; policy: { reviewed: boolean } };
export const manualSmsPenKey = (owner: string | number) => `pondsense:manual-sms-fishpen:${owner}`;
const maskedPhone = (phone: string) => `**** ${phone.slice(-4)}`;

export function FishpenSmsSettings({ ownerId, lang, defaultOpen }: { ownerId: string | number; lang: string; defaultOpen?: boolean }) {
  const tl = lang === 'tl';
  const t = (en: string, fil: string) => tl ? fil : en;
  const [result, setResult] = useState<{ ownerId: string | number; data: Settings | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiJson<Settings>('/api/fishpen-sms').then(({ data }) => {
      if (!cancelled) setResult({ ownerId, data });
    });
    return () => { cancelled = true; };
  }, [ownerId]);
  const current = result?.ownerId === ownerId ? result : null;
  const settings = current?.data;
  const data = Array.isArray(settings?.fishpens) && typeof settings?.policy?.reviewed === 'boolean' ? settings : null;
  const pen = data?.fishpens[0];
  const status = (phone: string | null, enabled: boolean) => phone
    ? `${maskedPhone(phone)} (${enabled ? t('Enabled', 'Naka-on') : t('Off', 'Naka-off')})`
    : t('Not set', 'Walang nakalagay');

  return <details open={defaultOpen} className="card p-4 sm:p-5">
    <summary className="cursor-pointer py-2 text-lg font-bold text-slate-900"><Bell size={18} className="mr-2 inline text-teal-700" aria-hidden="true" />{t('SMS Notifications', 'Mga Abiso sa SMS')}</summary>
    <div className="mt-2 space-y-4 text-sm text-slate-600">
      {!current && <p role="status">{t('Loading SMS settings...', 'Kinukuha ang mga setting ng SMS...')}</p>}
      {current && !data && <p role="alert" className="text-red-700">{t('SMS settings could not be loaded.', 'Hindi makuha ang mga setting ng SMS.')}</p>}
      {data && <>
        <p>{t('Automatic water alerts are sent only for confirmed critical sensor readings. Manual tests and warnings do not send SMS.', 'Nagpapadala lang ng awtomatikong SMS para sa kumpirmadong kritikal na sukat ng sensor. Walang SMS para sa manual test o babala.')}</p>
        {(!data.configured || !data.policy.reviewed) && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">{!data.policy.reviewed ? t('Automatic water SMS is awaiting administrator threshold review.', 'Naghihintay ng pagsusuri ng admin sa mga limitasyon bago magpadala ng awtomatikong SMS.') : t('Automatic water SMS is temporarily unavailable.', 'Pansamantalang hindi gumagana ang awtomatikong SMS para sa tubig.')}</p>}
        {pen ? <dl className="space-y-3 border-t border-slate-200 pt-3">
          <div><dt>{t('Fishpen', 'Fishpen')}</dt><dd className="font-semibold text-slate-900">{pen.name}</dd></div>
          <div><dt>{t('Fishpen owner', 'May-ari ng fishpen')}</dt><dd className="font-semibold text-slate-900">{status(data.ownerPhone, pen.owner_enabled)}</dd></div>
          <div><dt>{t('Caretaker', 'Tagapag-alaga')}</dt><dd className="font-semibold text-slate-900">{status(pen.caretaker_phone, pen.caretaker_enabled)}</dd></div>
        </dl> : <p>{t('No fishpen is assigned yet.', 'Wala pang nakatalagang fishpen.')}</p>}
        <p>{t('Contact the administrator to update SMS recipients.', 'Makipag-ugnayan sa admin para baguhin ang mga tatanggap ng SMS.')}</p>
      </>}
    </div>
  </details>;
}
