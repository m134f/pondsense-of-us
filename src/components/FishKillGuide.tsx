import { ExternalLink, ShieldAlert } from 'lucide-react';

const LLDA_PROTOCOL = 'https://llda.gov.ph/response-protocol-to-fishkill-english-and-tagalog/';

export function FishKillGuide({ lang }: { lang: 'en' | 'tl' }) {
  const tl = lang === 'tl';
  return <aside className="rounded-md border border-amber-300 bg-amber-50 p-4 text-slate-900" aria-label={tl ? 'Gabay sa biglaang fish kill' : 'Sudden fish kill response guide'}>
    <div className="flex items-start gap-3">
      <ShieldAlert className="mt-0.5 shrink-0 text-amber-800" size={22} aria-hidden="true" />
      <div className="min-w-0">
        <h2 className="font-bold">{tl ? 'Kung biglang maraming namatay na isda' : 'If many fish die suddenly'}</h2>
        <p className="mt-1 text-sm text-slate-700">{tl ? 'Sundin ang gabay ng LLDA. Ang pag-save ng tala rito ay hindi awtomatikong pag-uulat sa LLDA.' : 'Follow LLDA guidance. Saving a record here does not report the incident to LLDA.'}</p>
      </div>
    </div>
    <ol className="mt-4 space-y-3 pl-1 text-sm leading-relaxed">
      <li><strong>1. {tl ? 'Itala ang obserbasyon.' : 'Record observations.'}</strong> {tl ? 'Petsa at oras, lokasyon, may-ari at contact, apektadong lugar, uri at bilang ng isda, panahon, at mga larawan kung ligtas kumuha.' : 'Note date and time, location, owner and contact, affected area, fish species and count, weather, and photos if safe.'}</li>
      <li><strong>2. {tl ? 'I-report sa LLDA.' : 'Report to LLDA.'}</strong> {tl ? 'Ibahagi ang naitalang detalye; makikita ang opisyal na contact sa link sa ibaba.' : 'Share the observations; use the current official contact details in the link below.'}</li>
      <li><strong>3. {tl ? 'Makipagtulungan sa response team.' : 'Assist the response team.'}</strong> {tl ? 'Tulungan ang on-site survey at pagkuha ng water samples ayon sa kanilang tagubilin.' : 'Help with the on-site survey and water sampling as directed.'}</li>
      <li><strong>4. {tl ? 'Ligtas na kolektahin at itapon.' : 'Collect and dispose safely.'}</strong> {tl ? 'Magsuot ng proteksiyon, ilagay sa saradong lalagyan, at sundin ang itinakdang disposal site at tagubilin ng LLDA/LGU/BFAR. Huwag itapon pabalik sa lawa.' : 'Wear protection, use sealed containers, and follow the designated disposal site and LLDA/LGU/BFAR directions. Do not return dead fish to the lake.'}</li>
    </ol>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <a href="/llda-fishkill-response.png" target="_blank" rel="noopener noreferrer" aria-label={tl ? 'Buksan ang LLDA fish kill response poster' : 'Open LLDA fish kill response poster'}>
        <img className="h-auto w-full border border-slate-200 bg-white" src="/llda-fishkill-response.png" alt={tl ? 'LLDA: apat na hakbang sa pagtugon sa fish kill' : 'LLDA: four-step response protocol to fish kill'} loading="lazy" />
      </a>
      <a href="/llda-dead-fish-disposal.png" target="_blank" rel="noopener noreferrer" aria-label={tl ? 'Buksan ang LLDA dead fish disposal poster' : 'Open LLDA dead fish disposal poster'}>
        <img className="h-auto w-full border border-slate-200 bg-white" src="/llda-dead-fish-disposal.png" alt={tl ? 'LLDA: gabay sa ligtas na pagtatapon ng patay na isda' : 'LLDA: safe dead fish disposal guidance'} loading="lazy" />
      </a>
    </div>
    <a className="mt-4 inline-flex min-h-11 items-center gap-2 font-semibold text-teal-800 underline underline-offset-2" href={LLDA_PROTOCOL} target="_blank" rel="noopener noreferrer">{tl ? 'Buksan ang buong gabay ng LLDA' : 'Open the full LLDA protocol'} <ExternalLink size={16} aria-hidden="true" /></a>
  </aside>;
}
