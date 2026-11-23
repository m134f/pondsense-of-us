import { LoaderCircle, RefreshCw } from 'lucide-react';
import { farmerBrand } from '../lib/farmerBrand';

export function SessionLoading({ error, onRetry, lang }: { error: string | null; onRetry: () => void; lang: 'en' | 'tl' }) {
  return <main className="grid min-h-screen place-items-center bg-slate-50 px-6 py-10">
    <div className="w-full max-w-sm text-center" role={error ? 'alert' : 'status'} aria-live="polite">
      <img src={farmerBrand.logo} alt="" width={64} height={64} className="mx-auto h-16 w-16 rounded-lg border border-slate-200 bg-white object-contain" />
      <h1 className="mt-5 text-2xl font-bold text-slate-950">{farmerBrand.name}</h1>
      {!error && <LoaderCircle className="mx-auto mt-6 animate-spin text-teal-700 motion-reduce:animate-none" size={28} aria-hidden="true" />}
      <p className="mt-4 text-base font-semibold text-slate-800">{error ? (lang === 'tl' ? 'Hindi makakonekta sa server' : 'Unable to connect') : (lang === 'tl' ? 'Binubuksan ang iyong fishpen dashboard' : 'Opening your fishpen dashboard')}</p>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{error || (lang === 'tl' ? 'Maaaring mas matagal ang unang koneksyon habang nagsisimula ang server.' : 'The first connection may take longer while the server starts.')}</p>
      {error && <button className="primary-button mt-6 min-h-12" onClick={onRetry}><RefreshCw size={18} />{lang === 'tl' ? 'Subukan ulit' : 'Try again'}</button>}
    </div>
  </main>;
}
