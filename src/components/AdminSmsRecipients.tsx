import { useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import { apiJson } from '../lib/api';
import { confirmAction } from '../lib/actionAlerts';
import { AdminLoad, useAdminResource } from './AdminControls';

type Contact = { id: number; name: string; loginPhone: string | null; ownerAlertPhone: string | null; ownerPhone: string | null; caretakerPhone: string | null; caretakerEnabled: boolean };
const normalize = (phone: string) => phone.trim().replace(/[\s()-]/g, '').replace(/^0(?=9)/, '+63').replace(/^63/, '+63');
const masked = (phone: string | null) => phone ? `ending in ${phone.slice(-4)}` : 'not set';

function RecipientsForm({ saved, url }: { saved: Contact; url: string }) {
  const [contact, setContact] = useState(saved);
  const [ownerPhone, setOwnerPhone] = useState(saved.ownerAlertPhone ?? '');
  const [phone, setPhone] = useState(saved.caretakerPhone ?? '');
  const [enabled, setEnabled] = useState(saved.caretakerEnabled);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const normalizedCaretaker = normalize(phone);
  const duplicate = !!normalizedCaretaker && normalizedCaretaker === (ownerPhone.trim() ? normalize(ownerPhone) : contact.loginPhone);
  const needsConsent = enabled && !duplicate && (!contact.caretakerEnabled || normalizedCaretaker !== contact.caretakerPhone);
  const caretakerEnabled = enabled && !duplicate;
  const ownerOverride = normalize(ownerPhone);
  const ownerChanged = ownerOverride !== normalize(contact.ownerAlertPhone ?? '');
  const caretakerChanged = normalizedCaretaker !== normalize(contact.caretakerPhone ?? '') || caretakerEnabled !== contact.caretakerEnabled;
  const updatePhone = (value: string) => { setPhone(value); setConsent(false); setNotice(null); };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (!ownerChanged && !caretakerChanged) || (needsConsent && !consent)) return;
    const summary = [
      ownerChanged && `Owner: ${masked(contact.ownerPhone)} to ${masked(ownerOverride || contact.loginPhone)}${ownerOverride ? '' : ' (login number)'}.`,
      caretakerChanged && `Caretaker: ${masked(normalizedCaretaker)}, alerts ${caretakerEnabled ? 'on' : 'off'}.`,
      'Saving does not send an SMS.'
    ].filter(Boolean).join('\n');
    const source = (event.nativeEvent as SubmitEvent).submitter ?? event.currentTarget;
    setBusy(true);
    try {
      if (!await confirmAction({ source, title: `Save SMS recipients for ${contact.name}?`, text: summary, label: 'Save recipients' })) return;
      setNotice(null);
      const { data, error } = await apiJson<{ fishpen: Contact }>(url, { method: 'PUT',
        body: JSON.stringify({ fishpenId: contact.id, ownerAlertPhone: ownerPhone.trim() || null, caretakerPhone: phone.trim() || null, caretakerEnabled, consentConfirmed: consent }) });
      if (!data?.fishpen) { setNotice({ text: error || 'Unable to save SMS recipients.', error: true }); return; }
      setContact(data.fishpen); setOwnerPhone(data.fishpen.ownerAlertPhone ?? ''); setPhone(data.fishpen.caretakerPhone ?? ''); setEnabled(data.fishpen.caretakerEnabled); setConsent(false);
      setNotice({ text: 'SMS recipients saved. No message was sent.' });
    } finally { setBusy(false); }
  }

  return <form onSubmit={save} className="mt-3 space-y-3">
    <dl className="admin-definition">
      <div><dt>Fishpen</dt><dd>{contact.name}</dd></div>
      <div><dt>Farmer login number</dt><dd>{contact.loginPhone || 'Not set'}</dd></div>
      <div><dt>Current owner SMS recipient</dt><dd>{contact.ownerPhone || 'Not set'}</dd></div>
    </dl>
    <fieldset disabled={busy} className="space-y-3">
      <label className="block text-sm font-semibold">Owner SMS number (optional)
        <input type="tel" autoComplete="off" inputMode="tel" placeholder="Uses login number if blank" maxLength={25} className="mt-1 block w-full" value={ownerPhone} onChange={e => { setOwnerPhone(e.target.value); setConsent(false); setNotice(null); }} />
      </label>
      <label className="block text-sm font-semibold">Caretaker mobile number (optional)
        <input type="tel" autoComplete="off" inputMode="tel" placeholder="09XXXXXXXXX" maxLength={25} className="mt-1 block w-full" value={phone} onChange={e => updatePhone(e.target.value)} />
      </label>
      <label className="admin-recipient-check flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={enabled && !duplicate} disabled={duplicate} onChange={e => { setEnabled(e.target.checked); setConsent(false); setNotice(null); }} />Send confirmed critical water alerts to caretaker</label>
      {duplicate && <p className="admin-muted">This is the owner&apos;s number. No separate caretaker alert will be sent.</p>}
      {needsConsent && <label className="admin-recipient-check flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={consent} required onChange={e => setConsent(e.target.checked)} />The caretaker agreed to receive these text messages.</label>}
      <button type="submit" className="primary-button" disabled={busy || (!ownerChanged && !caretakerChanged) || (needsConsent && !consent)}><Save size={16} aria-hidden="true" />{busy ? 'Saving...' : 'Save SMS recipients'}</button>
    </fieldset>
    {notice && <p role={notice.error ? 'alert' : 'status'} className="admin-notice" data-tone={notice.error ? 'warning' : 'good'}>{notice.text}</p>}
  </form>;
}

function Recipients({ ownerId }: { ownerId: number }) {
  const url = `/api/admin/owners/${ownerId}/sms-recipients`;
  const resource = useAdminResource<{ fishpen: Contact | null }>(url);
  return <>
    <AdminLoad resource={resource} />
    {resource.data && !resource.error && (resource.data.fishpen ? <RecipientsForm saved={resource.data.fishpen} url={url} />
      : <p className="admin-muted">No fishpen is assigned to this farmer.</p>)}
  </>;
}

export function AdminSmsRecipients({ ownerId }: { ownerId: number }) {
  const [open, setOpen] = useState(false);
  return <details className="admin-detail-section" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>SMS recipients</summary>
    {open && <Recipients key={ownerId} ownerId={ownerId} />}
  </details>;
}
