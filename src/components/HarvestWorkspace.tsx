import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { ArrowLeft, Plus, Download, Fish, CalendarDays, Scale, HeartPulse, ChevronRight, History, UsersRound, Banknote, CircleCheck, Package, AlertTriangle } from 'lucide-react';
import type { HarvestBatch } from '../App';
import { HarvestReview } from './HarvestReview';
import { daysUntilHarvest, harvestStock } from '../lib/harvest';
import { FishKillGuide } from './FishKillGuide';

export type GroupForm = { notes: string; sensorDeviceId: string; species: string; fishpenName: string; targetWeightG: string; reminderSms: boolean; stockingDate: string; stockedCount: string; targetHarvestDate: string; actualHarvestDate: string; harvestedKg: string; sellingPrice: string };
export type HarvestAction = 'batch' | 'harvest' | 'mortality';
export type SavedHarvest = { groupId: number; group: string; date: string; kg: number; complete: boolean; count: number | null; remaining: number | null };
type EventForm = { harvestType: string; harvestDate: string; fishCount: string; weightKg: string; pricePerKg: string; notes: string };
type DeathForm = { mortalityDate: string; deadCount: string; notes: string };
type Assignment = { id: number; name: string; deviceId: number | null } | null;
type Props = {
  lang: 'en' | 'tl'; today: string; assignment: Assignment; records: HarvestBatch[]; filtered: HarvestBatch[];
  totalKg: number; grossSales: number; loading: boolean; busy: boolean; message: { text: string; error?: boolean } | null; loadError: string; editingId: number | null;
  action: HarvestAction; showForm: boolean; selectedId: number | null; setSelectedId: (id: number | null) => void;
  form: GroupForm; setForm: Dispatch<SetStateAction<GroupForm>>;
  eventForm: EventForm; setEventForm: Dispatch<SetStateAction<EventForm>>;
  mortalityForm: DeathForm; setMortalityForm: Dispatch<SetStateAction<DeathForm>>;
  species: string[]; speciesImages: Record<string, string>; savedHarvest: SavedHarvest | null;
  onCreate: () => void; onAction: (action: HarvestAction, id?: number) => void;
  onCancel: () => Promise<boolean>; onSave: () => void; onSubmit: () => void; onEdit: (row: HarvestBatch) => void;
  onRemove: (id: number) => void; onExport: () => void; onRetry: () => void;
  penFilter: string; setPenFilter: (value: string) => void;
  speciesFilter: string; setSpeciesFilter: (value: string) => void;
  dateFilter: string; setDateFilter: (value: string) => void;
};
const control = 'mt-2 block w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-3 text-base';

export function HarvestWorkspace(p: Props) {
  const tl = p.lang === 'tl';
  const t = (en: string, fil: string) => tl ? fil : en;
  const [history, setHistory] = useState(false);
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const [suddenDeaths, setSuddenDeaths] = useState(false);
  const [finishedOnly, setFinishedOnly] = useState(false);
  const active = p.records.filter(row => !row.actualHarvestDate);
  const finished = p.records.filter(row => row.actualHarvestDate);
  const upcoming = [...active].filter(row => daysUntilHarvest(row.targetHarvestDate, p.today) <= 7).sort((a, b) => a.targetHarvestDate.localeCompare(b.targetHarvestDate));
  const selected = p.records.find(row => row.id === p.selectedId);
  const details = p.records.find(row => row.id === detailsId);
  const stock = (row: HarvestBatch) => harvestStock(row.stockedCount, row.mortalities, row.harvestEvents);
  const selectedStock = selected && stock(selected);
  const counts = (row: HarvestBatch) => {
    const balance = stock(row);
    const unknown = balance.uncounted > 0 || (!!row.actualHarvestDate && !row.harvestEvents.length);
    return <span className="harvest-stock-summary">
      <span>{t('Stocked', 'Inilagay')}: <strong>{balance.stocked.toLocaleString()}</strong></span>
      <span>{t('Harvested', 'Inani')}: <strong>{unknown ? `${balance.harvested.toLocaleString()}+` : balance.harvested.toLocaleString()}</strong></span>
      <span>{t('Deaths', 'Namatay')}: <strong>{balance.dead.toLocaleString()}</strong></span>
      {row.actualHarvestDate ? <span>{t('Closed', 'Sarado na')}</span>
        : <span>{t('Remaining', 'Natitira')}: <strong>{unknown ? `${t('up to', 'hanggang')} ` : ''}{balance.remaining.toLocaleString()}</strong></span>}
      {unknown && <span className="harvest-uncounted">{t('Count not recorded for some harvests', 'May aning walang nakatalang bilang')}</span>}
    </span>;
  };
  const date = (value: string) => new Date(value.slice(0, 10) + 'T00:00:00').toLocaleDateString(tl ? 'fil-PH' : 'en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  const title = { batch: t('Add Fish Group', 'Magdagdag ng Alaga'), harvest: t('Record Harvest', 'Itala ang Ani'), mortality: t('Record Fish Deaths', 'Itala ang Namatay na Isda') };
  const money = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
  const optional = (children: React.ReactNode) => <details className="harvest-optional"><summary>{t('Optional details', 'Iba pang detalye (opsyonal)')}</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div></details>;
  const notes = (value: string, onChange: (value: string) => void) => <label className="sm:col-span-2">{t('Notes', 'Mga tala')}<textarea className={control} maxLength={500} value={value} onChange={e => onChange(e.target.value)} /></label>;
  const back = async () => {
    if (!await p.onCancel()) return false;
    if (!p.showForm && !p.savedHarvest) {
      if (details) setDetailsId(null);
      else setHistory(false);
    }
    return true;
  };
  const backLabel = details && (p.showForm || p.savedHarvest) ? t('Back to Fish Group', 'Bumalik sa Grupo')
    : history && (details || p.showForm || p.savedHarvest) ? t('Back to Records', 'Bumalik sa mga Tala')
      : t('Back to Harvest', 'Bumalik sa Pag-aani');
  const complete = p.action === 'harvest' && p.eventForm.harvestType === 'complete';
  const entered = Number(p.action === 'harvest' ? p.eventForm.fishCount : p.mortalityForm.deadCount);
  const validCount = selectedStock && Number.isSafeInteger(entered) && entered > 0 && entered <= selectedStock.remaining;
  useEffect(() => { window.scrollTo(0, 0); }, [p.showForm, p.savedHarvest, history, detailsId]);
  useEffect(() => { if (!p.showForm) setSuddenDeaths(false); }, [p.showForm]);
  const overview = !p.showForm && !history && !details && !p.savedHarvest;
  const info = {
    batch: { Icon: Package, label: t('Fish Group', 'Grupo ng Isda'), text: t('Create a fish group for fish stocked together. The planned harvest date is your schedule, not a growth prediction.', 'Gumawa ng grupo para sa mga isdang sabay inilagay. Plano mo ang petsa ng ani, hindi hula ng paglaki.') },
    harvest: { Icon: Scale, label: t('Harvest Type', 'Uri ng Pag-aani'), text: t('Record a partial harvest to keep the group active, or a complete harvest to close the group.', 'Itala ang bahagyang ani para manatiling aktibo ang grupo, o kumpletong ani para isara ito.') },
    mortality: { Icon: AlertTriangle, label: t('Fish Deaths', 'Namatay na Isda'), text: t('Record the actual number of dead fish. For a sudden fish kill, open the LLDA response guide using the checkbox.', 'Itala ang aktuwal na bilang ng namatay. Kung biglaan at marami, gamitin ang checkbox para buksan ang gabay ng LLDA.') },
  }[p.action];
  const savedRows = details ? [
    ...details.samples.map(row => ({ id: `s${row.id}`, day: row.sampledAt, type: t('Measurement', 'Pagtimbang'), note: `${row.sampleSize} ${t('fish weighed', 'isdang tinimbang')}`, value: `${row.averageWeightG} g` })),
    ...details.mortalities.map(row => ({ id: `m${row.id}`, day: row.mortalityDate, type: t('Fish Deaths', 'Namatay na Isda'), note: row.notes, value: `${row.deadCount} ${t('fish', 'isda')}` })),
    ...details.harvestEvents.map(row => ({ id: `h${row.id}`, day: row.harvestDate, type: t('Harvest', 'Ani'), note: `${row.harvestType === 'complete' ? t('Complete harvest', 'Tapos na ani') : t('Partial harvest', 'Bahagyang ani')} · ${row.fishCount != null ? `${row.fishCount} ${t('fish', 'isda')}` : t('Count not recorded', 'Walang nakatalang bilang')}`, value: `${row.weightKg} kg` })),
    ...(details.actualHarvestDate && !details.harvestEvents.length ? [{ id: 'legacy-harvest', day: details.actualHarvestDate, type: t('Complete harvest', 'Tapos na ani'), note: t('Count not recorded', 'Walang nakatalang bilang'), value: details.harvestedKg == null ? '—' : `${details.harvestedKg} kg` }] : []),
  ].sort((a, b) => b.day.localeCompare(a.day)) : [];
  const metrics = [
    { Icon: UsersRound, label: t('Active Fish Groups', 'Mga Kasalukuyang Alaga'), value: active.length },
    { Icon: CalendarDays, label: t('Upcoming Harvests', 'Mga Paparating na Ani'), value: upcoming.filter(row => daysUntilHarvest(row.targetHarvestDate, p.today) >= 0).length },
    { Icon: Scale, label: t('Total Harvested', 'Kabuuang Ani'), value: `${p.totalKg.toLocaleString()} kg` },
    { Icon: Banknote, label: t('Gross Sales', 'Kabuuang Benta'), value: money.format(p.grossSales) },
  ];

  return <main id="harvest-workspace" className="farmer-harvest harvest-simple space-y-5">
    {!p.savedHarvest && <header className="harvest-page-heading"><div>{!overview && <button type="button" className="soft-button harvest-back" onClick={back}><ArrowLeft size={17} aria-hidden="true" />{backLabel}</button>}<h1>{p.showForm ? (p.editingId && p.action === 'batch' ? t('Edit Fish Group', 'Baguhin ang Tala ng Alaga') : title[p.action]) : history || details ? t('Harvest Records', 'Mga Tala ng Pag-aani') : t('Harvest Management', 'Pamamahala ng Pag-aani')}</h1><p className="mt-1 text-slate-600">{p.assignment?.name || t('Your fishpen records', 'Mga tala ng iyong fishpen')}</p></div>{overview && <button className="primary-button" disabled={p.loading || !p.assignment} onClick={p.onCreate}><Plus size={18} />{title.batch}</button>}</header>}
    {p.message && <div role={p.message.error ? 'alert' : 'status'} className={`farmer-alert ${p.message.error ? 'farmer-alert-error' : ''}`}>{p.message.text}</div>}
    {p.loadError && <div role="alert" className="farmer-alert farmer-alert-error"><span>{p.loadError}</span><button className="soft-button" onClick={p.onRetry}>{t('Try again', 'Subukan muli')}</button></div>}
    {!p.loading && !p.loadError && !p.assignment && <aside role="status" className="border-l-4 border-amber-500 bg-amber-50 p-4"><h2 className="font-bold">{t('Your fishpen needs to be assigned', 'Kailangan munang italaga ang iyong fishpen')}</h2><p className="mt-1 text-sm">{t('Ask the administrator to assign your fishpen. You can still view your saved records.', 'Ipa-assign sa administrator ang iyong fishpen. Makikita mo pa rin ang dati mong mga tala.')}</p></aside>}

    {details && !details.actualHarvestDate && !p.showForm && !p.savedHarvest && <div className="flex flex-wrap gap-3">{(['harvest', 'mortality'] as const).map(action => <button className="soft-button" key={action} disabled={!p.assignment || !!p.loadError || p.loading} onClick={() => p.onAction(action, details.id)}>{title[action]}</button>)}</div>}
    {p.savedHarvest ? <section className="harvest-success" aria-live="polite">
      <CircleCheck size={48} className="mx-auto text-teal-700" aria-hidden="true" />
      <h1>{t('Harvest Record Saved!', 'Nai-save ang Tala ng Ani!')}</h1>
      <div className="card p-5 text-left"><h2 className="mb-3 text-lg font-bold">{t('Harvest Summary', 'Buod ng Ani')}</h2><dl className="grid gap-3 sm:grid-cols-2">
        {[[t('Fish group', 'Grupo ng isda'), p.savedHarvest.group], [t('Harvested weight', 'Timbang ng ani'), `${p.savedHarvest.kg.toLocaleString()} kg`], [t('Harvest date', 'Petsa ng ani'), date(p.savedHarvest.date)],
          [t('Harvest type', 'Uri ng pag-aani'), p.savedHarvest.complete ? t('Complete harvest', 'Kumpletong ani') : t('Partial harvest', 'Bahagyang ani')],
          [t('Fish harvested', 'Isdang inani'), p.savedHarvest.count?.toLocaleString() ?? t('Count not recorded', 'Walang nakatalang bilang')],
          [t('Remaining', 'Natitira'), p.savedHarvest.complete ? t('Group closed', 'Sarado na ang grupo')
            : p.savedHarvest.remaining == null ? t('Balance unavailable', 'Hindi alam ang natitira')
              : `${selectedStock?.uncounted ? `${t('Up to', 'Hanggang')} ` : ''}${p.savedHarvest.remaining.toLocaleString()} ${t('fish', 'isda')}`]
        ].map(([label, value]) => <div key={label}><dt className="text-sm text-slate-600">{label}</dt><dd className="font-semibold">{value}</dd></div>)}
      </dl></div>
      <div className="flex flex-wrap justify-center gap-2"><button className="primary-button" onClick={async () => { if (await back()) { setDetailsId(null); setHistory(true); } }}><History size={17} />{t('View Harvest Records', 'Tingnan ang mga Tala')}</button>
        <button className="soft-button" disabled={!p.assignment || p.loading || p.busy || !!p.loadError || !active.length}
          onClick={() => p.onAction('harvest', p.savedHarvest?.complete || p.savedHarvest?.remaining === 0 ? undefined : p.savedHarvest?.groupId)}><Plus size={17} />{t('Add Another Record', 'Magdagdag ng Tala')}</button>
        <button className="soft-button" onClick={back}><ArrowLeft size={17} />{backLabel}</button></div>
    </section> : p.showForm ? <div className="harvest-form-layout"><form className="harvest-entry" onSubmit={e => { e.preventDefault(); p.action === 'batch' ? p.onSave() : p.onSubmit(); }}>
      <fieldset disabled={p.busy || !p.assignment || p.loading || (p.action !== 'batch' && !!p.loadError)} className="space-y-5 disabled:opacity-60"><div className="grid gap-5 sm:grid-cols-2">
      {p.action === 'batch' ? <>
        <label>{t('Kind of fish', 'Uri ng isda')}<select required className={control} value={p.form.species} onChange={e => p.setForm({ ...p.form, species: e.target.value })}>{[...new Set([...p.species, p.form.species])].map(name => <option key={name}>{name}</option>)}</select></label>
        <label>{t('Date fish were stocked', 'Petsa ng paglalagay ng isda')}<input required type="date" className={control} value={p.form.stockingDate} onChange={e => p.setForm({ ...p.form, stockingDate: e.target.value })}/></label>
        <label>{t('Number of fish stocked', 'Bilang ng inilagay na isda')}<input required type="number" min="1" step="1" className={control} value={p.form.stockedCount} onChange={e => p.setForm({ ...p.form, stockedCount: e.target.value })}/></label>
        <label>{t('Your planned harvest date', 'Planong petsa ng pag-aani')}<input required type="date" min={p.form.stockingDate} className={control} value={p.form.targetHarvestDate} onChange={e => p.setForm({ ...p.form, targetHarvestDate: e.target.value })}/></label>
      </> : <>
        <label>{t('Which fish group?', 'Aling grupo ng isda?')}<select required className={control} value={p.selectedId || ''} onChange={e => p.setSelectedId(Number(e.target.value) || null)}><option value="">{t('Choose your fish group', 'Piliin ang grupo ng isda')}</option>{active.map(row => <option key={row.id} value={row.id}>{row.species} · #{row.id} · {stock(row).remaining.toLocaleString()} {t('on record', 'sa tala')}</option>)}</select></label>
        {selectedStock && <div className="harvest-stock-preview sm:col-span-2" role="group" aria-label={t('Stock balance', 'Bilang ng natitira')}>
          <dl>
            <div><dt>{t('Available from records', 'Natitira sa tala')}</dt><dd>{selectedStock.uncounted ? `${t('Up to', 'Hanggang')} ` : ''}{selectedStock.remaining.toLocaleString()}</dd></div>
            <div><dt>{p.action === 'harvest' ? t('Fish to harvest', 'Isdang aanihin') : t('Deaths to record', 'Itatalang namatay')}</dt><dd>{validCount ? entered.toLocaleString() : '—'}</dd></div>
            <div><dt>{t('Remaining after save', 'Matitira pagkatapos i-save')}</dt><dd>{complete ? t('Group will close', 'Magsasara ang grupo')
              : validCount ? `${selectedStock.uncounted ? `${t('Up to', 'Hanggang')} ` : ''}${(selectedStock.remaining - entered).toLocaleString()}` : '—'}</dd></div>
          </dl>
          {selectedStock.uncounted > 0 && <p>{t('Count not recorded for some previous harvests.', 'May dating ani na walang nakatalang bilang.')}</p>}
        </div>}
        {p.action === 'harvest' ? <>
          <label>{t('Harvest date', 'Petsa ng pag-aani')}<input required type="date" max={p.today} min={selected?.stockingDate} className={control} value={p.eventForm.harvestDate} onChange={e => p.setEventForm({ ...p.eventForm, harvestDate: e.target.value })}/></label>
          <label>{t('Harvested weight (kg)', 'Timbang ng ani (kg)')}<input required type="number" min="0.01" step="any" className={control} value={p.eventForm.weightKg} onChange={e => p.setEventForm({ ...p.eventForm, weightKg: e.target.value })}/></label>
          <label>{t('Number of fish harvested', 'Bilang ng inaning isda')}{complete && t(' (optional)', ' (opsyonal)')}
            <input required={!complete} type="number" inputMode="numeric" min="1" step="1" max={selectedStock?.remaining} className={control} value={p.eventForm.fishCount} onChange={e => p.setEventForm({ ...p.eventForm, fishCount: e.target.value })}/></label>
          <label className="sm:col-span-2">{t('Are you finishing this fish group?', 'Tapos na ba ang pag-aani sa grupong ito?')}<select className={control} value={p.eventForm.harvestType} onChange={e => p.setEventForm({ ...p.eventForm, harvestType: e.target.value })}><option value="partial">{t('No — harvesting some fish only', 'Hindi — bahagi lang ang inani')}</option><option value="complete">{t('Yes — finish this fish group', 'Oo — tapusin ang grupong ito')}</option></select><span className="mt-2 block text-sm font-normal text-slate-600">{t('Partial harvest keeps the group active. Completing it requires confirmation.', 'Aktibo pa rin ang grupo kung bahagi lang ang inani. Kailangan ng kumpirmasyon bago tapusin.')}</span></label>
        </> : <>
          <label>{t('Date fish died', 'Petsa ng pagkamatay')}<input required type="date" min={selected?.stockingDate} max={p.today} className={control} value={p.mortalityForm.mortalityDate} onChange={e => p.setMortalityForm({ ...p.mortalityForm, mortalityDate: e.target.value })}/></label>
          <label>{t('Number of dead fish', 'Bilang ng namatay na isda')}<input required type="number" inputMode="numeric" min="1" step="1" max={selectedStock?.remaining} className={control} value={p.mortalityForm.deadCount} onChange={e => p.setMortalityForm({ ...p.mortalityForm, deadCount: e.target.value })}/></label>
          <div className="sm:col-span-2"><label className="flex min-h-11 items-center gap-3 font-semibold"><input type="checkbox" className="h-5 w-5 shrink-0 accent-amber-700" checked={suddenDeaths} onChange={e => setSuddenDeaths(e.target.checked)}/>{t('Many fish died suddenly', 'Biglang maraming namatay na isda')}</label>{suddenDeaths && <details className="refine-disclosure"><summary>{t('LLDA fish-kill response guide', 'Gabay ng LLDA sa fish kill')}</summary><FishKillGuide lang={p.lang}/></details>}</div>
        </>}
      </>}
      </div>
      {optional(p.action === 'batch' ? <>
        <label>{t('Target weight per fish (g)', 'Target na timbang bawat isda (g)')}<input type="number" min="0.1" step="any" className={control} value={p.form.targetWeightG} onChange={e => p.setForm({ ...p.form, targetWeightG: e.target.value })}/></label>
        <label className="flex items-center gap-3"><input type="checkbox" checked={p.form.reminderSms} onChange={e => p.setForm({ ...p.form, reminderSms: e.target.checked })}/>{t('Send harvest SMS reminders when available', 'Magpadala ng SMS na paalala kung available')}</label>
        <p className="text-sm text-slate-600 sm:col-span-2">{t('Reminders: 7 days before, 1 day before, and on your planned date. Sending depends on the SMS service.', 'Paalala: 7 araw bago, 1 araw bago, at sa planong petsa. Nakadepende sa SMS service ang pagpapadala.')}</p>
        {notes(p.form.notes, value => p.setForm({ ...p.form, notes: value }))}
      </> : p.action === 'harvest' ? <>
        <label>{t('Selling price per kg (₱)', 'Presyo bawat kg (₱)')}<input type="number" min="0" step="any" className={control} value={p.eventForm.pricePerKg} onChange={e => p.setEventForm({ ...p.eventForm, pricePerKg: e.target.value })}/></label>
        {notes(p.eventForm.notes, value => p.setEventForm({ ...p.eventForm, notes: value }))}
      </> : notes(p.mortalityForm.notes, value => p.setMortalityForm({ ...p.mortalityForm, notes: value }))) }
      <div className="harvest-form-actions"><button type="button" className="soft-button" onClick={back}>{t('Cancel', 'Kanselahin')}</button><button type="submit" className="primary-button" disabled={p.busy || (p.action !== 'batch' && !selected)}>{p.busy ? t('Saving…', 'Sine-save…') : p.action === 'batch' ? t('Save Fish Group', 'I-save ang Grupo') : t('Save Record', 'I-save ang Tala')}</button></div>
      </fieldset>
    </form><aside className={`harvest-form-note ${p.action === 'mortality' ? 'harvest-form-warning' : ''}`}><h2><info.Icon size={19} aria-hidden="true" />{info.label}</h2><p className="mt-2 text-sm">{info.text}</p></aside></div> : details ? <section className="space-y-4"><div className="card flex flex-wrap items-center justify-between gap-4 p-4"><h2 className="text-lg font-bold">{details.species} #{details.id}</h2><div className="text-sm"><p>{t('Stocked', 'Inilagay')}: {date(details.stockingDate)}</p><p>{t('Planned harvest', 'Planong ani')}: {date(details.targetHarvestDate)}</p></div>{counts(details)}<div className="flex flex-wrap gap-2"><button className="soft-button" disabled={!p.assignment} onClick={() => p.onEdit(details)}>{t('Edit fish group', 'Baguhin ang tala')}</button><button className="soft-button text-red-700" disabled={!p.assignment} onClick={() => p.onRemove(details.id)}>{t('Delete fish group', 'Burahin ang grupo')}</button></div></div><p className="text-sm text-slate-600">{t('Based only on recorded deaths and harvested fish counts. Missing fish are not assumed dead.', 'Batay lamang sa naitalang namatay at inaning bilang. Hindi awtomatikong patay ang nawawalang isda.')}</p>
      <h2 className="text-lg font-bold">{t('Saved Records', 'Mga Naitalang Datos')}</h2>
      {savedRows.length === 0 ? <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">{t('No records for this group yet.', 'Wala pang tala para sa grupong ito.')}</p> : <>
      <ul className="grid gap-2 sm:hidden">{savedRows.map(row => <li key={row.id} className="card p-3"><div className="flex flex-wrap justify-between gap-x-3"><strong>{row.type}</strong><span className="font-semibold text-teal-800">{row.value}</span></div><p className="text-sm text-slate-600">{date(row.day)}</p>{row.note && <p className="mt-1 text-sm">{row.note}</p>}</li>)}</ul>
      <div className="farmer-table-frame hidden sm:block" tabIndex={0} aria-label={t('Saved Records', 'Mga Naitalang Datos')}>
        <table className="harvest-record-table">
          <thead><tr>{[t('Date', 'Petsa'), t('Record Type', 'Uri ng Tala'), t('Details', 'Detalye'), t('Quantity / Weight', 'Bilang / Timbang')].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>
            {savedRows.map(row => <tr key={row.id}><td>{date(row.day)}</td><td>{row.type}</td><td className="break-words">{row.note || '—'}</td><td>{row.value}</td></tr>)}
          </tbody>
        </table>
      </div></>}<HarvestReview batch={details} lang={p.lang}/>
    </section> : history ? <section className="space-y-4"><div className="flex flex-wrap justify-between gap-3"><p>{p.records.filter(row => row.actualHarvestDate).length} {t('completed fish groups', 'natapos na grupo')}</p><button className="soft-button" onClick={p.onExport} disabled={!p.filtered.length}><Download size={17}/>{t('Export CSV', 'I-export ang CSV')}</button></div><details className="harvest-optional"><summary>{t('Filter records', 'Salain ang mga tala')}</summary><div className="mt-4 grid gap-4 sm:grid-cols-3"><label>{t('Fishpen (including old records)', 'Fishpen (kasama ang dating tala)')}<input className={control} value={p.penFilter} onChange={e => p.setPenFilter(e.target.value)}/></label><label>{t('Kind of fish', 'Uri ng isda')}<select className={control} value={p.speciesFilter} onChange={e => p.setSpeciesFilter(e.target.value)}><option value="">{t('All fish', 'Lahat ng isda')}</option>{[...new Set(p.records.map(row => row.species))].map(name => <option key={name}>{name}</option>)}</select></label><label>{t('Planned harvest from', 'Planong ani mula')}<input type="date" className={control} value={p.dateFilter} onChange={e => p.setDateFilter(e.target.value)}/></label></div></details>{p.filtered.map(row => <button key={row.id} className="harvest-group-row" onClick={() => setDetailsId(row.id)}><span><strong>{row.species} · #{row.id}</strong><span className="block text-sm">{row.fishpenName} · {date(row.targetHarvestDate)}</span>{counts(row)}</span><span>{row.actualHarvestDate ? t('Completed', 'Tapos na') : t('Active', 'Aktibo')}</span><ChevronRight size={18}/></button>)}{!p.filtered.length && <p>{t('No records match these filters.', 'Walang tumugmang tala sa mga filter.')}</p>}</section> : <>
      <section className="harvest-overview"><dl className="harvest-metrics">{metrics.map(({ Icon, label, value }) => <div key={label}><Icon size={25} aria-hidden="true" /><dt>{label}</dt><dd>{p.loading || (p.loadError && !p.records.length) ? '—' : value}</dd></div>)}</dl><p className="mt-3 text-sm text-slate-600">{t('Upcoming: next 7 days. Sales reflect recorded prices, before expenses.', 'Paparating: sa loob ng 7 araw. Batay sa naitalang presyo ang benta, hindi pa bawas ang gastos.')}</p></section>
      <section className="harvest-quick-actions" aria-label={t('Harvest actions', 'Mga gawain sa pag-aani')}>{([{ key: 'harvest', icon: Scale }, { key: 'mortality', icon: HeartPulse }] as const).map(({key, icon: Icon}) => <button key={key} disabled={p.loading || !!p.loadError || !p.assignment || !active.length} onClick={() => p.onAction(key)}><Icon size={19}/><span>{title[key]}</span></button>)}<button onClick={() => { setHistory(true); setFinishedOnly(false); }}><History size={19}/><span>{t('View Records', 'Tingnan ang mga Tala')}</span></button></section>
      <details className="rounded-md border border-amber-200 bg-white p-4"><summary className="min-h-11 cursor-pointer py-2 font-semibold text-amber-900">{t('Sudden fish deaths? View LLDA response guide', 'Biglaang fish kill? Tingnan ang gabay ng LLDA')}</summary><div className="mt-3"><FishKillGuide lang={p.lang}/></div></details>
      {p.loading ? <p role="status">{t('Loading your fish groups…', 'Kinukuha ang iyong mga alaga…')}</p> : p.loadError && !p.records.length ? null : <>
        <section><h2 className="mb-3 text-lg font-bold">{t('Upcoming harvest dates', 'Mga Planong Petsa ng Ani')}</h2>{upcoming.length ? upcoming.map(row => { const days = daysUntilHarvest(row.targetHarvestDate, p.today); return <button className="harvest-group-row" key={row.id} onClick={() => setDetailsId(row.id)}><CalendarDays size={21}/><span className="flex-1"><strong>{row.species}</strong><span className="block text-sm">{date(row.targetHarvestDate)}</span></span><span className={days < 0 ? 'text-amber-800' : 'text-teal-800'}>{days < 0 ? t('Past planned date', 'Lampas sa plano') : days === 0 ? t('Planned today', 'Plano ngayong araw') : t(`${days} days left`, `${days} araw pa`)}</span><ChevronRight size={18}/></button>; }) : <p className="text-sm text-slate-600">{t('No harvest planned in the next 7 days.', 'Walang planong ani sa susunod na 7 araw.')}</p>}</section>
        <section>
          <div className="harvest-tabs" aria-label={t('Fish groups', 'Mga grupo ng isda')}>
            <button aria-pressed={!finishedOnly} onClick={() => setFinishedOnly(false)}>{t('Active Groups', 'Mga Aktibong Grupo')} ({active.length})</button>
            <button aria-pressed={finishedOnly} onClick={() => setFinishedOnly(true)}>{t('Finished Harvests', 'Mga Natapos na Ani')} ({finished.length})</button>
          </div>
          {(finishedOnly ? finished : active).map(row => <button key={row.id} className="harvest-group-row harvest-species-row" onClick={() => setDetailsId(row.id)}>
            {p.speciesImages[row.species] ? <img src={p.speciesImages[row.species]} alt="" loading="lazy" width="112" height="76"/> : <Fish size={25}/>}
            <span><strong>{row.species} · #{row.id}</strong><span className="block text-sm text-slate-600">{t('Stocked', 'Inilagay')}: {date(row.stockingDate)}</span><span className="block text-sm text-slate-600">{row.actualHarvestDate ? t('Harvested', 'Inani') : t('Planned harvest', 'Planong ani')}: {date(row.actualHarvestDate || row.targetHarvestDate)}</span>{counts(row)}</span>
            <span className={row.actualHarvestDate ? 'harvest-pill completed' : 'harvest-pill'}>{row.actualHarvestDate ? t('Completed', 'Tapos na') : t('Active', 'Aktibo')}</span><ChevronRight size={18}/>
          </button>)}
          {!(finishedOnly ? finished.length : active.length) && <div className="harvest-empty"><Fish size={28}/><h3 className="font-bold">{finishedOnly ? t('No completed harvests yet', 'Wala pang natapos na ani') : t('No active fish groups yet', 'Wala pang kasalukuyang alaga')}</h3>{!finishedOnly && <p>{t('Add the fish you stocked to start keeping harvest records.', 'Idagdag ang inilagay mong isda para makapagsimula ng tala sa pag-aani.')}</p>}</div>}
        </section>
      </>}
      <p className="border-t border-slate-200 pt-4 text-sm text-slate-600">{t('Harvest dates are your plans, not predictions of growth or yield.', 'Ang petsa ng ani ay plano mo, hindi hula ng paglaki o dami ng ani.')}</p>
    </>}
  </main>;
}
