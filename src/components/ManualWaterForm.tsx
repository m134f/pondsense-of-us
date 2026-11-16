import { useState } from "react";
import { Activity, LoaderCircle } from "lucide-react";
import type { FishSpecies, WaterParams } from "../types";
import { manualLimits, manualWarnings, validateManual } from '../lib/manualValidation';

const fields: { key: keyof WaterParams; label: string; unit: string; min: number; max: number; step: number }[] = [
  { key: "ph", label: "pH", unit: "", min: 0, max: 14, step: 0.01 },
  { key: "temperature", label: "Temperature", unit: "°C", min: 0, max: 60, step: 0.1 }
];

export function ManualWaterForm({ lang, onAnalyze, fish = [] }: { fish?: FishSpecies[]; lang: "en" | "tl"; onAnalyze: (values: Partial<WaterParams>) => void | Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [edited, setEdited] = useState(false);
  const [review, setReview] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof WaterParams, string>>>({});
  const validation = validateManual(draft);
  const warnings = manualWarnings(validation.values, fish);
  return <form noValidate className="card space-y-4 p-5" onSubmit={async event => {
    event.preventDefault();
    setFieldErrors(validation.errors);
    if (Object.keys(validation.errors).length) return;
    const values: Partial<WaterParams> = {};
    for (const field of fields) {
      const raw = draft[field.key]?.trim();
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < manualLimits[field.key][0] || value > manualLimits[field.key][1]) {
        setError(lang === "tl" ? "Suriin ang mga inilagay na sukat." : "Check the measurements you entered.");
        return;
      }
      values[field.key] = value;
    }
    if (!Object.keys(values).length) {
      setError(lang === "tl" ? "Maglagay ng kahit isang sukat." : "Enter at least one measurement.");
      return;
    }
    if (!review) { setReview(true); setError(''); return; }
    if (warnings.length && !confirmed) return;
    setBusy(true); setError("");
    try { await onAnalyze(values); setEdited(false); }
    catch { setError(lang === "tl" ? "Hindi naisumite. Subukan muli." : "Could not submit. Please try again."); }
    finally { setBusy(false); }
  }}>
    <h2 className="text-lg font-bold">{lang === "tl" ? "Manu-manong pagsusuri" : "Manual water analysis"}</h2>
    <p className="text-sm text-slate-600">{lang === "tl" ? "Aktuwal na sukat mula sa iyong water test." : "Actual measurements from your water test."}</p>
    {fields.map(field => <label key={field.key} className="block text-sm font-semibold" htmlFor={`manual-${field.key}`}>
      {field.label} {field.unit && <span className="font-normal text-slate-500">({field.unit})</span>}
      <input id={`manual-${field.key}`} type="text" inputMode="decimal" disabled={busy || review} aria-invalid={!!fieldErrors[field.key]} aria-describedby={`manual-error-${field.key}`}
        className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-base focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-100"
        value={draft[field.key] ?? ""} onChange={event => { setDraft({ ...draft, [field.key]: event.target.value }); setEdited(true); setConfirmed(false); }} />
      {fieldErrors[field.key] && <span id={`manual-error-${field.key}`} role="alert" className="mt-1 block text-red-700">{lang === 'tl' ? 'Maglagay ng numero sa pagitan ng' : 'Enter a number between'} {fieldErrors[field.key]} {field.unit}.</span>}
      {review && warnings.includes(field.key) && <span className="mt-1 block text-amber-800">{lang === 'tl' ? 'Babala: Labas ito sa inirerekomendang saklaw ng ilang isda. Suriin muli ang sukat.' : 'Warning: Outside the recommended range for some fish species. Please check your measurement.'}</span>}
    </label>)}
    {review && <div className="space-y-3 border-t pt-3"><p className="font-semibold">{lang === 'tl' ? 'Suriin ang mga sukat sa itaas bago magpatuloy.' : 'Review the measurements above before continuing.'}</p>{warnings.length > 0 && <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{lang === 'tl' ? 'Sinuri ko muli ang mga sukat na may babala.' : 'I have checked the measurements with warnings.'}</label>}<button type="button" className="soft-button" disabled={busy} onClick={() => { setReview(false); setConfirmed(false); }}>{lang === 'tl' ? 'Itama ang mga sukat' : 'Edit measurements'}</button></div>}
    {edited && <p className="text-sm text-amber-800">{lang === "tl" ? "Hindi pa naisumite ang mga pagbabago." : "Changes have not been submitted."}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button disabled={busy || (review && warnings.length > 0 && !confirmed)} className="primary-button w-full disabled:opacity-60">{busy ? <LoaderCircle size={18} className="animate-spin" /> : <Activity size={18} />}{busy ? (lang === "tl" ? "Sinusuri…" : "Analyzing…") : review ? (lang === "tl" ? "Kumpirmahin at suriin" : "Confirm and analyze") : (lang === "tl" ? "Suriin ang mga inilagay" : "Review measurements")}</button>
  </form>;
}
