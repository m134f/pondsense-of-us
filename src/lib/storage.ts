import type { FishSpecies, SessionRecord } from "../types";

export type AppUser = {
  id: string;
  fullName: string;
  phone: string;
  mustChangePassword?: boolean;
  fishpenAssignment?: { id: number; name: string; deviceId: number | null } | null;
  createdAt: string;
  role?: "farmer" | "admin";
};

const get = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || "") as T;
  } catch {
    return fallback;
  }
};

const set = <T,>(key: string, value: T) => localStorage.setItem(key, JSON.stringify(value));

const sessionKey = (user?: AppUser | null) => {
  if (!user) return "pondsense.sessions.guest";
  return `pondsense.sessions.user.${user.id || user.phone}`;
};

export const storage = {
  currentUser: () => get<AppUser | null>("pondsense.currentUser", null),
  saveCurrentUser: (user: AppUser | null) => set("pondsense.currentUser", user),
  sessions: (user?: AppUser | null) => get<SessionRecord[]>(sessionKey(user), []),
  saveSessions: (sessions: SessionRecord[], user?: AppUser | null) => set(sessionKey(user), sessions.slice(0, 10)),
  fishOverrides: () => get<FishSpecies[] | null>("pondsense.fishOverrides", null),
  saveFishOverrides: (fish: FishSpecies[]) => set("pondsense.fishOverrides", fish),
  language: () => (localStorage.getItem("pondsense.lang") as "en" | "tl") || "en",
  saveLanguage: (lang: "en" | "tl") => localStorage.setItem("pondsense.lang", lang),
  resetAll: () => {
    Object.keys(localStorage)
      .filter((key) => key.startsWith("pondsense."))
      .forEach((key) => localStorage.removeItem(key));
  }
};

export function clearLegacyBrowserCredentials() {
  localStorage.removeItem('pondsense.users');
  localStorage.removeItem('pondsense.adminPin');
  const existing = get<AppUser & { passwordHash?: string } | null>('pondsense.currentUser', null);
  if (existing) { const { passwordHash: _discard, ...metadata } = existing; set('pondsense.currentUser', metadata); }
}
