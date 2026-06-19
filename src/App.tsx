import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  Check,
  Clock3,
  Database,
  Download,
  Droplets,
  Fish,
  History,
  Lock,
  LogOut,
  Printer,
  Settings,
  Shield,
  User,
  X
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { fishDatabase } from "./data/fish";
import { analyzeWaterQuality, detectRisks, feedingAdvice } from "./lib/decisionEngine";
import { simpleHash, storage, type AppUser } from "./lib/storage";
import type { AlertItem, AlertLevel, FishScore, FishSpecies, SessionRecord, WaterParams } from "./types";

type AppTab = "analysis" | "history" | "guide";
type AdminTab = "overview" | "users" | "fish" | "records" | "settings";
type Lang = "en" | "tl";
type AdminPath = "/admin/login" | "/admin/dashboard" | "/admin/users" | "/admin/logs" | "/admin/thresholds" | "/admin/settings";
type UserPath = "/login" | "/register" | "/dashboard" | "/history" | "/guide" | "/profile";
type SmsResult = {
  configured: boolean;
  ok: boolean;
  message: string;
  messageId?: string;
};
type AdminUser = {
  id: number;
  fullName: string;
  username?: string | null;
  email?: string | null;
  phone?: string | null;
  role: "admin" | "farmer";
  createdAt?: string;
};

const defaultParams: WaterParams = {
  ph: 7.5,
  temperature: 28,
  dissolvedOxygen: 7,
  turbidity: 30,
  ammonia: 0.02
};

const parameterMeta = [
  { key: "ph", label: { en: "pH Level", tl: "Antas ng pH" }, min: 4, max: 11, step: 0.1, unit: "", safe: "6.5-8.5" },
  { key: "temperature", label: { en: "Temperature", tl: "Temperatura" }, min: 10, max: 40, step: 0.5, unit: "°C", safe: "25-32°C" },
  { key: "dissolvedOxygen", label: { en: "Dissolved Oxygen (DO)", tl: "Dissolved Oxygen (DO)" }, min: 0, max: 15, step: 0.1, unit: " mg/L", safe: "5-8 mg/L" },
  { key: "turbidity", label: { en: "Turbidity", tl: "Labo ng Tubig" }, min: 0, max: 500, step: 1, unit: " NTU", safe: "25-100 NTU" },
  { key: "ammonia", label: { en: "Ammonia (NH3)", tl: "Ammonia (NH3)" }, min: 0, max: 0.5, step: 0.005, unit: " mg/L", safe: "0-0.05 mg/L" }
] as const satisfies ReadonlyArray<{
  key: keyof WaterParams;
  label: Record<Lang, string>;
  min: number;
  max: number;
  step: number;
  unit: string;
  safe: string;
}>;

const ui = {
  en: {
    subtitle: "Smart Fish Pond Monitoring — Laguna Lake",
    guest: "Guest Mode",
    print: "Print",
    loginRegister: "Login / Register",
    logout: "Logout",
    analysis: "Analysis",
    history: "Session History",
    guide: "Farmer Guide",
    waterParameters: "Water Parameters",
    analyze: "Analyze Water Quality",
    safe: "Safe",
    warning: "Warning",
    critical: "Critical",
    bestMatch: "Best Match",
    selectedFish: "Selected Fish",
    confidence: "Confidence",
    category: "Category",
    marketValue: "Market Value",
    harvestTime: "Harvest Time",
    correctiveActions: "Corrective Actions",
    feedingManagement: "Feeding Management",
    ranking: "Fish Suitability Ranking",
    clickFish: "Click any fish to view detailed analysis.",
    noHistory: "No saved analyses yet. Run an analysis to create your first record.",
    exportCsv: "Export CSV",
    trendTitle: "Water Quality Trends",
    farmingTips: "Farming Tips",
    seasonalTips: "Seasonal Tips - Laguna Lake",
    optimalRanges: "Optimal Parameter Ranges",
    register: "Register",
    login: "Login",
    fullName: "Full name",
    password: "Password",
    cancel: "Cancel",
    createAccount: "Create Account",
    adminPanel: "Admin Panel",
    overview: "Overview",
    users: "Users",
    fishDatabase: "Fish Database",
    allRecords: "All Records",
    settings: "Settings",
    close: "Close",
    totalUsers: "Total Users",
    totalAnalyses: "Total Analyses",
    averageScore: "Average Score",
    criticalCount: "Critical Count",
    changePin: "Change Admin PIN",
    resetAll: "Reset All Data",
    pinTitle: "Admin PIN",
    pinHelp: "Enter the admin PIN to open the hidden panel.",
    unlock: "Unlock",
    dateTime: "Date/Time",
    status: "Status"
  },
  tl: {
    subtitle: "Smart Fish Pond Monitoring — Laguna Lake",
    guest: "Guest Mode",
    print: "I-print",
    loginRegister: "Login / Register",
    logout: "Logout",
    analysis: "Pagsusuri",
    history: "Kasaysayan ng Session",
    guide: "Gabay ng Mangingisda",
    waterParameters: "Mga Sukatan ng Tubig",
    analyze: "Suriin ang Kalidad ng Tubig",
    safe: "Ligtas",
    warning: "Babala",
    critical: "Kritikal",
    bestMatch: "Pinakaangkop",
    selectedFish: "Napiling Isda",
    confidence: "Kumpiyansa",
    category: "Kategorya",
    marketValue: "Halaga sa Merkado",
    harvestTime: "Panahon ng Ani",
    correctiveActions: "Mga Dapat Gawin",
    feedingManagement: "Pamamahala ng Pagpapakain",
    ranking: "Ranggo ng Angkop na Isda",
    clickFish: "Pumili ng isda para makita ang detalye.",
    noHistory: "Wala pang na-save na pagsusuri. Mag-analyze muna para gumawa ng record.",
    exportCsv: "I-export CSV",
    trendTitle: "Trend ng Kalidad ng Tubig",
    farmingTips: "Mga Tip sa Pag-aalaga",
    seasonalTips: "Pana-panahong Gabay - Laguna Lake",
    optimalRanges: "Tamang Saklaw ng Parameter",
    register: "Register",
    login: "Login",
    fullName: "Buong pangalan",
    password: "Password",
    cancel: "Kanselahin",
    createAccount: "Gumawa ng Account",
    adminPanel: "Admin Panel",
    overview: "Overview",
    users: "Users",
    fishDatabase: "Fish Database",
    allRecords: "All Records",
    settings: "Settings",
    close: "Isara",
    totalUsers: "Kabuuang Users",
    totalAnalyses: "Kabuuang Analysis",
    averageScore: "Average Score",
    criticalCount: "Critical Count",
    changePin: "Palitan ang Admin PIN",
    resetAll: "I-reset Lahat ng Data",
    pinTitle: "Admin PIN",
    pinHelp: "Ilagay ang admin PIN para buksan ang hidden panel.",
    unlock: "Buksan",
    dateTime: "Petsa/Oras",
    status: "Status"
  }
};

const fishImages: Record<string, string> = {
  tilapia: "/fish/tilapia.jpg",
  catfish: "/fish/catfish.jpg",
  "common-carp": "/fish/common-carp.jpg",
  bangus: "/fish/bangus.jpg",
  "grass-carp": "/fish/grass-carp.jpg",
  "rainbow-trout": "/fish/rainbow-trout.jpg",
  snakehead: "/fish/snakehead.jpg",
  "red-tilapia": "/fish/red-tilapia.jpg"
};

function fishImageSrc(fishId: string) {
  return `${fishImages[fishId] || "/fish/tilapia.jpg"}?v=pdf-fish-20260611`;
}

const fishGuideCopy: Record<string, Record<Lang, { description: string; guide: string }>> = {
  tilapia: {
    en: {
      description: "Hardy, fast-growing freshwater fish ideal for warm pond conditions.",
      guide: "Feed 3-5% of body weight daily. Monitor water quality during sudden weather changes."
    },
    tl: {
      description: "Matibay at mabilis lumaking freshwater fish na angkop sa mainit na kondisyon ng palaisdaan.",
      guide: "Magpakain ng 3-5% ng timbang ng isda bawat araw. Bantayan ang kalidad ng tubig kapag biglang nagbabago ang panahon."
    }
  },
  catfish: {
    en: {
      description: "Resilient fish that tolerates lower oxygen better than many species.",
      guide: "Keep ammonia controlled and avoid overfeeding. Maintain pond cleanliness."
    },
    tl: {
      description: "Matibay na isda na mas nakakayanan ang mababang oxygen kaysa sa ibang species.",
      guide: "Kontrolin ang ammonia at iwasan ang sobrang pagpapakain. Panatilihing malinis ang paligid ng palaisdaan."
    }
  },
  "common-carp": {
    en: {
      description: "Adaptable freshwater species suitable for semi-intensive ponds.",
      guide: "Works well in polyculture. Watch turbidity and organic waste buildup."
    },
    tl: {
      description: "Freshwater species na madaling umangkop at bagay sa semi-intensive na pag-aalaga.",
      guide: "Mainam sa polyculture. Bantayan ang labo ng tubig at pagdami ng organic waste."
    }
  },
  bangus: {
    en: {
      description: "Popular Philippine aquaculture species with strong market demand.",
      guide: "Maintain stable water quality and avoid feeding during poor oxygen conditions."
    },
    tl: {
      description: "Sikat na aquaculture species sa Pilipinas na may mataas na demand sa merkado.",
      guide: "Panatilihing stable ang kalidad ng tubig at iwasang magpakain kapag mababa ang oxygen."
    }
  },
  "grass-carp": {
    en: {
      description: "Herbivorous freshwater fish useful in pond vegetation control.",
      guide: "Provide plant-based feed and keep dissolved oxygen stable."
    },
    tl: {
      description: "Herbivorous freshwater fish na nakatutulong sa pagkontrol ng halaman sa palaisdaan.",
      guide: "Magbigay ng plant-based feed at panatilihing stable ang dissolved oxygen."
    }
  },
  "rainbow-trout": {
    en: {
      description: "Cold-water fish with strict oxygen and temperature requirements.",
      guide: "Not ideal for warm Laguna Lake ponds. Requires cool, oxygen-rich water."
    },
    tl: {
      description: "Cold-water fish na nangangailangan ng mataas na oxygen at malamig na temperatura.",
      guide: "Hindi ito ideal sa mainit na kondisyon ng Laguna Lake. Kailangan nito ng malamig at oxygen-rich na tubig."
    }
  },
  snakehead: {
    en: {
      description: "Air-breathing freshwater fish that can tolerate difficult conditions.",
      guide: "Still manage ammonia and avoid heavy organic waste accumulation."
    },
    tl: {
      description: "Freshwater fish na nakakahinga ng hangin at nakakayanan ang mas mahirap na kondisyon.",
      guide: "Kailangan pa ring kontrolin ang ammonia at iwasan ang sobrang organic waste."
    }
  },
  "red-tilapia": {
    en: {
      description: "Marketable tilapia hybrid with similar needs to Nile tilapia.",
      guide: "Maintain warm water and consistent feeding, but pause feeding when ammonia rises."
    },
    tl: {
      description: "Tilapia hybrid na maganda ang halaga sa merkado at kahawig ng pangangailangan ng Nile tilapia.",
      guide: "Panatilihing mainit at stable ang tubig, pero ihinto muna ang pagpapakain kapag tumaas ang ammonia."
    }
  }
};

const phraseTl: Record<string, string> = {
  "Critical DO / Hypoxia Risk": "Kritikal na DO / Panganib ng Hypoxia",
  "Dissolved oxygen is dangerously low. Fish may gasp at the surface.": "Mapanganib na mababa ang dissolved oxygen. Maaaring humingal ang isda sa ibabaw.",
  "Maximize aeration immediately": "Agad na i-maximize ang aeration",
  "Stop feeding": "Itigil muna ang pagpapakain",
  "Remove dead fish and organic waste": "Alisin ang patay na isda at organic waste",
  "Contact BFAR/LGU if fish stress continues": "Makipag-ugnayan sa BFAR/LGU kung tuloy ang stress ng isda",
  "Low Dissolved Oxygen": "Mababang Dissolved Oxygen",
  "Oxygen is below the safe range for most pond fish.": "Mas mababa sa safe range ang oxygen para sa karamihan ng pond fish.",
  "Increase aeration": "Dagdagan ang aeration",
  "Reduce feeding": "Bawasan ang pagpapakain",
  "Clean nets or cage area": "Linisin ang lambat o cage area",
  "Observe fish behavior closely": "Bantayang mabuti ang kilos ng isda",
  "Critical Ammonia": "Kritikal na Ammonia",
  "Ammonia is high enough to stress or kill fish.": "Mataas ang ammonia at maaari itong magdulot ng stress o pagkamatay ng isda.",
  "Stop feeding for 24-48 hours": "Itigil ang pagpapakain sa loob ng 24-48 oras",
  "Remove organic waste": "Alisin ang organic waste",
  "Improve aeration": "Pagbutihin ang aeration",
  "Consult BFAR/LGU before treatment": "Kumonsulta sa BFAR/LGU bago mag-treatment",
  "Ammonia Warning": "Babala sa Ammonia",
  "Ammonia is above the preferred safe range.": "Mas mataas ang ammonia kaysa sa preferred safe range.",
  "Remove leftover feeds and organic waste": "Alisin ang natirang pagkain at organic waste",
  "Monitor again after several hours": "Sukatin ulit makalipas ang ilang oras",
  "High Turbidity": "Mataas na Labo ng Tubig",
  "Water is too cloudy and may affect fish health.": "Masyadong malabo ang tubig at maaaring makaapekto sa kalusugan ng isda.",
  "Stop feeding temporarily if fish are stressed": "Pansamantalang ihinto ang pagpapakain kung stressed ang isda",
  "Clean net or cage area": "Linisin ang lambat o cage area",
  "Avoid disturbing the lake bottom": "Iwasang gambalain ang ilalim ng lawa",
  "Do not use chemicals without expert guidance": "Huwag gumamit ng kemikal nang walang gabay ng eksperto",
  "Extreme pH": "Matinding pH",
  "pH is outside the safe range for most fish.": "Nasa labas ng safe range ang pH para sa karamihan ng isda.",
  "Recheck using a test kit": "Sukatin ulit gamit ang test kit",
  "Monitor fish behavior": "Bantayan ang kilos ng isda",
  "Avoid sudden treatment": "Iwasan ang biglaang treatment",
  "Consult BFAR/LGU before applying lime or any treatment": "Kumonsulta sa BFAR/LGU bago maglagay ng lime o anumang treatment",
  "Temperature Stress": "Stress Dahil sa Temperatura",
  "Temperature may reduce feeding response and oxygen availability.": "Maaaring pababain ng temperatura ang gana sa pagkain at available oxygen.",
  "Avoid fish handling": "Iwasang hawakan o galawin ang isda",
  "Improve water circulation": "Pagbutihin ang daloy ng tubig",
  "Combined DO + Ammonia Risk": "Pinagsamang Panganib ng DO + Ammonia",
  "Low oxygen combined with ammonia creates a serious stress condition.": "Ang mababang oxygen na may ammonia ay nagdudulot ng seryosong stress condition.",
  "Stop feeding immediately": "Agad na ihinto ang pagpapakain",
  "Maximize aeration": "I-maximize ang aeration",
  "Contact BFAR/LGU for emergency guidance": "Makipag-ugnayan sa BFAR/LGU para sa emergency guidance",
  "All Parameters Safe": "Ligtas ang Lahat ng Parameter",
  "Water quality is within acceptable ranges.": "Nasa katanggap-tanggap na saklaw ang kalidad ng tubig.",
  "Continue daily monitoring": "Ipagpatuloy ang araw-araw na monitoring",
  "Critical Water Condition": "Kritikal ang Kondisyon ng Tubig",
  "Water Quality Warning": "Babala sa Kalidad ng Tubig",
  "One or more readings require immediate action. Follow the corrective steps below.": "May sukatan na kailangan ng agarang aksyon. Sundin ang mga hakbang sa ibaba.",
  "Some readings are outside the ideal range. Monitor closely and apply the recommended actions.": "May ilang sukatan na wala sa tamang saklaw. Bantayan at sundin ang rekomendasyon.",
  "Pause or reduce feeding because ammonia or oxygen is not safe.": "Ihinto o bawasan ang pagpapakain dahil hindi ligtas ang ammonia o oxygen.",
  "It is feeding time. Feed gradually and remove leftovers.": "Oras na ng pagpapakain. Dahan-dahang magpakain at alisin ang tira.",
  "Not feeding time. Next windows: 6:00-8:00 AM or 4:00-6:00 PM.": "Hindi oras ng pagpapakain. Susunod: 6:00-8:00 AM o 4:00-6:00 PM."
};

function localize(text: string, lang: Lang) {
  return lang === "tl" ? phraseTl[text] || text : text;
}

function fishDescription(fish: FishSpecies, lang: Lang) {
  return fishGuideCopy[fish.id]?.[lang].description || fish.description;
}

function fishCareGuide(fish: FishSpecies, lang: Lang) {
  return fishGuideCopy[fish.id]?.[lang].guide || fish.guide;
}

function valueText(key: keyof WaterParams, value: number) {
  if (key === "ammonia") return value.toFixed(3);
  if (key === "ph") return value.toFixed(1);
  return value.toFixed(1);
}

function statusFor(key: keyof WaterParams, value: number): AlertLevel {
  if (key === "ph") return value < 6 || value > 9 ? "critical" : value < 6.5 || value > 8.5 ? "warning" : "safe";
  if (key === "temperature") return value < 20 || value > 34 ? "warning" : value < 25 || value > 32 ? "warning" : "safe";
  if (key === "dissolvedOxygen") return value < 3 ? "critical" : value < 5 ? "warning" : "safe";
  if (key === "turbidity") return value > 200 ? "critical" : value > 100 ? "warning" : "safe";
  return value > 0.1 ? "critical" : value > 0.05 ? "warning" : "safe";
}

function overallStatus(params: WaterParams): AlertLevel {
  const statuses = parameterMeta.map((meta) => statusFor(meta.key, params[meta.key]));
  if (statuses.includes("critical")) return "critical";
  if (statuses.includes("warning")) return "warning";
  return "safe";
}

function levelClasses(level: AlertLevel) {
  if (level === "critical") return "border-red-200 bg-red-50 text-red-800";
  if (level === "warning") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-emerald-200 bg-emerald-50 text-emerald-800";
}

function badgeClasses(level: AlertLevel | FishScore["confidence"]) {
  if (level === "critical" || level === "Low") return "bg-red-100 text-red-700 ring-red-200";
  if (level === "warning" || level === "Medium") return "bg-amber-100 text-amber-700 ring-amber-200";
  return "bg-emerald-100 text-emerald-700 ring-emerald-200";
}

function confidenceLevel(score: number): FishScore["confidence"] {
  if (score >= 85) return "High";
  if (score >= 65) return "Medium";
  return "Low";
}

function progressColor(score: number) {
  if (score >= 85) return "bg-emerald-500";
  if (score >= 65) return "bg-amber-400";
  return "bg-red-500";
}

function progressWidth(score: number) {
  if (score >= 95) return "w-full";
  if (score >= 90) return "w-11/12";
  if (score >= 80) return "w-5/6";
  if (score >= 70) return "w-3/4";
  if (score >= 60) return "w-2/3";
  if (score >= 50) return "w-1/2";
  if (score >= 40) return "w-5/12";
  if (score >= 30) return "w-1/3";
  if (score >= 20) return "w-1/4";
  return "w-1/6";
}

function formattedClock(date: Date) {
  return date.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" });
}

const apiBaseUrl = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

function apiUrl(path: string) {
  if (!apiBaseUrl || /^https?:\/\//.test(path)) return path;
  return `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function postJson<T>(url: string, body: unknown): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(apiUrl(url), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { data: null, error: payload.message || "Request failed. Please try again." };
    return { data: payload as T, error: null };
  } catch {
    return { data: null, error: "Cannot reach the server. Make sure the dev server and XAMPP are running." };
  }
}

async function apiJson<T>(url: string, options: RequestInit = {}): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(apiUrl(url), {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { data: null, error: payload.message || "Request failed. Please try again." };
    return { data: payload as T, error: null };
  } catch {
    return { data: null, error: "Cannot reach the server. Make sure the dev server and XAMPP are running." };
  }
}

export default function App() {
  const savedUser = storage.currentUser();
  const [lang, setLangState] = useState<Lang>(storage.language());
  const [tab, setTab] = useState<AppTab>("analysis");
  const [params, setParams] = useState<WaterParams>(defaultParams);
  const [fishDb, setFishDb] = useState<FishSpecies[]>(storage.fishOverrides() || fishDatabase);
  const [selectedFishId, setSelectedFishId] = useState("tilapia");
  const [sessions, setSessions] = useState<SessionRecord[]>(storage.sessions(savedUser));
  const [currentUser, setCurrentUser] = useState<AppUser | null>(savedUser);
  const [path, setPath] = useState(window.location.pathname);
  const [authOpen, setAuthOpen] = useState(false);
  const [sms, setSms] = useState("");
  const [clock, setClock] = useState(new Date());
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const text = ui[lang];

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const cachedSessions = storage.sessions(currentUser);
    setSessions(cachedSessions);

    if (!currentUser) return () => {
      active = false;
    };

    apiJson<{ sessions: SessionRecord[] }>("/api/readings").then((result) => {
      if (!active || !result.data?.sessions) return;
      setSessions(result.data.sessions);
      storage.saveSessions(result.data.sessions, currentUser);
    });

    return () => {
      active = false;
    };
  }, [currentUser?.id, currentUser?.phone]);

  useEffect(() => {
    const syncPath = () => setPath(window.location.pathname);
    window.addEventListener("popstate", syncPath);
    return () => window.removeEventListener("popstate", syncPath);
  }, []);

  const navigate = (nextPath: string) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
  };

  useEffect(() => {
    if (path === "/dashboard") setTab("analysis");
    if (path === "/history") setTab("history");
    if (path === "/guide") setTab("guide");
  }, [path]);

  const setLang = (next: Lang) => {
    storage.saveLanguage(next);
    setLangState(next);
  };

  const scores = useMemo(() => analyzeWaterQuality(params, fishDb), [params, fishDb]);
  const alerts = useMemo(() => detectRisks(params), [params]);
  const selectedScore = scores.find((score) => score.fish.id === selectedFishId) || scores[0];
  const selectedRank = Math.max(1, scores.findIndex((score) => score.fish.id === selectedScore.fish.id) + 1);
  const best = scores[0];
  const currentStatus = overallStatus(params);

  const runAnalysis = async () => {
    setHasAnalyzed(true);
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toLocaleString("en-PH"),
      ...params,
      bestFish: best.fish.name,
      score: best.score
    };
    const next = [record, ...sessions].slice(0, 10);
    setSessions(next);
    storage.saveSessions(next, currentUser);
    setSelectedFishId(best.fish.id);
    const savedReading = await postJson<{ saved: boolean; readingId?: number; sms?: SmsResult }>("/api/readings", {
      userId: currentUser?.id,
      inputMode: "manual",
      ph: params.ph,
      temperature: params.temperature,
      dissolvedOxygen: params.dissolvedOxygen,
      turbidity: params.turbidity,
      ammonia: params.ammonia,
      bestFish: best.fish.name,
      score: best.score,
      confidence: best.confidence,
      status: currentStatus,
      alerts: alerts.map((alert) => ({
        level: alert.level,
        title: alert.title,
        message: alert.message
      })),
      smsSent: false
    });
    if (currentUser?.phone && alerts.some((alert) => alert.level === "warning" || alert.level === "critical")) {
      if (savedReading.data?.sms?.ok) {
        setSms(`Real iProgSMS water warning queued for ${currentUser?.phone || "guest user"}.`);
      } else if (savedReading.data?.sms?.configured === false) {
        setSms("Water warning detected. Add IPROG_SMS_API_TOKEN in .env to send real SMS.");
      } else {
        setSms(savedReading.data?.sms?.message || "Water warning detected, but SMS was not sent.");
      }
    }
  };

  const testSms = async () => {
    if (!currentUser?.phone) {
      setSms("Login or register first so PondSense knows what phone number to text.");
      navigate("/login");
      return;
    }
    const result = await postJson<SmsResult>("/api/sms/test", { phone: currentUser.phone });
    if (result.data?.ok) {
      setSms(`Real iProgSMS test message queued for ${currentUser.phone}.`);
      return;
    }
    setSms(result.error || result.data?.message || "SMS test failed. Check your iProgSMS token and credits.");
  };

  const exportCsv = () => {
    const rows = [
      ["Date/Time", "pH", "Temp", "DO", "Turbidity", "Ammonia", "Best Fish", "Score", "Status"],
      ...sessions.map((row) => [
        row.timestamp,
        row.ph,
        row.temperature,
        row.dissolvedOxygen,
        row.turbidity,
        row.ammonia,
        row.bestFish,
        row.score,
        overallStatus(row)
      ])
    ];
    const csv = rows.map((row) => row.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "pondsense-records.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const printReport = () => {
    const status = currentStatus;
    const escapeHtml = (value: unknown) =>
      String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const actionRows = alerts
      .flatMap((alert) => alert.actions.map((action) => ({ title: alert.title, level: alert.level, action })))
      .slice(0, 8)
      .map(
        (item, index) =>
          `<tr><td>${index + 1}</td><td>${escapeHtml(item.level)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.action)}</td></tr>`
      )
      .join("");
    const html = `<!doctype html>
      <html>
        <head>
          <title>PondSense Farmer Report</title>
          <style>
            body { font-family: Arial, sans-serif; color: #0f172a; margin: 32px; }
            .header { border-bottom: 3px solid #0d9488; padding-bottom: 16px; margin-bottom: 20px; }
            h1 { margin: 0; font-size: 28px; }
            h2 { margin-top: 24px; font-size: 18px; color: #0f766e; }
            .meta { color: #475569; margin-top: 6px; }
            .status { display: inline-block; padding: 8px 12px; border-radius: 999px; font-weight: 700; background: ${status === "critical" ? "#fee2e2" : status === "warning" ? "#fef3c7" : "#dcfce7"}; color: ${status === "critical" ? "#b91c1c" : status === "warning" ? "#92400e" : "#047857"}; }
            table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 13px; }
            th, td { border: 1px solid #cbd5e1; padding: 9px; text-align: left; vertical-align: top; }
            th { background: #f1f5f9; }
            .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
            .box { border: 1px solid #cbd5e1; border-radius: 12px; padding: 12px; }
            @media print { button { display: none; } body { margin: 20px; } }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>PondSense of Us - Farmer Report</h1>
            <p class="meta">Smart Fish Pond Monitoring - Laguna Lake</p>
            <p class="meta">Generated: ${escapeHtml(new Date().toLocaleString("en-PH"))}</p>
            <p class="meta">Farmer: ${escapeHtml(currentUser?.fullName || "Guest Mode")}</p>
          </div>
          <p><span class="status">${escapeHtml(status.toUpperCase())}</span></p>
          <div class="grid">
            <div class="box"><strong>Best Fish:</strong><br>${escapeHtml(best.fish.name)} (${escapeHtml(best.score)}%)</div>
            <div class="box"><strong>Confidence:</strong><br>${escapeHtml(best.confidence)}</div>
          </div>
          <h2>Water Readings</h2>
          <table>
            <tr><th>Parameter</th><th>Value</th><th>Safe Range</th></tr>
            ${parameterMeta.map((meta) => `<tr><td>${escapeHtml(meta.label.en)}</td><td>${escapeHtml(valueText(meta.key, params[meta.key]))}${escapeHtml(meta.unit)}</td><td>${escapeHtml(meta.safe)}</td></tr>`).join("")}
          </table>
          <h2>Recommended Actions</h2>
          <table>
            <tr><th>#</th><th>Severity</th><th>Issue</th><th>Action</th></tr>
            ${actionRows || "<tr><td>1</td><td>Safe</td><td>All Parameters Safe</td><td>Continue daily monitoring.</td></tr>"}
          </table>
          <h2>Farmer Guide</h2>
          <p>${escapeHtml(fishCareGuide(best.fish, lang))}</p>
          <button onclick="window.print()">Print Report</button>
        </body>
      </html>`;
    const report = window.open("", "_blank", "width=900,height=700");
    if (!report) return window.print();
    report.document.write(html);
    report.document.close();
    report.focus();
  };

  if (path.startsWith("/admin")) {
    return <AdminRouter path={path as AdminPath} navigate={navigate} text={text} />;
  }

  if (path === "/login" || path === "/register") {
    return (
      <AuthPage
        initialMode={path === "/register" ? "register" : "login"}
        text={text}
        navigate={navigate}
        onLogin={(user, message) => {
          setCurrentUser(user);
          setSessions(storage.sessions(user));
          setSms(message);
          navigate(user.role === "admin" ? "/admin/dashboard" : "/dashboard");
        }}
      />
    );
  }

  if (path === "/profile") {
    return <ProfilePage currentUser={currentUser} navigate={navigate} />;
  }

  return (
    <div className="min-h-screen bg-slate-100">
      {sms && (
        <button
          className="fixed bottom-5 right-5 z-50 max-w-sm rounded-2xl bg-slate-950 px-5 py-4 text-left text-sm font-medium text-white shadow-2xl"
          onClick={() => setSms("")}
        >
          {sms}
        </button>
      )}

      <Header
        lang={lang}
        setLang={setLang}
        clock={clock}
        currentUser={currentUser}
        onHome={() => navigate("/dashboard")}
        onPrint={printReport}
        onAuth={() => navigate("/login")}
        onLogout={async () => {
          await apiJson("/api/logout", { method: "POST", body: "{}" });
          storage.saveCurrentUser(null);
          setCurrentUser(null);
          setSessions(storage.sessions(null));
          navigate("/login");
        }}
        text={text}
      />

      <Tabs active={tab} onChange={(nextTab) => {
        setTab(nextTab);
        navigate(nextTab === "history" ? "/history" : nextTab === "guide" ? "/guide" : "/dashboard");
      }} text={text} />

      {tab === "analysis" && (
        <AnalysisPage
          lang={lang}
          params={params}
          setParams={setParams}
          sessions={sessions}
          scores={scores}
          alerts={alerts}
          selectedScore={selectedScore}
          selectedRank={selectedRank}
          best={best}
          currentStatus={currentStatus}
          hasAnalyzed={hasAnalyzed}
          onAnalyze={runAnalysis}
          onTestSms={testSms}
          onSelectFish={setSelectedFishId}
          text={text}
        />
      )}

      {tab === "history" && (
        <HistoryPage sessions={sessions} onExport={exportCsv} text={text} />
      )}

      {tab === "guide" && (
        <FarmerGuidePage lang={lang} fishDb={fishDb} text={text} />
      )}

      {authOpen && (
        <AuthModal
          text={text}
          onClose={() => setAuthOpen(false)}
          onLogin={(user, message) => {
            setCurrentUser(user);
            setSms(message);
          }}
        />
      )}

    </div>
  );
}

function Header({
  lang,
  setLang,
  clock,
  currentUser,
  onHome,
  onPrint,
  onAuth,
  onLogout,
  text
}: {
  lang: Lang;
  setLang: (lang: Lang) => void;
  clock: Date;
  currentUser: AppUser | null;
  onHome: () => void;
  onPrint: () => void;
  onAuth: () => void;
  onLogout: () => void;
  text: typeof ui.en;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <button className="flex items-center gap-3 text-left" onClick={onHome} title="PondSense dashboard">
          <span className="grid h-12 w-12 place-items-center overflow-hidden rounded-2xl bg-white ring-1 ring-teal-100">
            <img src="/logofishpond.png?v=logo-20260612" alt="PondSense of Us logo" className="h-full w-full object-cover" />
          </span>
          <span>
            <span className="block text-lg font-black leading-tight text-slate-950">PondSense of Us</span>
            <span className="block text-sm text-slate-500">{text.subtitle}</span>
          </span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl bg-slate-100 p-1">
            {(["en", "tl"] as const).map((item) => (
              <button
                key={item}
                className={`rounded-lg px-3 py-1.5 text-xs font-black transition ${lang === item ? "bg-teal-600 text-white shadow-sm" : "text-slate-500 hover:text-teal-700"}`}
                onClick={() => setLang(item)}
              >
                {item.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="inline-flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-600">
            <Clock3 size={16} /> {formattedClock(clock)}
          </span>
          <span className="inline-flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm font-bold text-amber-700 ring-1 ring-amber-100">
            <User size={16} /> {currentUser ? currentUser.fullName : text.guest}
          </span>
          <button className="soft-button" onClick={onPrint}>
            <Printer size={16} /> {text.print}
          </button>
          {currentUser ? (
            <button className="soft-button" onClick={onLogout}>
              <LogOut size={16} /> {text.logout}
            </button>
          ) : (
            <button className="primary-button py-2" onClick={onAuth}>
              <Lock size={16} /> {text.loginRegister}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function Tabs({ active, onChange, text }: { active: AppTab; onChange: (tab: AppTab) => void; text: typeof ui.en }) {
  const tabs: Array<{ id: AppTab; label: string; icon: typeof BarChart3 }> = [
    { id: "analysis", label: text.analysis, icon: BarChart3 },
    { id: "history", label: text.history, icon: History },
    { id: "guide", label: text.guide, icon: BookOpen }
  ];

  return (
    <nav className="mx-auto flex max-w-[1500px] gap-2 px-4 py-4 sm:px-6">
      <div className="inline-flex flex-wrap gap-1 rounded-2xl bg-slate-200/70 p-1 shadow-inner">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black transition ${
              active === id ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:bg-white/70 hover:text-slate-800"
            }`}
          >
            <Icon size={17} className={active === id ? "text-teal-600" : ""} />
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

function AnalysisPage({
  lang,
  params,
  setParams,
  sessions,
  scores,
  alerts,
  selectedScore,
  selectedRank,
  best,
  currentStatus,
  hasAnalyzed,
  onAnalyze,
  onTestSms,
  onSelectFish,
  text
}: {
  lang: Lang;
  params: WaterParams;
  setParams: (params: WaterParams) => void;
  sessions: SessionRecord[];
  scores: FishScore[];
  alerts: AlertItem[];
  selectedScore: FishScore;
  selectedRank: number;
  best: FishScore;
  currentStatus: AlertLevel;
  hasAnalyzed: boolean;
  onAnalyze: () => void;
  onTestSms: () => void;
  onSelectFish: (id: string) => void;
  text: typeof ui.en;
}) {
  return (
    <main className="mx-auto grid max-w-[1500px] grid-cols-1 gap-5 px-4 pb-8 sm:px-6 lg:grid-cols-[minmax(280px,25%)_minmax(460px,1fr)_minmax(330px,25%)]">
      <aside className="space-y-5">
        <WaterParametersPanel lang={lang} params={params} setParams={setParams} onAnalyze={onAnalyze} text={text} />
        {hasAnalyzed && (
          <>
            <FeedingCard params={params} lang={lang} text={text} />
            <button
              className="w-full rounded-2xl border border-emerald-200 bg-emerald-100 px-4 py-3 text-sm font-black text-emerald-800 shadow-sm transition hover:bg-emerald-200"
              onClick={onTestSms}
            >
              Test SMS Alert
            </button>
          </>
        )}
      </aside>

      <section className="space-y-5">
        {hasAnalyzed ? (
          <>
            <AlertBanner alert={alerts[0]} lang={lang} />
            <SummaryBanner status={currentStatus} lang={lang} />
            <WhatToDoNow alerts={alerts} status={currentStatus} lang={lang} />
            <QuickStatusCards lang={lang} params={params} />
            <BestMatchCard selectedScore={selectedScore} selectedRank={selectedRank} best={best} text={text} />
            <FarmerGuideCard selectedScore={selectedScore} lang={lang} text={text} />
            <ParameterAnalysis lang={lang} selectedScore={selectedScore} />
            <CorrectiveActions alerts={alerts} status={currentStatus} lang={lang} text={text} />
          </>
        ) : (
          <AnalysisEmptyState />
        )}
      </section>

      {hasAnalyzed ? (
        <>
          <FishRankingPanel scores={scores} selectedId={selectedScore.fish.id} onSelectFish={onSelectFish} text={text} />
          <DashboardTrends params={params} sessions={sessions} text={text} />
        </>
      ) : (
        <aside className="card h-fit p-6">
          <h2 className="flex items-center gap-2 text-lg font-black text-slate-950">
            <Fish className="text-teal-600" size={21} /> Fish Suitability Ranking
          </h2>
          <p className="mt-3 text-sm font-medium leading-6 text-slate-600">
            No fish ranking yet. Adjust the water parameters, then click Analyze Water Quality to generate recommendations.
          </p>
        </aside>
      )}
    </main>
  );
}

function AnalysisEmptyState() {
  return (
    <section className="card flex min-h-[420px] flex-col items-center justify-center p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-teal-50 text-teal-700 ring-1 ring-teal-100">
        <BarChart3 size={30} />
      </div>
      <h2 className="mt-5 text-2xl font-black text-slate-950">No water quality analysis yet</h2>
      <p className="mt-3 max-w-xl text-sm font-medium leading-6 text-slate-600">
        Set the current pH, temperature, dissolved oxygen, turbidity, and ammonia values on the left. Results, alerts,
        corrective actions, fish ranking, and trends will appear after you click Analyze Water Quality.
      </p>
    </section>
  );
}
function WaterParametersPanel({
  lang,
  params,
  setParams,
  onAnalyze,
  text
}: {
  lang: Lang;
  params: WaterParams;
  setParams: (params: WaterParams) => void;
  onAnalyze: () => void;
  text: typeof ui.en;
}) {
  return (
    <section className="card h-fit p-5">
      <h2 className="mb-5 flex items-center gap-2 text-lg font-black text-slate-950">
        <Droplets className="text-teal-600" size={21} /> {text.waterParameters}
      </h2>
      <div className="space-y-6">
        {parameterMeta.map((meta) => {
          const status = statusFor(meta.key, params[meta.key]);
          const isSafe = status === "safe";
          return (
            <label key={meta.key} className="block">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-sm font-bold text-slate-800">{meta.label[lang]}</span>
                <span className="inline-flex items-center gap-1 text-sm font-black text-teal-700">
                  {valueText(meta.key, params[meta.key])}{meta.unit}
                  {isSafe ? <Check size={16} className="text-emerald-500" /> : <X size={16} className="text-red-500" />}
                </span>
              </div>
              <input
                className="range-rainbow"
                type="range"
                min={meta.min}
                max={meta.max}
                step={meta.step}
                value={params[meta.key]}
                onChange={(event) => setParams({ ...params, [meta.key]: Number(event.target.value) })}
              />
              <div className="mt-2 flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>{meta.min}{meta.unit}</span>
                <span className="text-teal-700">safe {meta.safe}</span>
                <span>{meta.max}{meta.unit}</span>
              </div>
            </label>
          );
        })}
      </div>
      <button className="primary-button mt-6 w-full py-4" onClick={onAnalyze}>
        <Fish size={18} /> {text.analyze}
      </button>
    </section>
  );
}

function AlertBanner({ alert, lang }: { alert: AlertItem; lang: Lang }) {
  const Icon = alert.level === "safe" ? Check : AlertTriangle;
  return (
    <section className={`flex items-start gap-4 rounded-2xl border p-5 shadow-card ${levelClasses(alert.level)}`}>
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/70">
        <Icon size={23} />
      </span>
      <div>
        <h2 className="text-lg font-black">{localize(alert.title, lang)}</h2>
        <p className="mt-1 text-sm font-medium opacity-90">{localize(alert.message, lang)}</p>
      </div>
    </section>
  );
}

function SummaryBanner({ status, lang }: { status: AlertLevel; lang: Lang }) {
  const isSafe = status === "safe";
  const title = isSafe ? "All Parameters Safe" : status === "critical" ? "Critical Water Condition" : "Water Quality Warning";
  const message = isSafe
    ? "Water quality is within acceptable ranges. Continue daily monitoring."
    : status === "critical"
      ? "One or more readings require immediate action. Follow the corrective steps below."
      : "Some readings are outside the ideal range. Monitor closely and apply the recommended actions.";
  const Icon = isSafe ? Check : AlertTriangle;
  return (
    <section className={`flex items-center gap-4 rounded-2xl border p-5 shadow-card ${levelClasses(status)}`}>
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white/70 ring-1 ring-current/10">
        <Icon size={24} />
      </span>
      <div>
        <h2 className="text-lg font-black">{localize(title, lang)}</h2>
        <p className="mt-1 text-sm font-medium opacity-90">{localize(message, lang)}</p>
      </div>
    </section>
  );
}

function WhatToDoNow({ alerts, status, lang }: { alerts: AlertItem[]; status: AlertLevel; lang: Lang }) {
  const firstAlert = alerts.find((alert) => alert.level !== "safe") || alerts[0];
  const mainActions = firstAlert.actions.slice(0, status === "safe" ? 1 : 3);
  const title =
    lang === "tl"
      ? status === "safe"
        ? "Gawin ngayon"
        : status === "critical"
          ? "Gawin agad ngayon"
          : "Gawin sa loob ng araw na ito"
      : status === "safe"
        ? "What to do now"
        : status === "critical"
          ? "Do this immediately"
          : "Do this today";
  const subtitle =
    lang === "tl"
      ? status === "safe"
        ? "Magpatuloy sa regular na pagbabantay ng tubig."
        : "Ito ang pinakamahalagang hakbang para mabawasan ang stress ng isda."
      : status === "safe"
        ? "Continue regular water monitoring."
        : "These are the most important steps to reduce fish stress.";
  return (
    <section className={`rounded-2xl border p-5 shadow-card ${levelClasses(status)}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-wide opacity-80">
            {lang === "tl" ? "Gabay ng mangingisda" : "Farmer action guide"}
          </p>
          <h2 className="mt-1 text-2xl font-black">{title}</h2>
          <p className="mt-1 text-sm font-semibold opacity-90">{subtitle}</p>
        </div>
        <span className={`w-fit rounded-full px-3 py-1 text-xs font-black ring-1 ${badgeClasses(status)}`}>
          {status === "critical" ? (lang === "tl" ? "Kritikal" : "Critical") : status === "warning" ? (lang === "tl" ? "Babala" : "Warning") : (lang === "tl" ? "Ligtas" : "Safe")}
        </span>
      </div>
      <ol className="mt-4 grid gap-3 sm:grid-cols-3">
        {mainActions.map((action, index) => (
          <li key={action} className="rounded-xl bg-white/75 p-4 text-sm font-bold shadow-sm ring-1 ring-current/10">
            <span className="mb-2 grid h-8 w-8 place-items-center rounded-full bg-slate-950 text-sm font-black text-white">{index + 1}</span>
            {localize(action, lang)}
          </li>
        ))}
      </ol>
    </section>
  );
}

function QuickStatusCards({ lang, params }: { lang: Lang; params: WaterParams }) {
  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {parameterMeta.map((meta) => {
        const status = statusFor(meta.key, params[meta.key]);
        return (
          <article key={meta.key} className={`rounded-2xl border bg-white p-4 shadow-card ${status === "critical" ? "border-red-200" : status === "warning" ? "border-amber-200" : "border-emerald-100"}`}>
            <p className="text-xs font-bold text-slate-500">{meta.label[lang]}</p>
            <p className="mt-1 text-2xl font-black text-slate-950">{valueText(meta.key, params[meta.key])}{meta.unit}</p>
            <span className={`mt-3 inline-flex rounded-full px-2.5 py-1 text-xs font-black ring-1 ${badgeClasses(status)}`}>
              {status}
            </span>
          </article>
        );
      })}
    </section>
  );
}

function BestMatchCard({
  selectedScore,
  selectedRank,
  best,
  text
}: {
  selectedScore: FishScore;
  selectedRank: number;
  best: FishScore;
  text: typeof ui.en;
}) {
  const isBest = selectedScore.fish.id === best.fish.id;
  return (
    <section className="card overflow-hidden p-6">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-4">
          <div className="relative grid h-24 w-28 shrink-0 place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-slate-100 to-teal-100 ring-1 ring-slate-200">
            <img
              src={fishImageSrc(selectedScore.fish.id)}
              alt={selectedScore.fish.name}
              className="h-full w-full object-cover"
            />
            <span className="absolute bottom-2 right-2 rounded-full bg-teal-600 px-2 py-1 text-xs font-black text-white">#{selectedRank}</span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-black uppercase tracking-wider text-teal-700">{isBest ? text.bestMatch : text.selectedFish}</p>
            <h1 className="mt-2 text-3xl font-black text-slate-950">{selectedScore.fish.name}</h1>
            <p className="mt-1 text-sm italic text-slate-500">{selectedScore.fish.scientificName}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className={`rounded-full px-3 py-1 text-xs font-black ring-1 ${badgeClasses(selectedScore.confidence)}`}>
                ✓ {selectedScore.confidence} {text.confidence}
              </span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">{selectedScore.fish.category}</span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">{selectedScore.fish.marketValue} {text.marketValue}</span>
            </div>
          </div>
        </div>
        <ScoreGauge score={selectedScore.score} confidence={selectedScore.confidence} />
      </div>
    </section>
  );
}

function ScoreGauge({ score, confidence }: { score: number; confidence: FishScore["confidence"] }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative grid h-32 w-32 shrink-0 place-items-center">
      <svg className="h-32 w-32 -rotate-90" viewBox="0 0 110 110" aria-label={`Score ${score}%`}>
        <circle cx="55" cy="55" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="10" />
        <circle
          cx="55"
          cy="55"
          r={radius}
          fill="none"
          stroke="#0d9488"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          strokeWidth="10"
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-3xl font-black text-teal-700">{score}%</div>
        <div className="text-xs font-bold text-slate-500">{confidence}</div>
      </div>
    </div>
  );
}

function FarmerGuideCard({ selectedScore, lang, text }: { selectedScore: FishScore; lang: Lang; text: typeof ui.en }) {
  return (
    <section className="card border-teal-100 bg-teal-50/70 p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-wide text-teal-700">
            {lang === "tl" ? "Praktikal na gabay" : "Practical farmer guide"}
          </p>
          <h2 className="text-xl font-black text-slate-950">{selectedScore.fish.name}</h2>
        </div>
        <span className={`w-fit rounded-full px-3 py-1 text-xs font-black ring-1 ${badgeClasses(selectedScore.confidence)}`}>
          {selectedScore.confidence} {text.confidence}
        </span>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-teal-100">
          <h3 className="text-sm font-black text-slate-950">{lang === "tl" ? "Alagaan ang isda" : "Fish care"}</h3>
          <p className="mt-2 text-sm font-medium leading-6 text-slate-700">{fishDescription(selectedScore.fish, lang)}</p>
        </div>
        <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-teal-100">
          <h3 className="text-sm font-black text-slate-950">{lang === "tl" ? "Paalala sa pagpapakain" : "Feeding note"}</h3>
          <p className="mt-2 text-sm font-medium leading-6 text-slate-700">{fishCareGuide(selectedScore.fish, lang)}</p>
        </div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Fact label={text.harvestTime} value={selectedScore.fish.harvestTime} />
        <Fact label={text.marketValue} value={selectedScore.fish.marketValue} />
        <Fact label={text.category} value={selectedScore.fish.category} />
      </div>
    </section>
  );
}

function ParameterAnalysis({ lang, selectedScore }: { lang: Lang; selectedScore: FishScore }) {
  return (
    <section>
      <h2 className="mb-4 text-sm font-black uppercase tracking-wide text-slate-500">Parameter Analysis</h2>
      <div className="space-y-4">
        {parameterMeta.map((meta) => {
          const score = selectedScore.breakdown[meta.key];
          const status = score >= 85 ? "safe" : score >= 65 ? "warning" : "critical";
          return (
            <article key={meta.key} className={`rounded-2xl border p-5 shadow-card ${levelClasses(status)}`}>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="h-3 w-3 rounded-full bg-current" />
                  <h3 className="font-black uppercase text-slate-900">{meta.label[lang]}</h3>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-black text-slate-950">{score}%</span>
                  <span className={`rounded-full px-3 py-1 text-xs font-black ring-1 ${badgeClasses(status)}`}>✓ {status}</span>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between text-sm font-semibold text-slate-500">
                <span>Suitability</span>
                <span>{score}%</span>
              </div>
              <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-200">
                <div className={`h-full rounded-full ${progressColor(score)} ${progressWidth(score)}`} />
              </div>
              <div className="mt-4 flex items-center justify-between text-sm font-semibold text-slate-500">
                <span>Optimal range</span>
                <span>{meta.safe}</span>
              </div>
              <p className="mt-3 text-sm font-medium text-slate-600">
                {meta.label[lang]} is evaluated against the optimal range for {selectedScore.fish.name}.
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-teal-100 bg-white p-4 text-center">
      <p className="text-sm font-black text-teal-700">{value}</p>
      <p className="mt-1 text-xs font-bold text-slate-500">{label}</p>
    </div>
  );
}

function CorrectiveActions({ alerts, status, lang, text }: { alerts: AlertItem[]; status: AlertLevel; lang: Lang; text: typeof ui.en }) {
  const urgencyLabel = (alertLevel: AlertLevel, index: number) => {
    if (alertLevel === "critical" && index === 0) return lang === "tl" ? "Gawin agad" : "Do now";
    if (index <= 1) return lang === "tl" ? "Unahin" : "Priority";
    return lang === "tl" ? "Bantayan" : "Monitor";
  };
  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-black text-slate-950">{text.correctiveActions}</h2>
        <span className={`rounded-full px-3 py-1 text-xs font-black ring-1 ${badgeClasses(status)}`}>{status}</span>
      </div>
      <div className="mt-4 space-y-3">
        {alerts.map((alert) => (
          <article key={alert.title} className={`overflow-hidden rounded-2xl border ${levelClasses(alert.level)}`}>
            <div className="flex items-center justify-between gap-3 border-b border-current/10 px-4 py-3">
              <strong>{localize(alert.title, lang)}</strong>
              <span className={`rounded-full px-2.5 py-1 text-xs font-black ring-1 ${badgeClasses(alert.level)}`}>{alert.level}</span>
            </div>
            <ol className="space-y-2 px-5 py-4 text-sm font-medium">
              {alert.actions.map((action, index) => (
                <li key={action} className="flex gap-3 rounded-xl bg-white/50 p-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/80 text-xs font-black">{index + 1}</span>
                  <span className="min-w-0">
                    <span className="mb-1 inline-flex rounded-full bg-slate-950 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-white">
                      {urgencyLabel(alert.level, index)}
                    </span>
                    <span className="block font-bold">{localize(action, lang)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </article>
        ))}
      </div>
    </section>
  );
}

function FeedingCard({ params, lang, text }: { params: WaterParams; lang: Lang; text: typeof ui.en }) {
  const hour = new Date().getHours();
  const activeWindow = hour >= 6 && hour < 8 ? "morning" : hour >= 16 && hour < 18 ? "afternoon" : "";
  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 text-lg font-black text-slate-950">🍽️ {text.feedingManagement}</h2>
      <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
        <p className="flex items-center gap-2 text-sm font-black">
          <span className="h-4 w-4 rounded-full bg-emerald-400 shadow-sm" />
          {activeWindow === "afternoon" ? "Afternoon Feeding Time" : activeWindow === "morning" ? "Morning Feeding Time" : "Not Feeding Time"}
        </p>
        <p className="mt-2 text-sm font-medium leading-6">{localize(feedingAdvice(params), lang)}</p>
      </div>
      <div className="mt-4">
        <p className="text-xs font-black uppercase tracking-wide text-slate-500">Daily Windows</p>
        <div className="mt-3 space-y-2 text-sm font-semibold text-slate-600">
          <div className={`flex items-center justify-between rounded-xl px-3 py-2 ${activeWindow === "morning" ? "bg-teal-50 text-teal-700" : ""}`}>
            <span>Morning</span>
            <span>6:00 - 8:00 AM</span>
          </div>
          <div className={`flex items-center justify-between rounded-xl px-3 py-2 ${activeWindow === "afternoon" ? "bg-teal-50 text-teal-700" : ""}`}>
            <span>Afternoon</span>
            <span>4:00 - 6:00 PM</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function FishRankingPanel({
  scores,
  selectedId,
  onSelectFish,
  text
}: {
  scores: FishScore[];
  selectedId: string;
  onSelectFish: (id: string) => void;
  text: typeof ui.en;
}) {
  return (
    <section className="card h-fit p-5">
      <h2 className="flex items-center gap-2 text-lg font-black text-slate-950">
        <Fish className="text-teal-600" size={21} /> {text.ranking}
      </h2>
      <p className="mt-2 text-sm font-medium text-slate-500">{text.clickFish}</p>
      <div className="mt-5 space-y-3">
        {scores.map((score, index) => {
          const confidence = confidenceLevel(score.score);
          const isTop = index === 0;
          const isSelected = selectedId === score.fish.id;
          return (
            <button
              key={score.fish.id}
              className={`w-full rounded-2xl border bg-white p-4 text-left transition hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-card ${
                isTop ? "border-teal-500 ring-2 ring-teal-100" : isSelected ? "border-teal-300" : "border-slate-200"
              }`}
              onClick={() => onSelectFish(score.fish.id)}
            >
              <div className="flex items-start gap-3">
                <span className="mt-1 text-sm font-black text-slate-500">#{index + 1}</span>
                <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-2xl bg-slate-100 ring-1 ring-slate-200">
                  <img src={fishImageSrc(score.fish.id)} alt={score.fish.name} className="h-full w-full object-cover" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-black text-slate-950">{score.fish.name}</span>
                  <span className="block truncate text-xs italic text-slate-500">{score.fish.scientificName}</span>
                </span>
                <span className="text-sm font-black text-teal-700">{score.score}%</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full ${progressColor(score.score)} ${progressWidth(score.score)}`} />
              </div>
              <div className="mt-3 flex justify-end">
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-black ring-1 ${badgeClasses(confidence)}`}>
                  <span className="h-2 w-2 rounded-full bg-current" /> {confidence}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function DashboardTrends({
  params,
  sessions,
  text
}: {
  params: WaterParams;
  sessions: SessionRecord[];
  text: typeof ui.en;
}) {
  const currentPoint: SessionRecord = {
    id: "current",
    timestamp: "Current",
    ...params,
    bestFish: "-",
    score: 0
  };
  const chartData = [...sessions].reverse();
  const data = chartData.length ? chartData : [currentPoint];
  const trendCards = [
    { key: "ph", label: "pH", color: "#0d9488", domain: [4, 11] },
    { key: "temperature", label: "Temp (°C)", color: "#f59e0b", domain: [10, 40] },
    { key: "dissolvedOxygen", label: "DO (mg/L)", color: "#2563eb", domain: [0, 15] },
    { key: "turbidity", label: "Turbidity (NTU)", color: "#8b5cf6", domain: [0, 500] },
    { key: "ammonia", label: "Ammonia (mg/L)", color: "#dc2626", domain: [0, 0.5] }
  ] as const;

  return (
    <section className="card lg:col-span-3 p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-black text-slate-950">
            <BarChart3 className="text-teal-600" size={22} /> {text.trendTitle}
          </h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            {sessions.length ? `Last ${sessions.length} readings saved from the dashboard` : "Run Analyze Water Quality to start building trend history"}
          </p>
        </div>
        <span className="rounded-full bg-teal-50 px-3 py-1.5 text-xs font-black text-teal-700 ring-1 ring-teal-100">
          Dashboard Trends
        </span>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {trendCards.map((card) => (
          <article key={card.key} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-black uppercase tracking-wide text-slate-600">{card.label}</h3>
              <span className="text-sm font-black text-slate-950">
                {valueText(card.key, params[card.key])}
              </span>
            </div>
            <div className="mt-3 h-32">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="timestamp" hide />
                  <YAxis domain={card.domain} hide />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey={card.key}
                    stroke={card.color}
                    strokeWidth={3}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-xs font-semibold text-slate-500">
              Safe: {parameterMeta.find((meta) => meta.key === card.key)?.safe}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

function HistoryPage({ sessions, onExport, text }: { sessions: SessionRecord[]; onExport: () => void; text: typeof ui.en }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const counts = sessions.reduce(
    (acc, row) => {
      acc[overallStatus(row)] += 1;
      return acc;
    },
    { safe: 0, warning: 0, critical: 0 }
  );
  const filteredSessions = sessions.filter((row) => {
    const status = overallStatus(row);
    const haystack = `${row.timestamp} ${row.bestFish} ${status}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (statusFilter === "all" || status === statusFilter);
  });
  return (
    <main className="mx-auto max-w-[1500px] space-y-5 px-4 pb-8 sm:px-6">
      <section className="card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-2xl font-black text-slate-950">{text.history}</h2>
            <p className="text-sm font-semibold text-slate-500">{filteredSessions.length} of {sessions.length} records shown</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <span className="rounded-xl bg-emerald-50 px-3 py-2 text-sm font-black text-emerald-700">Safe {counts.safe}</span>
            <span className="rounded-xl bg-amber-50 px-3 py-2 text-sm font-black text-amber-700">Warning {counts.warning}</span>
            <span className="rounded-xl bg-red-50 px-3 py-2 text-sm font-black text-red-700">Critical {counts.critical}</span>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="min-h-11 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold outline-none focus:border-teal-400 focus:ring-4 focus:ring-teal-100"
              placeholder="Search fish, date, status..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              className="min-h-11 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-black text-slate-600"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All status</option>
              <option value="safe">Safe</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <button className="soft-button" onClick={onExport}>
            <Download size={16} /> {text.exportCsv}
          </button>
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                <th className="px-4 py-3">{text.dateTime}</th>
                <th className="px-4 py-3">pH</th>
                <th className="px-4 py-3">Temp</th>
                <th className="px-4 py-3">DO</th>
                <th className="px-4 py-3">Turbidity</th>
                <th className="px-4 py-3">Ammonia</th>
                <th className="px-4 py-3">Best Fish</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">{text.status}</th>
              </tr>
            </thead>
            <tbody>
              {filteredSessions.map((row) => {
                const status = overallStatus(row);
                return (
                  <tr key={row.id} className="border-b border-slate-100">
                    <td className="px-4 py-3 font-semibold text-slate-700">{row.timestamp}</td>
                    <td className="px-4 py-3">{row.ph}</td>
                    <td className="px-4 py-3">{row.temperature}</td>
                    <td className="px-4 py-3">{row.dissolvedOxygen}</td>
                    <td className="px-4 py-3">{row.turbidity}</td>
                    <td className="px-4 py-3">{row.ammonia}</td>
                    <td className="px-4 py-3 font-bold">{row.bestFish}</td>
                    <td className="px-4 py-3 font-black text-teal-700">{row.score}%</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-black ring-1 ${badgeClasses(status)}`}>{status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!sessions.length && <p className="py-8 text-center text-sm font-semibold text-slate-500">{text.noHistory}</p>}
          {sessions.length > 0 && !filteredSessions.length && <p className="py-8 text-center text-sm font-semibold text-slate-500">No records match your filters.</p>}
        </div>
      </section>

    </main>
  );
}

function FarmerGuidePage({ lang, fishDb, text }: { lang: Lang; fishDb: FishSpecies[]; text: typeof ui.en }) {
  return (
    <main className="mx-auto grid max-w-[1500px] gap-5 px-4 pb-8 sm:px-6 lg:grid-cols-3">
      <section className="card p-6">
        <h2 className="text-xl font-black text-slate-950">{text.farmingTips}</h2>
        <ul className="mt-4 space-y-3 text-sm font-medium leading-6 text-slate-700">
          <li>Monitor pH, DO, turbidity, ammonia, and temperature every day.</li>
          <li>Stop feeding when ammonia rises or oxygen drops below the safe range.</li>
          <li>Keep net and cage areas clean to reduce organic waste buildup.</li>
          <li>Use local expert guidance before applying any treatment in Laguna Lake conditions.</li>
        </ul>
      </section>
      <section className="card p-6">
        <h2 className="text-xl font-black text-slate-950">{text.seasonalTips}</h2>
        <ul className="mt-4 space-y-3 text-sm font-medium leading-6 text-slate-700">
          <li>Summer: watch heat stress and low dissolved oxygen in the afternoon.</li>
          <li>Rainy season: recheck pH and turbidity after heavy rainfall.</li>
          <li>Typhoon season: avoid handling fish and inspect cages after strong water movement.</li>
          <li>Laguna de Bay: consult BFAR/LGU when unusual color, odor, or fish behavior appears.</li>
        </ul>
      </section>
      <section className="card overflow-hidden p-6 lg:col-span-1">
        <h2 className="text-xl font-black text-slate-950">{text.optimalRanges}</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                <th className="px-3 py-3">Parameter</th>
                <th className="px-3 py-3">Safe Range</th>
              </tr>
            </thead>
            <tbody>
              {parameterMeta.map((meta) => (
                <tr key={meta.key} className="border-b border-slate-100">
                  <td className="px-3 py-3 font-bold text-slate-800">{meta.label[lang]}</td>
                  <td className="px-3 py-3 font-black text-teal-700">{meta.safe}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="grid gap-5 lg:col-span-3 lg:grid-cols-4">
        {fishDb.map((fish) => (
          <article key={fish.id} className="card p-5">
            <div className="h-28 overflow-hidden rounded-2xl bg-slate-100 ring-1 ring-slate-200">
              <img src={fishImageSrc(fish.id)} alt={fish.name} className="h-full w-full object-cover" />
            </div>
            <h3 className="mt-3 text-lg font-black text-slate-950">{fish.name}</h3>
            <p className="text-xs italic text-slate-500">{fish.scientificName}</p>
            <p className="mt-3 text-sm leading-6 text-slate-700">{fishDescription(fish, lang)}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

function AuthPage({
  initialMode,
  text,
  navigate,
  onLogin
}: {
  initialMode: "login" | "register";
  text: typeof ui.en;
  navigate: (path: string) => void;
  onLogin: (user: AppUser, message: string) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("+639");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async () => {
    setMessage(null);
    const cleanPhone = phone.trim();
    if (!/^(\+639)\d{9}$/.test(cleanPhone)) return setMessage({ type: "error", text: "Use Philippine format: +639XXXXXXXXX." });
    if (!password) return setMessage({ type: "error", text: "Please enter your password." });
    if (mode === "register" && !fullName.trim()) return setMessage({ type: "error", text: "Please enter your full name." });

    setIsSubmitting(true);
    if (mode === "register") {
      const result = await postJson<{ id: number | string; fullName: string; phone: string; role?: "farmer" | "admin" }>("/api/register", {
        fullName: fullName.trim(),
        phone: cleanPhone,
        password
      });
      setIsSubmitting(false);
      if (result.error) return setMessage({ type: "error", text: result.error });
      setMessage({ type: "success", text: "Account created. Please login." });
      setMode("login");
      navigate("/login");
      return;
    }

    const result = await postJson<{ id: number | string; fullName: string; phone: string; createdAt?: string; role?: "farmer" | "admin" }>("/api/login", {
      phone: cleanPhone,
      password
    });
    setIsSubmitting(false);
    if (result.error || !result.data) return setMessage({ type: "error", text: result.error || "Login failed." });

    const user: AppUser = {
      id: String(result.data.id),
      fullName: result.data.fullName,
      phone: result.data.phone,
      passwordHash: simpleHash(password),
      createdAt: result.data.createdAt ?? new Date().toISOString(),
      role: result.data.role ?? "farmer"
    };
    storage.saveCurrentUser(user);
    storage.saveUsers([user, ...storage.users().filter((item) => item.phone !== user.phone)]);
    onLogin(user, "Login successful.");
  };

  return (
    <div className="admin-login-shell relative grid min-h-screen place-items-center overflow-hidden p-4">
      <div className="admin-water-glow" />
      <div className="admin-ripple admin-ripple-one" />
      <div className="admin-ripple admin-ripple-two" />
      <section className="auth-card relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-white/25 bg-white shadow-2xl">
        <div className="bg-gradient-to-br from-teal-500 to-emerald-600 p-6 text-white">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center overflow-hidden rounded-xl bg-white/95 shadow">
              <img src="/logofishpond.png?v=logo-20260612" alt="PondSense of Us logo" className="h-full w-full object-cover" />
            </span>
            <div>
              <h1 className="text-2xl font-black">PondSense of Us</h1>
              <p className="text-sm font-medium text-teal-50">{mode === "register" ? "Create your farmer account" : "Login to farmer dashboard"}</p>
            </div>
          </div>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-2 rounded-xl bg-slate-100 p-1">
            <button className={`auth-subtle-button rounded-lg px-3 py-2 text-sm font-black ${mode === "login" ? "bg-white text-teal-700 shadow-sm" : "text-slate-500"}`} onClick={() => { setMode("login"); navigate("/login"); }}>Login</button>
            <button className={`auth-subtle-button rounded-lg px-3 py-2 text-sm font-black ${mode === "register" ? "bg-white text-teal-700 shadow-sm" : "text-slate-500"}`} onClick={() => { setMode("register"); navigate("/register"); }}>Register</button>
          </div>
          {message && <p className={`auth-message mt-4 rounded-xl px-3 py-2 text-sm font-bold ${message.type === "error" ? "auth-error bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>{message.text}</p>}
          <div className="mt-4 space-y-3">
            {mode === "register" && <input className="auth-input w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-semibold outline-none" placeholder={text.fullName} value={fullName} onChange={(event) => setFullName(event.target.value)} />}
            <input className="auth-input w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-semibold outline-none" placeholder="+639XXXXXXXXX" value={phone} onChange={(event) => setPhone(event.target.value.replace(/\s/g, ""))} />
            <input className="auth-input w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-semibold outline-none" type="password" placeholder={text.password} value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submit()} />
          </div>
          <button className="primary-button mt-5 w-full disabled:cursor-not-allowed disabled:bg-slate-400" onClick={submit} disabled={isSubmitting}>
            {isSubmitting && <span className="loading-spinner" />}
            {isSubmitting ? (mode === "register" ? "Creating account..." : "Logging in...") : mode === "register" ? text.createAccount : text.login}
          </button>
          <button className="auth-subtle-button mt-3 w-full rounded-xl px-4 py-2 text-sm font-bold text-slate-500 transition hover:bg-slate-100" onClick={() => navigate("/dashboard")}>Continue as Guest</button>
        </div>
      </section>
    </div>
  );
}

function ProfilePage({ currentUser, navigate }: { currentUser: AppUser | null; navigate: (path: string) => void }) {
  if (!currentUser) {
    navigate("/login");
    return null;
  }
  return (
    <div className="min-h-screen bg-slate-100 p-4 sm:p-6">
      <section className="mx-auto max-w-xl rounded-2xl bg-white p-6 shadow">
        <h1 className="text-2xl font-black text-slate-950">Profile</h1>
        <div className="mt-5 space-y-3 text-sm">
          <p><span className="font-black text-slate-500">Name:</span> {currentUser.fullName}</p>
          <p><span className="font-black text-slate-500">Phone:</span> {currentUser.phone}</p>
          <p><span className="font-black text-slate-500">Role:</span> {currentUser.role || "user"}</p>
        </div>
        <button className="primary-button mt-6" onClick={() => navigate("/dashboard")}>Back to Dashboard</button>
      </section>
    </div>
  );
}

function AuthModal({ text, onClose, onLogin }: { text: typeof ui.en; onClose: () => void; onLogin: (user: AppUser, message: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("+639");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async () => {
    setMessage(null);
    const users = storage.users();
    const cleanPhone = phone.trim();
    if (!/^(\+639)\d{9}$/.test(cleanPhone)) {
      return setMessage({ type: "error", text: "Use Philippine format: +639XXXXXXXXX. Example: +639929598628" });
    }
    if (!password) {
      return setMessage({ type: "error", text: "Please enter your password." });
    }

    setIsSubmitting(true);
    if (mode === "register") {
      if (!fullName.trim()) {
        setIsSubmitting(false);
        return setMessage({ type: "error", text: "Please enter your full name." });
      }
      if (users.some((user) => user.phone === cleanPhone)) {
        setIsSubmitting(false);
        return setMessage({ type: "error", text: "This phone is already saved on this device. Switch to Login." });
      }

      const apiUser = await postJson<{ id: number | string; fullName: string; phone: string; role?: "farmer" | "admin" }>("/api/register", {
        fullName: fullName.trim(),
        phone: cleanPhone,
        password
      });
      if (apiUser.error) {
        setIsSubmitting(false);
        return setMessage({ type: "error", text: apiUser.error });
      }
      const user: AppUser = {
        id: String(apiUser.data?.id ?? crypto.randomUUID()),
        fullName: apiUser.data?.fullName ?? fullName.trim(),
        phone: apiUser.data?.phone ?? cleanPhone,
        passwordHash: simpleHash(password),
        createdAt: new Date().toISOString(),
        role: apiUser.data?.role ?? "farmer"
      };
      storage.saveUsers([...users, user]);
      storage.saveCurrentUser(user);
      setIsSubmitting(false);
      onLogin(user, `Welcome ${user.fullName}. SMS alerts are ready for water warnings.`);
      onClose();
    } else {
      const apiUser = await postJson<{ id: number | string; fullName: string; phone: string; createdAt?: string; role?: "farmer" | "admin" }>("/api/login", {
        phone: cleanPhone,
        password
      });
      if (apiUser.data) {
        const user: AppUser = {
          id: String(apiUser.data.id),
          fullName: apiUser.data.fullName,
          phone: apiUser.data.phone,
          passwordHash: simpleHash(password),
          createdAt: apiUser.data.createdAt ?? new Date().toISOString(),
          role: apiUser.data.role ?? "farmer"
        };
        storage.saveUsers([user, ...users.filter((item) => item.phone !== user.phone)]);
        storage.saveCurrentUser(user);
        setIsSubmitting(false);
        onLogin(user, `Login successful. Water warning SMS alerts are active.`);
        onClose();
        return;
      }

      const localUser = users.find((item) => item.phone === cleanPhone && item.passwordHash === simpleHash(password));
      if (!localUser) {
        setIsSubmitting(false);
        return setMessage({ type: "error", text: apiUser.error || "No account found. Please register first." });
      }
      storage.saveCurrentUser(localUser);
      setIsSubmitting(false);
      onLogin(localUser, `Local login successful. Backend SMS was not used for this local fallback account.`);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4">
      <section className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="bg-gradient-to-br from-teal-500 to-emerald-600 p-6 text-white">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-2xl font-black">🐟 Fish Pond DSS</h2>
              <p className="text-sm font-medium text-teal-50">{mode === "register" ? "Create your farmer account" : "Sign in to enable SMS alerts"}</p>
            </div>
            <button className="grid h-9 w-9 place-items-center rounded-full bg-white/15 text-white" onClick={onClose}>×</button>
          </div>
          <div className="mt-5 grid grid-cols-2 rounded-xl bg-white/15 p-1">
            <button className={`rounded-lg px-3 py-2 text-sm font-black ${mode === "login" ? "bg-white text-teal-700 shadow-sm" : "text-white"}`} onClick={() => { setMode("login"); setMessage(null); }}>{text.login}</button>
            <button className={`rounded-lg px-3 py-2 text-sm font-black ${mode === "register" ? "bg-white text-teal-700 shadow-sm" : "text-white"}`} onClick={() => { setMode("register"); setMessage(null); }}>{text.register}</button>
          </div>
        </div>
        <div className="p-6">
          <h3 className="text-sm font-black uppercase tracking-wide text-slate-500">{mode === "register" ? "New Account" : "Farmer Login"}</h3>
          {message && (
            <div className={`mt-4 rounded-xl border px-4 py-3 text-sm font-semibold ${
              message.type === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}>
              {message.text}
            </div>
          )}
          <div className="mt-4 space-y-3">
            {mode === "register" && <input className="w-full rounded-xl border border-slate-200 bg-slate-100 px-4 py-3" placeholder={text.fullName} value={fullName} onChange={(event) => setFullName(event.target.value)} />}
            <input className="w-full rounded-xl border border-slate-200 bg-slate-100 px-4 py-3" placeholder="+639XXXXXXXXX" value={phone} onChange={(event) => setPhone(event.target.value.replace(/\s/g, ""))} />
            <input className="w-full rounded-xl border border-slate-200 bg-slate-100 px-4 py-3" type="password" placeholder={text.password} value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          <button className="primary-button mt-5 w-full disabled:cursor-not-allowed disabled:bg-slate-400" onClick={submit} disabled={isSubmitting}>
            {isSubmitting ? "Please wait..." : mode === "register" ? text.createAccount : text.login}
          </button>
          {mode === "login" && (
            <button className="mt-3 w-full text-center text-sm font-bold text-teal-700 hover:text-teal-800" onClick={() => { setMode("register"); setMessage(null); }}>
              No account yet? Create one here.
            </button>
          )}
          <p className="mt-4 text-center text-xs font-semibold text-slate-500">🔒 Local demo account only on this device</p>
        </div>
      </section>
    </div>
  );
}

function AdminRouter({ path, navigate, text }: { path: AdminPath; navigate: (path: string) => void; text: typeof ui.en }) {
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(path !== "/admin/login");
  const routes: Array<{ path: AdminPath; label: string; icon: typeof Shield }> = [
    { path: "/admin/dashboard", label: "Dashboard", icon: BarChart3 },
    { path: "/admin/users", label: "Users", icon: User },
    { path: "/admin/logs", label: "Logs", icon: Database },
    { path: "/admin/thresholds", label: "Thresholds", icon: Fish },
    { path: "/admin/settings", label: "Settings", icon: Settings }
  ];

  useEffect(() => {
    if (path === "/admin/login") {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    apiJson<{ admin: AdminUser | null }>("/api/admin/session").then((result) => {
      if (!active) return;
      if (!result.data?.admin) {
        navigate("/admin/login");
        return;
      }
      setAdmin(result.data.admin);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [path, navigate]);

  if (path === "/admin/login") {
    return <AdminLoginPage navigate={navigate} />;
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100">
        <div className="rounded-2xl bg-white px-6 py-5 text-sm font-black text-slate-600 shadow">Checking admin session...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-3 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center overflow-hidden rounded-xl bg-white ring-1 ring-teal-100">
              <img src="/logofishpond.png?v=logo-20260612" alt="PondSense of Us logo" className="h-full w-full object-cover" />
            </span>
            <div>
              <h1 className="text-lg font-black text-slate-950">Admin Console</h1>
              <p className="text-sm font-semibold text-slate-500">Signed in as {admin?.fullName || "Administrator"}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="soft-button" onClick={() => navigate("/")}>Farmer Dashboard</button>
            <button
              className="soft-button"
              onClick={async () => {
                await apiJson("/api/admin/logout", { method: "POST", body: "{}" });
                navigate("/admin/login");
              }}
            >
              <LogOut size={16} /> Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1500px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[260px_1fr]">
        <aside className="card h-fit p-3">
          <nav className="space-y-1">
            {routes.map((route) => (
              <button
                key={route.path}
                className={`flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left text-sm font-black transition ${
                  path === route.path ? "bg-teal-100 text-teal-800" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                }`}
                onClick={() => navigate(route.path)}
              >
                <route.icon size={17} /> {route.label}
              </button>
            ))}
          </nav>
        </aside>

        <section className="space-y-5">
          <AdminContent path={path} navigate={navigate} text={text} />
        </section>
      </main>
    </div>
  );
}

function AdminLoginPage({ navigate }: { navigate: (path: string) => void }) {
  const [identifier, setIdentifier] = useState("admin");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const login = async () => {
    setError("");
    setSubmitting(true);
    const result = await postJson<{ admin: AdminUser }>("/api/admin/login", { identifier, password, pin });
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    navigate("/admin/dashboard");
  };

  return (
    <div className="admin-login-shell relative grid min-h-screen place-items-center overflow-hidden p-4">
      <div className="admin-water-glow" />
      <div className="admin-ripple admin-ripple-one" />
      <div className="admin-ripple admin-ripple-two" />
      <section className="auth-card relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-white/25 bg-white shadow-2xl">
        <div className="bg-gradient-to-br from-teal-500 to-emerald-600 p-6 text-white">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center overflow-hidden rounded-xl bg-white/95 shadow">
              <img src="/logofishpond.png?v=logo-20260612" alt="PondSense of Us logo" className="h-full w-full object-cover" />
            </span>
            <div>
              <p className="text-sm font-black uppercase tracking-[0.18em] text-teal-50">PondSense of Us</p>
              <h1 className="flex items-center gap-2 text-2xl font-black"><Shield size={22} /> Admin Login</h1>
            </div>
          </div>
          <p className="mt-2 text-sm font-medium text-teal-50">Secure access for system management</p>
        </div>
        <div className="space-y-3 p-6">
          <input className="auth-input w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-semibold outline-none" placeholder="Username or email" value={identifier} onChange={(event) => setIdentifier(event.target.value)} />
          <input className="auth-input w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-semibold outline-none" type="password" placeholder="Admin password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <input className="auth-input w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-semibold outline-none" type="password" placeholder="Admin PIN" value={pin} onChange={(event) => setPin(event.target.value)} onKeyDown={(event) => event.key === "Enter" && login()} />
          {error && <p className="auth-message auth-error rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">{error}</p>}
          <button className="primary-button w-full disabled:cursor-not-allowed disabled:bg-slate-400" onClick={login} disabled={submitting}>
            {submitting && <span className="loading-spinner" />}
            {submitting ? "Logging in..." : "Login to Admin"}
          </button>
          <div className="grid gap-2 sm:grid-cols-2">
            <button className="auth-subtle-button rounded-xl px-4 py-2 text-sm font-bold text-slate-500 transition hover:bg-slate-100" onClick={() => navigate("/")}>
              Farmer Dashboard
            </button>
            <button className="auth-subtle-button rounded-xl px-4 py-2 text-sm font-black text-teal-700 transition hover:bg-teal-50" onClick={() => navigate("/login")}>
              Farmer Login
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function AdminContent({ path, navigate, text }: { path: AdminPath; navigate: (path: string) => void; text: typeof ui.en }) {
  if (path === "/admin/dashboard") return <AdminDashboardPage />;
  if (path === "/admin/users") return <AdminUsersPage />;
  if (path === "/admin/logs") return <AdminLogsPage />;
  if (path === "/admin/thresholds") return <AdminThresholdsPage />;
  if (path === "/admin/settings") return <AdminSettingsPage navigate={navigate} text={text} />;
  return <AdminDashboardPage />;
}

function AdminDashboardPage() {
  const [stats, setStats] = useState({ users: 0, readings: 0, alerts: 0, correctiveActions: 0, criticalToday: 0, smsToday: 0 });
  useEffect(() => {
    apiJson<typeof stats>("/api/admin/stats").then((result) => result.data && setStats(result.data));
  }, []);
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-black text-slate-950">Admin Dashboard</h2>
        <p className="text-sm font-semibold text-slate-500">Quick overview of farmers, readings, alerts, and system activity.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStat label="Total Farmers" value={stats.users} />
        <AdminStat label="Total Readings" value={stats.readings} />
        <AdminStat label="Critical Today" value={stats.criticalToday} />
        <AdminStat label="SMS Sent Today" value={stats.smsToday} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-5">
          <h3 className="text-lg font-black text-slate-950">System Summary</h3>
          <div className="mt-4 space-y-3 text-sm font-semibold text-slate-600">
            <p className="flex justify-between rounded-xl bg-slate-50 px-3 py-2"><span>All SMS alert records</span><span>{stats.alerts}</span></p>
            <p className="flex justify-between rounded-xl bg-slate-50 px-3 py-2"><span>Corrective action logs</span><span>{stats.correctiveActions}</span></p>
            <p className="flex justify-between rounded-xl bg-slate-50 px-3 py-2"><span>Last updated</span><span>{new Date().toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" })}</span></p>
          </div>
        </section>
        <section className="card p-5">
          <h3 className="text-lg font-black text-slate-950">Admin Focus</h3>
          <ol className="mt-4 space-y-2 text-sm font-semibold text-slate-600">
            <li className="rounded-xl border border-slate-200 px-3 py-2">1. Check critical readings first.</li>
            <li className="rounded-xl border border-slate-200 px-3 py-2">2. Review SMS logs and failed sends.</li>
            <li className="rounded-xl border border-slate-200 px-3 py-2">3. Adjust fish thresholds only with adviser/BFAR guidance.</li>
          </ol>
        </section>
      </div>
    </div>
  );
}

function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    apiJson<{ users: AdminUser[] }>("/api/admin/users").then((result) => result.data && setUsers(result.data.users));
  }, []);
  const filteredUsers = users.filter((user) => {
    const value = `${user.fullName} ${user.username || ""} ${user.email || ""} ${user.phone || ""} ${user.role}`.toLowerCase();
    return value.includes(query.toLowerCase());
  });
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-black text-slate-950">Registered Users</h2>
          <p className="text-sm font-semibold text-slate-500">{filteredUsers.length} of {users.length} accounts shown</p>
        </div>
        <input
          className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold outline-none focus:border-teal-400 focus:ring-4 focus:ring-teal-100 sm:max-w-xs"
          placeholder="Search name, phone, role..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Username/Email</th><th className="px-4 py-3">Phone</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Created</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredUsers.map((user) => (
              <tr key={user.id}>
                <td className="px-4 py-3 font-bold text-slate-900">{user.fullName}</td>
                <td className="px-4 py-3 text-slate-600">{user.username || user.email || "-"}</td>
                <td className="px-4 py-3 text-slate-600">{user.phone || "-"}</td>
                <td className="px-4 py-3"><span className={badgeClasses(user.role === "admin" ? "High" : "Medium")}>{user.role}</span></td>
                <td className="px-4 py-3 text-slate-600">{user.createdAt ? new Date(user.createdAt).toLocaleString("en-PH") : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AdminLogsPage() {
  const [logs, setLogs] = useState<Array<Record<string, unknown>>>([]);
  const [alerts, setAlerts] = useState<Array<Record<string, unknown>>>([]);
  const [auditLogs, setAuditLogs] = useState<Array<Record<string, unknown>>>([]);
  const [logSearch, setLogSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [smsFilter, setSmsFilter] = useState("all");
  useEffect(() => {
    apiJson<{ logs: Array<Record<string, unknown>> }>("/api/admin/logs").then((result) => result.data && setLogs(result.data.logs));
    apiJson<{ alerts: Array<Record<string, unknown>> }>("/api/admin/alerts").then((result) => result.data && setAlerts(result.data.alerts));
    apiJson<{ auditLogs: Array<Record<string, unknown>> }>("/api/admin/audit-logs").then((result) => result.data && setAuditLogs(result.data.auditLogs));
  }, []);
  const filteredLogs = logs.filter((row) => {
    const haystack = `${row.full_name || ""} ${row.phone || ""} ${row.status || ""} ${row.best_fish || ""}`.toLowerCase();
    const matchesSearch = haystack.includes(logSearch.toLowerCase());
    const matchesStatus = statusFilter === "all" || String(row.status || "").toLowerCase() === statusFilter;
    return matchesSearch && matchesStatus;
  });
  const filteredAlerts = alerts.filter((alert) => {
    const haystack = `${alert.full_name || ""} ${alert.phone || ""} ${alert.alert_type || ""} ${alert.severity || ""} ${alert.message || ""} ${alert.sms_status || ""} ${alert.sms_error || ""}`.toLowerCase();
    const matchesSearch = haystack.includes(logSearch.toLowerCase());
    const smsStatus = String(alert.sms_status || (Number(alert.sms_sent) === 1 ? "sent" : "skipped")).toLowerCase();
    const matchesSms = smsFilter === "all" || smsStatus === smsFilter;
    return matchesSearch && matchesSms;
  });
  const filteredAuditLogs = auditLogs.filter((log) => {
    const haystack = `${log.full_name || ""} ${log.username || ""} ${log.action || ""} ${log.details || ""}`.toLowerCase();
    return haystack.includes(logSearch.toLowerCase());
  });
  const exportRows = () => {
    const rows = [["Time", "Farmer", "pH", "Temp", "Turbidity", "Ammonia", "DO", "Best Fish", "Score", "Status"], ...filteredLogs.map((row) => [
      row.recorded_at, row.full_name, row.ph, row.temperature, row.turbidity, row.ammonia, row.dissolved_oxygen, row.best_fish, row.best_score, row.status
    ])];
    const csv = rows.map((row) => row.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "pondsense-admin-logs.csv";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-5">
      <section className="card p-5">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-xl font-black text-slate-950">Sensor Readings</h2>
            <p className="text-sm font-semibold text-slate-500">{filteredLogs.length} readings shown · Updated {new Date().toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" })}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="min-h-11 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold outline-none focus:border-teal-400 focus:ring-4 focus:ring-teal-100" placeholder="Search farmer, phone, fish..." value={logSearch} onChange={(event) => setLogSearch(event.target.value)} />
            <select className="min-h-11 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-black text-slate-600" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">All status</option>
              <option value="safe">Safe</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <button className="soft-button" onClick={exportRows}><Download size={16} /> Export CSV</button>
        </div>
        <div className="max-h-[360px] overflow-auto">
          {filteredLogs.map((row) => (
            <div key={String(row.id)} className="mb-2 rounded-xl border border-slate-200 p-3 text-sm">
              <p className="font-black text-slate-950">{String(row.full_name || "Guest")} - {String(row.status || "Safe")}</p>
              <p className="text-slate-600">pH {String(row.ph)} | Temp {String(row.temperature)} | Turb {String(row.turbidity)} | NH3 {String(row.ammonia)} | DO {String(row.dissolved_oxygen)}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="card p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-black text-slate-950">SMS Alert Logs</h2>
            <p className="text-sm font-semibold text-slate-500">{filteredAlerts.length} alerts shown</p>
          </div>
          <select className="min-h-11 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-black text-slate-600" value={smsFilter} onChange={(event) => setSmsFilter(event.target.value)}>
            <option value="all">All SMS results</option>
            <option value="sent">SMS sent</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped</option>
          </select>
        </div>
        <div className="space-y-2">
          {filteredAlerts.map((alert) => (
            <div key={String(alert.id)} className="rounded-xl border border-slate-200 p-3 text-sm">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <p className="font-black text-slate-950">{String(alert.alert_type)} - {String(alert.severity)}</p>
                <p className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-black text-slate-600">
                  {String(alert.full_name || "Guest Mode") === "Guest Mode"
                    ? "Guest Mode"
                    : `${String(alert.full_name)} · ${String(alert.phone || "No phone")}`}
                </p>
              </div>
              <p className="text-slate-600">{String(alert.message || "")}</p>
              <p className="mt-1 text-xs font-bold text-slate-400">SMS sent: {Number(alert.sms_sent) === 1 ? "Yes" : "No"}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <span
                  className={`rounded-lg px-2 py-1 text-xs font-black uppercase ${
                    String(alert.sms_status || (Number(alert.sms_sent) === 1 ? "sent" : "skipped")).toLowerCase() === "sent"
                      ? "bg-emerald-100 text-emerald-800"
                      : String(alert.sms_status || "").toLowerCase() === "failed"
                        ? "bg-red-100 text-red-800"
                        : "bg-slate-100 text-slate-700"
                  }`}
                >
                  SMS {String(alert.sms_status || (Number(alert.sms_sent) === 1 ? "sent" : "skipped"))}
                </span>
                {Boolean(alert.sent_at) && <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500">{new Date(String(alert.sent_at)).toLocaleString("en-PH")}</span>}
              </div>
              {Boolean(alert.sms_error) && <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1 text-xs font-bold text-amber-800">Reason: {String(alert.sms_error)}</p>}
            </div>
          ))}
          {!filteredAlerts.length && <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm font-semibold text-slate-500">No SMS alerts match the current filters.</p>}
        </div>
      </section>
      <section className="card p-5">
        <div className="mb-4">
          <h2 className="text-xl font-black text-slate-950">Admin Audit Logs</h2>
          <p className="text-sm font-semibold text-slate-500">{filteredAuditLogs.length} admin actions shown</p>
        </div>
        <div className="space-y-2">
          {filteredAuditLogs.map((log) => (
            <div key={String(log.id)} className="rounded-xl border border-slate-200 p-3 text-sm">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <p className="font-black capitalize text-slate-950">{String(log.action || "admin_action").replace(/_/g, " ")}</p>
                <p className="rounded-lg bg-teal-50 px-2 py-1 text-xs font-black text-teal-800">
                  {String(log.full_name || log.username || "Unknown admin")}
                </p>
              </div>
              <p className="mt-1 text-slate-600">{String(log.details || "No details recorded.")}</p>
              <p className="mt-1 text-xs font-bold text-slate-400">{log.created_at ? new Date(String(log.created_at)).toLocaleString("en-PH") : "No timestamp"}</p>
            </div>
          ))}
          {!filteredAuditLogs.length && <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm font-semibold text-slate-500">No admin actions recorded yet.</p>}
        </div>
      </section>
    </div>
  );
}

function AdminThresholdsPage() {
  const [fish, setFish] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => {
    apiJson<{ fish: Array<Record<string, unknown>> }>("/api/admin/thresholds").then((result) => result.data && setFish(result.data.fish));
  }, []);
  const save = async (row: Record<string, unknown>) => {
    await apiJson(`/api/admin/thresholds/${row.id}`, { method: "PATCH", body: JSON.stringify(row) });
  };
  const fields = [
    { key: "optimal_ph_min", label: "Minimum pH", help: "Lowest acceptable pH" },
    { key: "optimal_ph_max", label: "Maximum pH", help: "Highest acceptable pH" },
    { key: "optimal_temp_min", label: "Minimum Temp", help: "Lowest water temperature" },
    { key: "optimal_temp_max", label: "Maximum Temp", help: "Highest water temperature" },
    { key: "max_ammonia", label: "Max Ammonia", help: "Highest safe NH3 level" }
  ];
  return (
    <section className="card p-5">
      <div className="mb-4">
        <h2 className="text-xl font-black text-slate-950">Fish Threshold Management</h2>
        <p className="text-sm font-semibold text-slate-500">Edit only with validated aquaculture references or adviser guidance.</p>
      </div>
      <div className="space-y-3">
        {fish.map((row, index) => (
          <div key={String(row.id)} className="rounded-2xl border border-slate-200 p-4">
            <h3 className="font-black text-slate-950">{String(row.name)}</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {fields.map((field) => (
                <label key={field.key} className="rounded-xl bg-slate-50 p-3 text-xs font-bold uppercase text-slate-500">
                  {field.label}
                  <input className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-black text-slate-900" type="number" step="0.01" value={String(row[field.key] ?? "")} onChange={(event) => {
                    const next = [...fish];
                    next[index] = { ...row, [field.key]: Number(event.target.value) };
                    setFish(next);
                  }} />
                  <span className="mt-1 block normal-case text-slate-400">{field.help}</span>
                </label>
              ))}
            </div>
            <button className="primary-button mt-3 py-2" onClick={() => save(row)}>Save Thresholds</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function AdminSettingsPage({ navigate, text }: { navigate: (path: string) => void; text: typeof ui.en }) {
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState("");
  const changePin = async () => {
    const result = await apiJson("/api/admin/settings/pin", { method: "POST", body: JSON.stringify({ pin }) });
    setMessage(result.error || "Admin PIN updated.");
    if (!result.error) setPin("");
  };
  const clearLogs = async () => {
    if (!confirm("Type CLEAR_LOGS in the next prompt to clear all logs.")) return;
    if (prompt("Confirmation") !== "CLEAR_LOGS") return;
    const result = await apiJson("/api/admin/logs?confirm=CLEAR_LOGS", { method: "DELETE" });
    setMessage(result.error || "Logs cleared.");
  };
  const factoryReset = async () => {
    if (prompt("Type RESET_PONDSENSE to factory reset user records and logs.") !== "RESET_PONDSENSE") return;
    const result = await apiJson("/api/admin/factory-reset?confirm=RESET_PONDSENSE", { method: "DELETE" });
    setMessage(result.error || "Factory reset complete.");
  };
  return (
    <section className="card p-5">
      <h2 className="text-xl font-black text-slate-950">{text.settings}</h2>
      <div className="mt-5 max-w-md space-y-3">
        <input className="w-full rounded-xl border border-slate-200 px-4 py-3" type="password" placeholder="New admin PIN" value={pin} onChange={(event) => setPin(event.target.value)} />
        <button className="primary-button w-full" onClick={changePin}>Change Admin PIN</button>
        <button className="soft-button w-full" onClick={() => navigate("/admin/login")}>Go to Admin Login</button>
        <button className="w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-black text-white transition hover:bg-amber-600" onClick={clearLogs}>Clear Logs</button>
        <button className="w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-black text-white transition hover:bg-red-700" onClick={factoryReset}>Factory Reset</button>
        {message && <p className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-700">{message}</p>}
      </div>
    </section>
  );
}

function PinModal({ text, onClose, onSuccess }: { text: typeof ui.en; onClose: () => void; onSuccess: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const unlock = () => {
    if (pin === storage.adminPin()) {
      setError("");
      onSuccess();
      return;
    }
    setError("Incorrect PIN. Please try again.");
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4">
      <section className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-slate-200 bg-slate-50 px-6 py-5">
          <h2 className="flex items-center gap-2 text-xl font-black text-slate-950"><Shield className="text-teal-600" /> {text.pinTitle}</h2>
          <p className="mt-1 text-sm font-medium text-slate-500">{text.pinHelp}</p>
        </div>
        <div className="p-6">
        <input
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-semibold outline-none transition focus:border-teal-400 focus:bg-white focus:ring-4 focus:ring-teal-100"
          type="password"
          value={pin}
          onChange={(event) => {
            setPin(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") unlock();
          }}
          placeholder="Enter admin PIN"
        />
        {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button className="soft-button" onClick={onClose}>{text.cancel}</button>
          <button className="primary-button" onClick={unlock}>{text.unlock}</button>
        </div>
        </div>
      </section>
    </div>
  );
}

function AdminPanel({
  fishDb,
  setFishDb,
  sessions,
  onExport,
  onClose,
  text
}: {
  fishDb: FishSpecies[];
  setFishDb: (fish: FishSpecies[]) => void;
  sessions: SessionRecord[];
  onExport: () => void;
  onClose: () => void;
  text: typeof ui.en;
}) {
  const [adminTab, setAdminTab] = useState<AdminTab>("overview");
  const [editingFishId, setEditingFishId] = useState(fishDb[0]?.id || "");
  const users = storage.users();
  const criticalCount = sessions.filter((record) => overallStatus(record) === "critical").length;
  const selectedFish = fishDb.find((fish) => fish.id === editingFishId) || fishDb[0];

  const updateFishRange = (key: keyof WaterParams, index: 0 | 1, value: number) => {
    const next = fishDb.map((fish) => {
      if (fish.id !== selectedFish.id) return fish;
      const range = [...fish.ranges[key]] as [number, number];
      range[index] = value;
      return { ...fish, ranges: { ...fish.ranges, [key]: range } };
    });
    storage.saveFishOverrides(next);
    setFishDb(next);
  };

  const adminTabs: Array<{ id: AdminTab; label: string; icon: typeof Shield }> = [
    { id: "overview", label: text.overview, icon: BarChart3 },
    { id: "users", label: text.users, icon: User },
    { id: "fish", label: text.fishDatabase, icon: Fish },
    { id: "records", label: text.allRecords, icon: Database },
    { id: "settings", label: text.settings, icon: Settings }
  ];

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4">
      <section className="max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-slate-200 bg-slate-950 px-6 py-5 text-white">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-2xl font-black"><Shield /> {text.adminPanel}</h2>
              <p className="text-sm font-medium text-slate-300">PondSense of Us - System Management Console</p>
            </div>
            <button className="grid h-9 w-9 place-items-center rounded-full bg-white/15 text-xl font-black" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="max-h-[calc(92vh-88px)] overflow-auto p-6">
          <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
            {adminTabs.map((item) => (
              <button key={item.id} className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-black transition ${adminTab === item.id ? "bg-teal-100 text-teal-800 ring-1 ring-teal-200" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"}`} onClick={() => setAdminTab(item.id)}>
                <item.icon size={16} /> {item.label}
              </button>
            ))}
          </div>

        {adminTab === "overview" && (
          <div className="mt-6 grid gap-4 sm:grid-cols-4">
            <AdminStat label={text.totalUsers} value={users.length} />
            <AdminStat label={text.totalAnalyses} value={sessions.length} />
            <AdminStat label={text.averageScore} value={`${Math.round(sessions.reduce((sum, row) => sum + row.score, 0) / Math.max(1, sessions.length))}%`} />
            <AdminStat label={text.criticalCount} value={criticalCount} />
          </div>
        )}

        {adminTab === "users" && (
          <div className="mt-6 space-y-3">
            {users.map((user) => (
              <div key={user.id} className="rounded-2xl border border-slate-200 p-4">
                <p className="font-black text-slate-950">{user.fullName}</p>
                <p className="text-sm font-semibold text-slate-500">{user.phone}</p>
              </div>
            ))}
          </div>
        )}

        {adminTab === "fish" && selectedFish && (
          <div className="mt-6 grid gap-5 lg:grid-cols-[260px_1fr]">
            <div className="space-y-2">
              {fishDb.map((fish) => (
                <button key={fish.id} className={`w-full rounded-2xl border p-3 text-left text-sm font-black ${fish.id === selectedFish.id ? "border-teal-400 bg-teal-50 text-teal-800" : "border-slate-200 bg-white text-slate-700"}`} onClick={() => setEditingFishId(fish.id)}>
                  {fish.name}
                </button>
              ))}
            </div>
            <div className="rounded-2xl border border-slate-200 p-4">
              <h3 className="text-xl font-black text-slate-950">{selectedFish.name}</h3>
              <div className="mt-4 grid gap-3">
                {parameterMeta.map((meta) => (
                  <div key={meta.key} className="grid gap-3 rounded-2xl bg-slate-50 p-3 sm:grid-cols-[1fr_120px_120px] sm:items-center">
                    <span className="font-bold text-slate-700">{meta.label.en}</span>
                    <input className="rounded-xl border border-slate-200 px-3 py-2" type="number" step={meta.step} value={selectedFish.ranges[meta.key][0]} onChange={(event) => updateFishRange(meta.key, 0, Number(event.target.value))} />
                    <input className="rounded-xl border border-slate-200 px-3 py-2" type="number" step={meta.step} value={selectedFish.ranges[meta.key][1]} onChange={(event) => updateFishRange(meta.key, 1, Number(event.target.value))} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {adminTab === "records" && (
          <div className="mt-6">
            <button className="soft-button" onClick={onExport}><Download size={16} /> {text.exportCsv}</button>
            <div className="mt-4 space-y-2">
              {sessions.map((record) => (
                <div key={record.id} className="rounded-2xl border border-slate-200 p-4">
                  <p className="font-black text-slate-950">{record.timestamp}</p>
                  <p className="text-sm font-semibold text-slate-500">{record.bestFish} - {record.score}% - {overallStatus(record)}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {adminTab === "settings" && (
          <div className="mt-6 flex flex-wrap gap-3">
            <button className="soft-button" onClick={() => {
              const pin = prompt("New admin PIN");
              if (pin) storage.saveAdminPin(pin);
            }}>
              <Settings size={16} /> {text.changePin}
            </button>
            <button className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-red-700" onClick={() => {
              if (confirm("Reset all PondSense local data?")) {
                storage.resetAll();
                location.reload();
              }
            }}>
              {text.resetAll}
            </button>
          </div>
        )}
        </div>
      </section>
    </div>
  );
}

function AdminStat({ label, value }: { label: string; value: string | number }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-bold text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-black text-teal-700">{value}</p>
    </article>
  );
}
