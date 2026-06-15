import { createContext, useContext } from "react";

export const translations = {
  en: {
    analyze: "Analyze Water Quality",
    analysis: "Analysis",
    history: "Session History",
    guide: "Farmer Guide",
    login: "Login / Register",
    logout: "Logout",
    guest: "Guest Mode",
    safe: "Safe",
    warning: "Warning",
    critical: "Critical",
    bestMatch: "Best Match",
    feeding: "Feeding Management",
    ranking: "Fish Suitability Ranking",
    corrective: "Corrective Actions",
    admin: "Admin Panel"
  },
  tl: {
    analyze: "Suriin ang Kalidad ng Tubig",
    analysis: "Pagsusuri",
    history: "Kasaysayan",
    guide: "Gabay ng Mangingisda",
    login: "Login / Register",
    logout: "Logout",
    guest: "Guest Mode",
    safe: "Ligtas",
    warning: "Babala",
    critical: "Kritikal",
    bestMatch: "Pinakaangkop",
    feeding: "Pamamahala ng Pagpapakain",
    ranking: "Ranggo ng Isda",
    corrective: "Mga Dapat Gawin",
    admin: "Admin Panel"
  }
};

export type Lang = keyof typeof translations;
export type TKey = keyof typeof translations.en;

export const LangContext = createContext({
  lang: "en" as Lang,
  setLang: (_lang: Lang) => {},
  t: translations.en
});

export const useLang = () => useContext(LangContext);
