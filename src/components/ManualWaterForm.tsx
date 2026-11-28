import { useRef, useState } from "react";
import { Activity, LoaderCircle } from "lucide-react";
import type { FishSpecies, WaterParams } from "../types";
import { isManualDecimalDraft, manualParameters, manualWarnings, validateManual } from '../lib/manualValidation';

const fields = {
  ph: { en: 'pH', tl: 'pH', unit: '' },
  temperature: { en: 'Temperature', tl: 'Temperatura', unit: '\u00b0C' },
  dissolvedOxygen: { en: 'Dissolved Oxygen', tl: 'Natunaw na Oxygen', unit: 'mg/L' },
  turbidity: { en: 'Calibrated Turbidity', tl: 'Calibrated na Labo ng Tubig', unit: 'NTU' }
};

export function ManualWaterForm({ lang, onAnalyze, fish = [] }: { fish?: FishSpecies[]; lang: "en" | "tl"; onAnalyze: (values: Partial<WaterParams>, saveTime: string) => void | Promise<void> }) {
  const submitting = useRef(false);
  const alertOpen = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ key: string; time: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [edited, setEdited] = useState(false);
  const [saved, setSaved] = useState(false);
  const [review, setReview] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof WaterParams, string>>>({});
  const [numericErrors, setNumericErrors] = useState<Partial<Record<keyof WaterParams, boolean>>>({});
  const validation = validateManual(draft);
  const warnings = manualWarnings(validation.values, fish);
  const numericMessage = lang === 'tl' ? 'Numero lamang ang ilagay, halimbawa 7.2.' : 'Enter numbers only, for example 7.2.';
  const rangeMessage = (key: typeof manualParameters[number], range: string) =>
    `${lang === 'tl' ? 'Maglagay ng numero sa pagitan ng' : 'Enter a number between'} ${range}${fields[key].unit ? ` ${fields[key].unit}` : ''}.`;
  const focusField = (key: typeof manualParameters[number]) =>
    form.current?.querySelector<HTMLInputElement>(`#manual-${key}`)?.focus();
  const notify = async (title: string, message: string, icon: 'warning' | 'error', focus: () => void) => {
    alertOpen.current = true;
    try {
      const { default: Swal } = await import('sweetalert2');
      if (!form.current) return;
      await Swal.fire({
        titleText: title,
        text: message,
        icon,
        confirmButtonColor: '#087e74',
        heightAuto: false,
        returnFocus: false,
        didClose: focus
      });
    } catch {
      // The inline error stays available if the dialog cannot load.
      focus();
    } finally {
      alertOpen.current = false;
    }
  };
  const clearDraft = () => {
    pending.current = null;
    setDraft({}); setFieldErrors({}); setNumericErrors({}); setError('');
    setSaved(false); setEdited(false); setReview(false); setConfirmed(false);
  };
  return <form ref={form} noValidate className="card manual-water-form space-y-4 p-5" onSubmit={async event => {
    event.preventDefault();
    if (submitting.current || alertOpen.current || saved) return;
    setError('');
    setFieldErrors(validation.errors);
    const invalid = manualParameters.find(key => numericErrors[key] || validation.errors[key]);
    if (invalid) {
      const message = numericErrors[invalid] ? numericMessage : rangeMessage(invalid, validation.errors[invalid]!);
      await notify(lang === 'tl' ? `Itama ang ${fields[invalid][lang]}` : `Check ${fields[invalid][lang]}`, message, 'warning', () => focusField(invalid));
      return;
    }
    if (validation.empty) {
      const message = lang === 'tl' ? 'Maglagay ng kahit isang sukat.' : 'Enter at least one measurement.';
      setError(message);
      await notify(lang === 'tl' ? 'Walang sukat' : 'No measurements entered', message, 'warning', () => focusField('ph'));
      return;
    }
    if (!review) { setReview(true); setError(''); return; }
    if (warnings.length && !confirmed) return;
    const values = validation.values;
    const key = manualParameters.map(field => values[field] ?? '').join('|');
    if (pending.current?.key !== key) pending.current = { key, time: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() };
    submitting.current = true;
    setBusy(true); setError("");
    try {
      await onAnalyze(values, pending.current.time);
      pending.current = null;
      setEdited(false); setSaved(true); setReview(false); setConfirmed(false);
    } catch (failure) {
      const conflict = failure instanceof Error && failure.cause === 409;
      if (conflict) {
        pending.current = null; setReview(false); setConfirmed(false);
      }
      const message = conflict
        ? (lang === 'tl' ? 'Suriin ang oras ng device at i-review muli ang test.' : 'Check your device clock and review the test again.')
        : (lang === 'tl' ? 'Hindi nakumpirma ang pag-save. Subukan muli.' : 'Could not confirm the save. Please try again.');
      setError(message);
      void notify(lang === 'tl' ? 'Hindi nakumpirma ang pag-save' : 'Save not confirmed', message, 'error', () => submitButton.current?.focus());
    } finally { submitting.current = false; setBusy(false); }
  }}>
    <h2 className="text-lg font-bold">{lang === "tl" ? "Manu-manong pagsusuri" : "Manual water analysis"}</h2>
    <p className="text-sm text-slate-600">{lang === "tl" ? "Ilagay ang aktuwal na sukat. Iwanang blangko ang hindi nasukat." : "Enter actual measurements. Leave unmeasured fields blank."}</p>
    <div className="manual-measurement-fields">
    {manualParameters.map(key => ({ ...fields[key], key, rangeError: fieldErrors[key] })).map(field => <div key={field.key} className="min-w-0 text-sm">
      <label className="block font-semibold" htmlFor={`manual-${field.key}`}>{field[lang]} {field.unit && <span className="font-normal text-slate-500">({field.unit})</span>}</label>
      <input id={`manual-${field.key}`} type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" autoComplete="off" spellCheck={false} disabled={busy || review} aria-invalid={!!fieldErrors[field.key] || !!numericErrors[field.key]} aria-describedby={[fieldErrors[field.key] && `manual-error-${field.key}`, numericErrors[field.key] && `manual-numeric-${field.key}`].filter(Boolean).join(' ') || undefined}
        className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-base focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-100"
        value={draft[field.key] ?? ""} onChange={event => {
          const next = event.target.value;
          if (!isManualDecimalDraft(next)) { setNumericErrors(previous => ({ ...previous, [field.key]: true })); return; }
          setNumericErrors(previous => ({ ...previous, [field.key]: false }));
          setFieldErrors(previous => ({ ...previous, [field.key]: undefined }));
          setDraft({ ...draft, [field.key]: next.replace(',', '.') }); setEdited(true); setConfirmed(false); setSaved(false);
        }} />
      {numericErrors[field.key] && <span id={`manual-numeric-${field.key}`} role="alert" className="mt-1 block text-red-700">{numericMessage}</span>}
      {field.rangeError && <span id={`manual-error-${field.key}`} role="alert" className="mt-1 block text-red-700">{rangeMessage(field.key, field.rangeError)}</span>}
      {review && warnings.includes(field.key) && <span className="mt-1 block text-amber-800">{lang === 'tl' ? 'Babala: Labas ito sa inirerekomendang saklaw ng ilang isda. Suriin muli ang sukat.' : 'Warning: Outside the recommended range for some fish species. Please check your measurement.'}</span>}
    </div>)}
    </div>
    <p className="text-sm text-slate-600">{lang === 'tl' ? 'Sa labo ng tubig, ilagay lamang ang NTU mula sa calibrated na metro. Huwag maglagay ng tantiya.' : 'For turbidity, enter only an NTU reading from a calibrated meter. Leave it blank if you only have an estimate.'}</p>
    {review && <div className="space-y-3 border-t pt-3"><p className="font-semibold">{lang === 'tl' ? 'Suriin ang mga sukat sa itaas bago magpatuloy.' : 'Review the measurements above before continuing.'}</p>{warnings.length > 0 && <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{lang === 'tl' ? 'Sinuri ko muli ang mga sukat na may babala.' : 'I have checked the measurements with warnings.'}</label>}<button type="button" className="soft-button" disabled={busy} onClick={() => { setReview(false); setConfirmed(false); }}>{lang === 'tl' ? 'Itama ang mga sukat' : 'Edit measurements'}</button></div>}
    {edited && !review && <p className="text-sm text-slate-600">{lang === "tl" ? "Hindi pa nai-save ang mga sukat." : "Measurements not saved yet."}</p>}
    {saved && <p role="status" className="text-sm text-teal-800">{lang === 'tl' ? 'Nai-save ang manual test sa Session History.' : 'Manual test saved to Session History.'}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="manual-form-actions">
      {!saved && !review && <button type="button" className="soft-button" onClick={clearDraft} disabled={busy}>{lang === 'tl' ? 'I-clear' : 'Clear'}</button>}
      {saved ? <button key="new-test" type="button" className="primary-button" onClick={clearDraft}>{lang === 'tl' ? 'Magsimula ng bagong test' : 'Start another test'}</button> :
        <button key="review-test" type="submit" ref={submitButton} disabled={busy || (review && warnings.length > 0 && !confirmed)} className="primary-button disabled:opacity-60">{busy ? <LoaderCircle size={18} className="animate-spin" /> : <Activity size={18} />}{busy ? (lang === "tl" ? "Sinusuri…" : "Analyzing…") : review ? (lang === "tl" ? "Kumpirmahin at suriin" : "Confirm and analyze") : (lang === "tl" ? "Suriin ang mga inilagay" : "Review measurements")}</button>}
    </div>
  </form>;
}
