import type { FishSpecies, SessionRecord } from "../types";

export type AppUser = {
  id: string;
  fullName: string;
  phone: string;
  passwordHash: string;
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
  users: () => get<AppUser[]>("pondsense.users", []),
  saveUsers: (users: AppUser[]) => set("pondsense.users", users),
  currentUser: () => get<AppUser | null>("pondsense.currentUser", null),
  saveCurrentUser: (user: AppUser | null) => set("pondsense.currentUser", user),
  sessions: (user?: AppUser | null) => get<SessionRecord[]>(sessionKey(user), []),
  saveSessions: (sessions: SessionRecord[], user?: AppUser | null) => set(sessionKey(user), sessions.slice(0, 10)),
  fishOverrides: () => get<FishSpecies[] | null>("pondsense.fishOverrides", null),
  saveFishOverrides: (fish: FishSpecies[]) => set("pondsense.fishOverrides", fish),
  adminPin: () => localStorage.getItem("pondsense.adminPin") || "admin2024",
  saveAdminPin: (pin: string) => localStorage.setItem("pondsense.adminPin", pin),
  language: () => (localStorage.getItem("pondsense.lang") as "en" | "tl") || "en",
  saveLanguage: (lang: "en" | "tl") => localStorage.setItem("pondsense.lang", lang),
  resetAll: () => {
    Object.keys(localStorage)
      .filter((key) => key.startsWith("pondsense."))
      .forEach((key) => localStorage.removeItem(key));
  }
};

export function simpleHash(value: string) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 33) ^ value.charCodeAt(i);
  return (hash >>> 0).toString(16);
}
