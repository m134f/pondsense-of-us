import { useState } from "react";
import { Activity, LoaderCircle } from "lucide-react";
import type { WaterParams } from "../types";

const fields: { key: keyof WaterParams; label: string; unit: string; min: number; max: number; step: number }[] = [
  { key: "ph", label: "pH", unit: "", min: 4, max: 11, step: 0.01 },
  { key: "temperature", label: "Temperature", unit: "°C", min: 10, max: 40, step: 0.1 },
  { key: "dissolvedOxygen", label: "Dissolved oxygen", unit: "mg/L", min: 0, max: 15, step: 0.01 },
  { key: "turbidity", label: "Turbidity", unit: "NTU", min: 0, max: 500, step: 0.1 },
  { key: "ammonia", label: "Ammonia", unit: "mg/L", min: 0, max: 0.5, step: 0.001 }
];

export function ManualWaterForm({ lang, onAnalyze }: { lang: "en" | "tl"; onAnalyze: (values: Partial<WaterParams>) => void | Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [edited, setEdited] = useState(false);
  return <form className="card space-y-4 p-5" onSubmit={async event => {
    event.preventDefault();
    const values: Partial<WaterParams> = {};
    for (const field of fields) {
      const raw = draft[field.key]?.trim();
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < field.min || value > field.max) {
        setError(lang === "tl" ? "Suriin ang mga inilagay na sukat." : "Check the measurements you entered.");
        return;
      }
      values[field.key] = value;
    }
    if (!Object.keys(values).length) {
      setError(lang === "tl" ? "Maglagay ng kahit isang sukat." : "Enter at least one measurement.");
      return;
    }
    setBusy(true); setError("");
    try { await onAnalyze(values); setEdited(false); }
    catch { setError(lang === "tl" ? "Hindi naisumite. Subukan muli." : "Could not submit. Please try again."); }
    finally { setBusy(false); }
  }}>
    <h2 className="text-lg font-bold">{lang === "tl" ? "Manu-manong pagsusuri" : "Manual water analysis"}</h2>
    <p className="text-sm text-slate-600">{lang === "tl" ? "Aktuwal na sukat mula sa iyong water test." : "Actual measurements from your water test."}</p>
    {fields.map(field => <label key={field.key} className="block text-sm font-semibold" htmlFor={`manual-${field.key}`}>
      {field.label} {field.unit && <span className="font-normal text-slate-500">({field.unit})</span>}
      <input id={`manual-${field.key}`} type="number" inputMode="decimal" min={field.min} max={field.max} step={field.step} disabled={busy}
        className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-base focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-100"
        value={draft[field.key] ?? ""} onChange={event => { setDraft({ ...draft, [field.key]: event.target.value }); setEdited(true); }} />
    </label>)}
    {edited && <p className="text-sm text-amber-800">{lang === "tl" ? "Hindi pa naisumite ang mga pagbabago." : "Changes have not been submitted."}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button disabled={busy} className="primary-button w-full disabled:opacity-60">{busy ? <LoaderCircle size={18} className="animate-spin" /> : <Activity size={18} />}{busy ? (lang === "tl" ? "Sinusuri…" : "Analyzing…") : (lang === "tl" ? "Suriin ang tubig" : "Analyze water quality")}</button>
  </form>;
}
