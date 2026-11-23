import { useEffect, useRef, type MouseEvent } from 'react';
import { BarChart3, CalendarDays, Clock3, Ellipsis, History, House, LogOut, Radio, UserRound, X } from 'lucide-react';
import { farmerBrand } from '../lib/farmerBrand';

type Props = {
  path: string;
  lang: 'en' | 'tl';
  name: string;
  fishpen: string;
  clockText: string;
  navigate: (path: string) => void;
  setLang: (lang: 'en' | 'tl') => void;
  onLogout: () => void;
};

export function FarmerLanguage({ lang, setLang }: Pick<Props, 'lang' | 'setLang'>) {
  return <div className="farmer-language" role="group" aria-label={lang === 'tl' ? 'Wika' : 'Language'}>
    <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>English</button>
    <button type="button" aria-pressed={lang === 'tl'} onClick={() => setLang('tl')}>Filipino</button>
  </div>;
}

export function FarmerNavigation({ path, lang, name, fishpen, clockText, navigate, setLang, onLogout }: Props) {
  const tl = lang === 'tl';
  const more = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 900px)');
    const closeOnDesktop = () => { if (!mobile.matches) more.current?.close(); };
    mobile.addEventListener('change', closeOnDesktop);
    return () => mobile.removeEventListener('change', closeOnDesktop);
  }, []);
  useEffect(() => { more.current?.close(); }, [path]);

  const links = [
    { href: '/dashboard', label: tl ? 'Tahanan' : 'Home', Icon: House },
    { href: '/analysis', label: tl ? 'Pagsusuri' : 'Analysis', Icon: BarChart3 },
    { href: '/history', label: tl ? 'Kasaysayan' : 'Session History', Icon: History },
    { href: '/harvest', label: tl ? 'Pag-aani' : 'Harvest', Icon: CalendarDays },
    { href: '/profile', label: tl ? 'Account at Settings' : 'Account & Settings', Icon: UserRound },
  ];
  const follow = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    more.current?.close();
    if (path !== href) navigate(href);
  };
  const navLink = ({ href, label, Icon }: typeof links[number]) => <a key={href} href={href} aria-current={path === href || (href === '/profile' && path === '/profile/device-sms') ? 'page' : undefined} onClick={e => follow(e, href)}>
    <Icon size={19} aria-hidden="true" /><span>{label}</span>
  </a>;
  const brand = <a className="farmer-brand" href="/dashboard" onClick={e => follow(e, '/dashboard')}>
    <img src={farmerBrand.logo} alt="" width="32" height="32" /><span>{farmerBrand.name}</span>
  </a>;
  const moreLabel = tl ? 'Iba pa' : 'More';
  const logoutLabel = tl ? 'Mag-logout' : 'Logout';
  return <>
    <aside className="farmer-nav">
      <div className="farmer-brand-bar">{brand}</div>
      <nav className="farmer-nav-links" aria-label={tl ? 'Menu ng may-ari' : 'Farmer navigation'}>
        <p className="farmer-nav-caption">{tl ? 'Para sa May-ari' : 'Farmer Workspace'}</p>
        {links.map(navLink)}
      </nav>
      <div className="farmer-nav-footer"><button type="button" onClick={onLogout}><LogOut size={18} aria-hidden="true" />{logoutLabel}</button></div>
    </aside>
    <header className="farmer-topbar">
      <div className="farmer-topbar-brand">{brand}</div>
      <span className="farmer-topbar-pen"><Radio size={17} aria-hidden="true" />{fishpen}</span>
      <div className="farmer-topbar-account"><span className="farmer-topbar-clock"><Clock3 size={16} aria-hidden="true" />{clockText}</span><FarmerLanguage lang={lang} setLang={setLang} /><a href="/profile" onClick={e => follow(e, '/profile')} aria-label={`${links[4].label}: ${name}`}><UserRound size={17} aria-hidden="true" /><span>{name}</span></a></div>
    </header>
    <nav className="farmer-bottom-nav" aria-label={tl ? 'Menu sa telepono' : 'Mobile navigation'}>
      {[links[0], links[1], links[3]].map(navLink)}
      <button type="button" data-active={path === '/history' || path.startsWith('/profile')} aria-haspopup="dialog" aria-controls="farmer-more" onClick={() => more.current?.showModal()}><Ellipsis size={20} aria-hidden="true" />{moreLabel}</button>
    </nav>
    <dialog id="farmer-more" className="farmer-more" ref={more} aria-labelledby="farmer-more-title" onClick={e => { if (e.target === e.currentTarget) more.current?.close(); }}>
      <div className="farmer-more-content">
        <div className="flex items-center justify-between gap-3"><h2 id="farmer-more-title" className="text-xl font-bold">{moreLabel}</h2><form method="dialog"><button className="farmer-icon-button" aria-label={tl ? 'Isara' : 'Close'} autoFocus><X size={21} aria-hidden="true" /></button></form></div>
        <div className="farmer-more-links">{[links[2], links[4], { href: '/profile/device-sms', label: tl ? 'Device at SMS' : 'Device & SMS Settings', Icon: Radio }].map(navLink)}</div>
        <div className="farmer-more-language"><h3 className="mb-2 text-sm font-semibold">{tl ? 'Wika' : 'Language'}</h3><FarmerLanguage lang={lang} setLang={setLang} /></div>
        <button type="button" className="soft-button" onClick={() => { more.current?.close(); onLogout(); }}><LogOut size={17} aria-hidden="true" />{logoutLabel}</button>
      </div>
    </dialog>
  </>;
}
