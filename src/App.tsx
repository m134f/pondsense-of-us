import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { sensorTurbidityValue } from './lib/sensorDisplay';
import { SessionLoading } from './components/SessionLoading';
import { apiErrorMessage } from './lib/apiError';
import { OwnerLogin, OwnerPasswordChange, sessionOwner, type OwnerSession } from './components/OwnerAuthentication';
import { ProvisionOwner } from './components/ProvisionOwner';
import { AdminDeviceEnrollment, AdminDeviceSettings, verifyAdminDevice } from './components/AdminDeviceSecurity';
import { HarvestWorkspace } from './components/HarvestWorkspace';
import { AdminFishpenAssignments } from './components/AdminFishpenAssignments';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  Clock3,
  Database,
  Download,
  Droplets,
  Fish,
  History,
  Lock,
  LogOut,
  Menu,
  CalendarDays,
  Plus,
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
import { activeSpecies, fishDatabase } from "./data/fish";
import { analyzeWaterQuality, detectRisks, feedingAdvice } from "./lib/decisionEngine";
import { rankPartialFish } from "./lib/partialFish";
import { daysUntilHarvest, estimatedRemainingStock, harvestReminderDue, harvestStage, recentMortality, csvCell } from "./lib/harvest";
import { RecommendedActions, type WaterContext } from "./components/RecommendedActions";
import { HarvestReview } from "./components/HarvestReview";
import { FishpenSmsSettings, manualSmsPenKey } from "./components/FishpenSmsSettings";
import { WaterSmsLogs } from "./components/WaterSmsLogs";
import { ManualWaterForm } from "./components/ManualWaterForm";
import { PublicMonitoring } from './components/PublicMonitoring';
import { measuredStatus, parameterStatus } from './lib/measurementStatus';
import { clearLegacyBrowserCredentials, storage, type AppUser } from "./lib/storage";
import type { AlertItem, AlertLevel, FishScore, FishSpecies, SessionRecord, WaterParams } from "./types";

type AppTab = "analysis" | "history" | "harvest";
type AdminTab = "overview" | "users" | "fish" | "records" | "settings";
type Lang = "en" | "tl";
type AdminPath = "/admin/login" | "/admin/dashboard" | "/admin/users" | "/admin/logs" | "/admin/thresholds" | "/admin/settings";
type UserPath = "/login" | "/register" | "/dashboard" | "/history" | "/profile" | "/harvest";
type SmsResult = {
  configured: boolean;
  ok: boolean;
  message: string;
  messageId?: string;
};
type SensorTelemetry = {
  id: number;
  deviceId: number;
  deviceName: string;
  rawValue: number;
  voltage: number;
  turbidityNtu: number | null;
  temperatureC: number | null;
  ph: number | null;
  recordedAt: string;
  receivedAt?: string;
};

const SENSOR_LIVE_MS = 15_000;
const SENSOR_OFFLINE_MS = 60_000;

function sensorAgeMs(telemetry: SensorTelemetry | null, now: number): number {
  if (!telemetry) return Infinity;
  const sampledAt = new Date(telemetry.recordedAt).getTime();
  const receivedAt = new Date(telemetry.receivedAt || telemetry.recordedAt).getTime();
  if (!Number.isFinite(sampledAt) || !Number.isFinite(receivedAt)) return Infinity;
  return Math.max(0, now - Math.min(sampledAt, receivedAt));
}

function sensorConnectionState(telemetry: SensorTelemetry | null, now: number): "live" | "stale" | "offline" {
  const age = sensorAgeMs(telemetry, now);
  return age < SENSOR_LIVE_MS ? "live" : age < SENSOR_OFFLINE_MS ? "stale" : "offline";
}

function sensorMeasuredStatus(telemetry: SensorTelemetry): AlertLevel | 'partial' {
  return measuredStatus({ ph: telemetry.ph, temperature: telemetry.temperatureC, turbidity: telemetry.turbidityNtu });
}

function statusText(status: AlertLevel | 'partial', lang: Lang) {
  if (status === 'partial') return lang === 'tl' ? 'Walang sapat na sukat' : 'No measured status';
  if (status === 'safe') return lang === 'tl' ? 'Ligtas sa nasukat' : 'Safe measured values';
  if (status === 'warning') return lang === 'tl' ? 'Babala sa nasukat' : 'Warning in measured values';
  return lang === 'tl' ? 'Kritikal sa nasukat' : 'Critical measured value';
}

function shortStatusText(status: AlertLevel, lang: Lang) {
  if (status === 'safe') return lang === 'tl' ? 'Ligtas' : 'Safe';
  if (status === 'warning') return lang === 'tl' ? 'Babala' : 'Warning';
  return lang === 'tl' ? 'Kritikal' : 'Critical';
}
export type HarvestBatch = {
  notes?: string;
  sensorDeviceId?: number | null;
  waterContext?: WaterContext;
  id: number;
  species: string;
  stockingDate: string;
  stockedCount: number;
  targetHarvestDate: string;
  actualHarvestDate: string | null;
  harvestedKg: number | null;
  sellingPrice: number | null;
  fishpenName: string | null;
  targetWeightG: number | null;
  reminderSms: number | boolean;
  samples: Array<{ id: number; sampledAt: string; sampleSize: number; averageWeightG: number }>;
  mortalities: Array<{ id: number; mortalityDate: string; deadCount: number; notes: string | null }>;
  harvestEvents: Array<{ id: number; harvestType: "partial" | "complete"; harvestDate: string; fishCount: number | null; weightKg: number; pricePerKg: number | null }>;
};
type SensorAnalysisState = {
  status: "waiting" | "complete";
  secondsRemaining: number;
  turbidity: number;
  isEstimated: boolean;
  recordedAt: string;
};
type AdminUser = {
  accountStatus?: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED';
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

const SENSOR_ANALYSIS_DELAY_MS = 5_000;

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
    loginRegister: "Owner Login",
    logout: "Logout",
    analysis: "Analysis",
    history: "Session History",
    guide: "Farmer Guide",
    harvest: "Harvests",
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
    loginRegister: "Login ng May-ari",
    logout: "Logout",
    analysis: "Pagsusuri",
    history: "Kasaysayan ng Session",
    guide: "Gabay ng Mangingisda",
    harvest: "Mga Ani",
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
  mamali: "/fish/mamali.jpg",
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
  mamali: {
    en: {
      description: "Bighead carp that grows well in warm freshwater and feeds on natural plankton.",
      guide: "Maintain good oxygen and avoid heavy organic waste. Best for ponds with stable green water."
    },
    tl: {
      description: "Bighead carp na tumutubo nang maayos sa mainit na freshwater at kumakain ng natural na plankton.",
      guide: "Panatilihing maayos ang oxygen at iwasan ang sobrang organic waste. Mas bagay ito sa pond na stable ang berdeng tubig."
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
  return parameterStatus(key, value);
}

function overallStatus(params: { [K in keyof WaterParams]: number | null }): AlertLevel {
  const statuses = parameterMeta.filter(meta => params[meta.key] !== null).map((meta) => statusFor(meta.key, params[meta.key]!));
  if (statuses.includes("critical")) return "critical";
  if (statuses.includes("warning")) return "warning";
  return "safe";
}

function historyStatus(row: SessionRecord) {
  return measuredStatus(row.turbidityEstimated ? { ...row, turbidity: null } : row);
}

const farmerHistoryParameters = parameterMeta.filter(meta => meta.key !== "ammonia");

function isPartialSession(row: SessionRecord) {
  return farmerHistoryParameters.some(meta => row[meta.key] == null);
}

function levelClasses(level: AlertLevel) {
  if (level === "critical") return "border-red-200 bg-red-50 text-red-800";
  if (level === "warning") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-emerald-200 bg-emerald-50 text-emerald-800";
}

function badgeClasses(level: AlertLevel | FishScore["confidence"] | 'partial') {
  if (level === 'partial') return 'bg-slate-100 text-slate-700 ring-slate-200';
  if (level === "critical" || level === "Low") return "bg-red-100 text-red-700 ring-red-200";
  if (level === "warning" || level === "Medium") return "bg-amber-100 text-amber-700 ring-amber-200";
  return "bg-emerald-100 text-emerald-700 ring-emerald-200";
}

function confidenceLevel(score: number): FishScore["confidence"] {
  if (score >= 85) return "High";
  if (score >= 65) return "Medium";
  return "Low";
}

function measurementBadge(status: AlertLevel | 'partial') {
  const color = status === 'critical' ? 'bg-red-700 text-white' : status === 'warning' ? 'bg-amber-200 text-amber-950' : status === 'safe' ? 'bg-emerald-700 text-white' : 'bg-slate-200 text-slate-900';
  return `inline-flex items-center rounded-md px-3 py-1.5 text-sm font-bold capitalize ${color}`;
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

function recommendationLabel(score: number, lang: Lang) {
  if (score >= 85) return lang === "tl" ? "Inirerekomenda" : "Recommended";
  if (score >= 65) return lang === "tl" ? "May Pag-iingat" : "Use Caution";
  return lang === "tl" ? "Hindi Muna Angkop" : "Not Recommended";
}

function recommendationClasses(score: number) {
  if (score >= 85) return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (score >= 65) return "bg-amber-50 text-amber-700 ring-amber-200";
  return "bg-red-50 text-red-700 ring-red-200";
}

function normalizeFishDatabase(fish: FishSpecies[]) {
  const mamali = fishDatabase.find((species) => species.id === "mamali");
  const withoutTrout = fish.filter((species) => species.id !== "rainbow-trout" && species.name !== "Rainbow Trout");
  if (!mamali || withoutTrout.some((species) => species.id === "mamali")) return withoutTrout;
  const grassCarpIndex = withoutTrout.findIndex((species) => species.id === "grass-carp");
  const next = [...withoutTrout];
  next.splice(grassCarpIndex >= 0 ? grassCarpIndex + 1 : next.length, 0, mamali);
  return next;
}

function parameterMatchLevel(value: number): AlertLevel {
  if (value >= 85) return "safe";
  if (value >= 65) return "warning";
  return "critical";
}

function strongestFishReason(score: FishScore, lang: Lang) {
  const entries = parameterMeta
    .map((meta) => ({ meta, value: score.breakdown[meta.key] }))
    .sort((a, b) => b.value - a.value);
  const bestMatches = entries.filter((entry) => entry.value >= 85).length;
  const weakest = entries[entries.length - 1];
  const best = entries[0];

  if (score.score >= 85) {
    return lang === "tl"
      ? `Angkop dahil ${bestMatches} sa 5 parameter ang malapit sa ideal range.`
      : `Good match because ${bestMatches} of 5 parameters are near the ideal range.`;
  }
  if (score.score >= 65) {
    return lang === "tl"
      ? `Pwede pero bantayan ang ${weakest.meta.label.tl.toLowerCase()} bago mag-stock.`
      : `Possible option, but watch ${weakest.meta.label.en.toLowerCase()} before stocking.`;
  }
  return lang === "tl"
    ? `Hindi pa ideal dahil mahina ang match sa ${weakest.meta.label.tl.toLowerCase()}.`
    : `Not ideal yet because ${weakest.meta.label.en.toLowerCase()} has the weakest match.`;
}

function bestFishExplanation(score: FishScore, lang: Lang) {
  const safeCount = parameterMeta.filter((meta) => score.breakdown[meta.key] >= 85).length;
  const cautionCount = parameterMeta.filter((meta) => score.breakdown[meta.key] >= 65 && score.breakdown[meta.key] < 85).length;
  const problemCount = parameterMeta.length - safeCount - cautionCount;
  if (lang === "tl") {
    return `${safeCount} ligtas na match, ${cautionCount} bantayan, ${problemCount} kailangan pagbutihin.`;
  }
  return `${safeCount} strong matches, ${cautionCount} caution points, ${problemCount} needs improvement.`;
}

function formattedClock(date: Date) {
  return date.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" });
}

// Keep browser authentication first-party on the public Vercel site.
const apiBaseUrl = import.meta.env.PROD ? "" : (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

function apiUrl(path: string) {
  if (!apiBaseUrl || /^https?:\/\//.test(path)) return path;
  return `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function postJson<T>(url: string, body: unknown): Promise<{ data: T | null; error: string | null; status: number }> {
  try {
    const response = await fetch(apiUrl(url), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { data: null, error: apiErrorMessage(response.status, payload.message), status: response.status };
    return { data: payload as T, error: null, status: response.status };
  } catch {
    return { data: null, error: "Cannot reach the server. Please check your connection and try again.", status: 0 };
  }
}

async function apiJson<T>(url: string, options: RequestInit = {}): Promise<{ data: T | null; error: string | null; status: number }> {
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
    if (!response.ok) return { data: null, error: apiErrorMessage(response.status, payload.message), status: response.status };
    return { data: payload as T, error: null, status: response.status };
  } catch {
    return { data: null, error: "Cannot reach the server. Please check your connection and try again.", status: 0 };
  }
}

export default function App() {
  const savedUser = storage.currentUser();
  const [lang, setLangState] = useState<Lang>(storage.language());
  const [tab, setTab] = useState<AppTab>("analysis");
  const [loginDestination, setLoginDestination] = useState<UserPath>("/dashboard");
  const [params, setParams] = useState<WaterParams>(defaultParams);
  const [fishDb, setFishDb] = useState<FishSpecies[]>(fishDatabase.filter(fish => fish.id !== "mamali"));
  useEffect(() => {
    let active = true;
    const refresh = () => { void apiJson<{ profiles?: FishSpecies[] }>("/api/fish-species").then(({data}) => {
      if (active && Array.isArray(data?.profiles) && data.profiles.length) setFishDb(data.profiles);
    }); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, []);
  const [selectedFishId, setSelectedFishId] = useState("tilapia");
  const [sessions, setSessions] = useState<SessionRecord[]>(storage.sessions(savedUser));
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [path, setPath] = useState(window.location.pathname);
  const [authOpen, setAuthOpen] = useState(false);
  const [sms, setSms] = useState("");
  const [clock, setClock] = useState(new Date());
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const [sensorTelemetry, setSensorTelemetry] = useState<SensorTelemetry | null>(null);
  const [sensorTrend, setSensorTrend] = useState<SensorTelemetry[]>([]);
  const [sensorAnalysis, setSensorAnalysis] = useState<SensorAnalysisState | null>(null);
  const paramsRef = useRef(params);
  const sensorAutoTimerRef = useRef<number | null>(null);
  const sensorCountdownTimerRef = useRef<number | null>(null);
  const lastAutoReadingRef = useRef<string | null>(null);
  const text = ui[lang];

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 3_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (path.startsWith('/admin')) { setSessionLoading(false); return; }
    let active = true;
    setSessionLoading(true);
    setSessionError(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    clearLegacyBrowserCredentials();
    void apiJson<OwnerSession>("/api/session", { signal: controller.signal }).then((result) => {
      window.clearTimeout(timeout);
      if (!active) return;
      if (result.status === 0 || result.status >= 500) {
        setSessionError(lang === 'tl' ? 'Hindi pa sumasagot ang server. Subukan muli sa ilang sandali.' : 'The server has not responded. Please try again in a moment.');
        return;
      }
      if (result.data?.user.role === 'farmer') {
        const owner = sessionOwner(result.data); setCurrentUser(owner); storage.saveCurrentUser(owner);
      } else {
        storage.saveCurrentUser(null);
        setCurrentUser(null);
        setSensorTelemetry(null); setSensorTrend([]); setSessions([]);
      }
      setSessionLoading(false);
    });
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [path.startsWith('/admin'), sessionAttempt]);

  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

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
  }, [currentUser?.id, currentUser?.phone, path]);

  useEffect(() => {
    if (!sensorTelemetry || !currentUser) return;
    const record: SessionRecord = {
      id: `sensor-${sensorTelemetry.id}`,
      timestamp: new Date(sensorTelemetry.recordedAt).toLocaleString("en-PH"),
      inputMode: "sensor",
      turbidityEstimated: sensorTelemetry.turbidityNtu === null,
      ph: sensorTelemetry.ph,
      temperature: sensorTelemetry.temperatureC,
      dissolvedOxygen: null,
      turbidity: sensorTelemetry.turbidityNtu,
      ammonia: null,
      bestFish: "",
      score: null
    };
    setSessions(previous => {
      if (previous.some(item => item.id === record.id)) return previous;
      const next = [record, ...previous].slice(0, 100);
      storage.saveSessions(next, currentUser);
      return next;
    });
  }, [sensorTelemetry?.id, currentUser?.id]);

  useEffect(() => {
    let active = true;
    let latestTimer: number | undefined;
    let trendTimer: number | undefined;
    let latestController: AbortController | undefined;
    let trendController: AbortController | undefined;
    let failures = 0;

    if (!currentUser || currentUser.mustChangePassword || !currentUser.fishpenAssignment) {
      setSensorTelemetry(null);
      setSensorTrend([]);
      return () => { active = false; };
    }

    const loadLatest = async () => {
      if (!active) return;
      const startedAt = Date.now();
      latestController = new AbortController();
      const timeout = window.setTimeout(() => latestController?.abort(), 8_000);
      const result = await apiJson<{ telemetry: SensorTelemetry | null }>("/api/sensors/latest", { signal: latestController.signal });
      window.clearTimeout(timeout);
      latestController = undefined;
      if (!active) return;
      if (result.status === 401 || result.status === 403) { setCurrentUser(null); storage.saveCurrentUser(null); setSensorTelemetry(null); setSensorTrend([]); setSessions([]); return; }

      if (result.data) {
        failures = 0;
        setSensorTelemetry(result.data.telemetry);
        if (result.data.telemetry) {
          const latest = result.data.telemetry;
          setSensorTrend((previous) => previous.some((reading) => reading.id === latest.id)
            ? previous
            : [...previous, latest].sort((a, b) => a.id - b.id).slice(-60));
        }
      } else {
        failures += 1;
      }
      const delay = failures ? Math.min(30_000, 5_000 * 2 ** (failures - 1)) : Math.max(0, 5_000 - (Date.now() - startedAt));
      latestTimer = window.setTimeout(() => void loadLatest(), delay);
    };

    const loadTrend = async () => {
      if (!active) return;
      trendController = new AbortController();
      const timeout = window.setTimeout(() => trendController?.abort(), 8_000);
      const result = await apiJson<{ readings: SensorTelemetry[] }>("/api/sensors/trend", { signal: trendController.signal });
      window.clearTimeout(timeout);
      trendController = undefined;
      if (!active) return;
      if (result.data) {
        setSensorTrend((previous) => {
          const merged = new Map(result.data!.readings.map((reading) => [reading.id, reading]));
          for (const reading of previous) merged.set(reading.id, reading);
          return [...merged.values()].sort((a, b) => a.id - b.id).slice(-60);
        });
      }
      trendTimer = window.setTimeout(() => void loadTrend(), 30_000);
    };

    const reconnect = () => {
      if (!active || latestController) return;
      window.clearTimeout(latestTimer);
      failures = 0;
      void loadLatest();
    };

    void loadLatest();
    void loadTrend();
    window.addEventListener("online", reconnect);

    return () => {
      active = false;
      window.clearTimeout(latestTimer);
      window.clearTimeout(trendTimer);
      latestController?.abort();
      trendController?.abort();
      window.removeEventListener("online", reconnect);
    };
  }, [currentUser?.id, currentUser?.phone]);

  useEffect(() => {
    const syncPath = () => setPath(window.location.pathname);
    window.addEventListener("popstate", syncPath);
    return () => window.removeEventListener("popstate", syncPath);
  }, []);

  const navigate = useCallback((nextPath: string) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
  }, []);

  useEffect(() => {
    if (path === "/dashboard") setTab("analysis");
    if (path === "/history") setTab("history");
    if (path === "/guide") navigate("/dashboard");
    if (path === "/harvest") setTab("harvest");
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

  const runAnalysis = async (
    analysisParams: WaterParams = params,
    options: { save?: boolean; source?: "manual" | "sensor" } = {}
  ) => {
    const shouldSave = options.save ?? true;
    const analysisScores = analyzeWaterQuality(analysisParams, fishDb);
    const analysisAlerts = detectRisks(analysisParams);
    const analysisBest = analysisScores[0];
    if (!analysisBest) { setSms(lang === "tl" ? "Hindi pa handa ang mga saklaw ng isda." : "Fish thresholds are not available yet."); return; }
    const analysisStatus = overallStatus(analysisParams);

    setParams({ ...analysisParams });
    setHasAnalyzed(true);
    setSelectedFishId(analysisBest.fish.id);

    if (!shouldSave) return;

    const record: SessionRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toLocaleString("en-PH"),
      ...analysisParams,
      bestFish: analysisBest.fish.name,
      score: analysisBest.score
    };
    const next = [record, ...sessions].slice(0, 10);
    setSessions(next);
    storage.saveSessions(next, currentUser);
    const savedReading = await postJson<{ saved: boolean; readingId?: number; sms?: SmsResult }>("/api/readings", {
      userId: currentUser?.id,
      inputMode: options.source || "manual",
      fishpenId: currentUser ? Number(localStorage.getItem(manualSmsPenKey(currentUser.id))) || null : null,
      measurementsConfirmed: (options.source || "manual") === "manual",
      sampledAt: new Date().toISOString(),
      ph: analysisParams.ph,
      temperature: analysisParams.temperature,
      dissolvedOxygen: analysisParams.dissolvedOxygen,
      turbidity: analysisParams.turbidity,
      ammonia: analysisParams.ammonia,
      bestFish: analysisBest.fish.name,
      score: analysisBest.score,
      confidence: analysisBest.confidence,
      status: analysisStatus,
      alerts: analysisAlerts.map((alert) => ({
        level: alert.level,
        title: alert.title,
        message: alert.message
      })),
      smsSent: false
    });
    if (currentUser?.phone && analysisAlerts.some((alert) => alert.level === "warning" || alert.level === "critical")) {
      if (savedReading.data?.sms?.ok) {
        setSms(`Real iProgSMS water warning queued for ${currentUser?.phone || "guest user"}.`);
      } else if (savedReading.data?.sms?.configured === false) {
        setSms("Water warning saved. SMS notification is temporarily unavailable.");
      } else {
        setSms(savedReading.data?.sms?.message || "Water warning saved. SMS notification is temporarily unavailable.");
      }
    }
  };

  useEffect(() => {
    return () => {
      if (sensorAutoTimerRef.current !== null) window.clearTimeout(sensorAutoTimerRef.current);
      if (sensorCountdownTimerRef.current !== null) window.clearInterval(sensorCountdownTimerRef.current);
      sensorAutoTimerRef.current = null;
      sensorCountdownTimerRef.current = null;
    };
  }, [currentUser?.id]);

  useEffect(() => {
    if (!currentUser || !sensorTelemetry) {
      if (!currentUser) setSensorAnalysis(null);
      return;
    }
    const readingKey = `${sensorTelemetry.deviceName}:${sensorTelemetry.recordedAt}`;
    const turbidity = sensorTurbidityValue(sensorTelemetry);
    const isEstimated = sensorTelemetry.turbidityNtu === null;

    if (sensorAutoTimerRef.current !== null || lastAutoReadingRef.current === readingKey) return;

    const deadline = Date.now() + SENSOR_ANALYSIS_DELAY_MS;

    setSensorAnalysis({
      status: "waiting",
      secondsRemaining: Math.ceil(SENSOR_ANALYSIS_DELAY_MS / 1_000),
      turbidity,
      isEstimated,
      recordedAt: sensorTelemetry.recordedAt
    });

    sensorCountdownTimerRef.current = window.setInterval(() => {
      const secondsRemaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSensorAnalysis((current) => current?.status === "waiting" ? { ...current, secondsRemaining } : current);
    }, 500);

    sensorAutoTimerRef.current = window.setTimeout(() => {
      lastAutoReadingRef.current = readingKey;
      if (sensorCountdownTimerRef.current !== null) window.clearInterval(sensorCountdownTimerRef.current);
      sensorCountdownTimerRef.current = null;
      sensorAutoTimerRef.current = null;
      setSensorAnalysis({
        status: "complete",
        secondsRemaining: 0,
        turbidity,
        isEstimated,
        recordedAt: sensorTelemetry.recordedAt
      });
    }, SENSOR_ANALYSIS_DELAY_MS);
  }, [currentUser?.id, sensorTelemetry?.deviceName, sensorTelemetry?.recordedAt]);

  const testSms = async () => {
    if (!currentUser?.phone) {
      setSms("Log in using your administrator-provided owner account.");
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
      ["Date/Time", "pH", "Temp", "DO", "Turbidity", "Best Fish", "Score", "Measured Parameter Status", "Coverage"],
      ...sessions.map((row) => [
        row.timestamp,
        row.ph,
        row.temperature,
        row.dissolvedOxygen,
        row.turbidity,
        row.bestFish,
        row.score,
        historyStatus(row),
        isPartialSession(row) ? 'Partial - measured parameters only' : 'Complete'
      ])
    ];
    const csv = rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "pondsense-records.csv";
    a.click();
    URL.revokeObjectURL(url);
  };


  if (path.startsWith("/admin")) {
    return <AdminRouter path={path as AdminPath} navigate={navigate} text={text} />;
  }
  if (sessionLoading) return <SessionLoading error={sessionError} onRetry={() => setSessionAttempt(value => value + 1)} lang={lang} />;

  if (path === "/login" || path === "/register") {
    return (
      <AuthPage
        initialMode={path === "/register" ? "register" : "login"}
        text={text}
        navigate={navigate}
        onLogin={(user, message) => {
          setCurrentUser(user);
          setParams(defaultParams);
          setHasAnalyzed(false);
          setSensorTelemetry(null);
          setSensorTrend([]);
          setSensorAnalysis(null);
          setSessions(storage.sessions(user));
          setSms(message);
          navigate(user.role === "admin" ? "/admin/dashboard" : loginDestination);
          setLoginDestination("/dashboard");
        }}
      />
    );
  }

  if (currentUser?.mustChangePassword) return <OwnerPasswordChange onDone={() => window.location.assign('/dashboard')} onLogout={async () => { await postJson('/api/logout', {}); storage.saveCurrentUser(null); setCurrentUser(null); navigate('/login'); }} />;
  if (currentUser && !currentUser.fishpenAssignment) return <main className="mx-auto max-w-lg space-y-4 p-6"><h1 className="text-xl font-bold">Fishpen assignment needed</h1><p>No fishpen is assigned to your account. Contact your administrator. / Ipa-assign muna sa administrator ang iyong fishpen.</p><button className="soft-button" onClick={() => window.location.reload()}>Check again</button><button className="soft-button" onClick={async () => { await postJson('/api/logout', {}); storage.saveCurrentUser(null); setCurrentUser(null); navigate('/login'); }}>Logout</button></main>;

  if (!currentUser) return <OwnerLogin navigate={navigate} onLogin={(user, message) => { setCurrentUser(user); storage.saveCurrentUser(user); setSms(message); navigate('/dashboard'); }} />;
  if (path === "/profile") {
    return <ProfilePage currentUser={currentUser} navigate={navigate} />;
  }

  return (
    <div className="farmer-shell min-h-screen bg-slate-100">
      {sms && (
        <button
          className="fixed inset-x-3 bottom-4 z-50 rounded-2xl bg-slate-950 px-4 py-3 text-left text-sm font-medium text-white shadow-2xl sm:inset-x-auto sm:right-5 sm:max-w-sm sm:px-5 sm:py-4"
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
        activeTab={tab}
        onTabChange={(nextTab) => {
          setTab(nextTab);
          navigate(nextTab === "history" ? "/history" : nextTab === "harvest" ? "/harvest" : "/dashboard");
        }}
        onHome={() => navigate("/dashboard")}
        onProfile={() => navigate("/profile")}
        onAuth={() => navigate("/login")}
        onLogout={async () => {
          await apiJson("/api/logout", { method: "POST", body: "{}" });
          storage.saveCurrentUser(null);
          setCurrentUser(null);
          setParams(defaultParams);
          setHasAnalyzed(false);
          setSensorTelemetry(null);
          setSensorTrend([]);
          setSensorAnalysis(null);
          setSessions(storage.sessions(null));
          navigate("/login");
        }}
        text={text}
      />

      <Tabs active={tab} onChange={(nextTab) => {
        setTab(nextTab);
        navigate(nextTab === "history" ? "/history" : nextTab === "harvest" ? "/harvest" : "/dashboard");
      }} text={text} />

      {tab === "analysis" && (
        <AnalysisPage
          key={currentUser?.id || 'guest'}
          ownerId={currentUser?.id}
          lang={lang}
          params={params}
          setParams={setParams}
          sensorTelemetry={sensorTelemetry}
          sensorTrend={sensorTrend}
          sensorAnalysis={sensorAnalysis}
          now={clock.getTime()}
          sessions={sessions}
          fishDb={fishDb}
          scores={scores}
          alerts={alerts}
          selectedScore={selectedScore}
          selectedRank={selectedRank}
          best={best}
          currentStatus={currentStatus}
          hasAnalyzed={hasAnalyzed}
          onAnalyze={runAnalysis}
          onManualSaved={record => { setSessions(previous => { const next = [record, ...previous].slice(0, 10); storage.saveSessions(next, currentUser); return next; }); }}
          onTestSms={testSms}
          onSelectFish={setSelectedFishId}
          text={text}
        />
      )}

      {tab === "history" && (
        <HistoryPage sessions={sessions} onExport={exportCsv} text={text} lang={lang} />
      )}

      {tab === "harvest" && <HarvestPage currentUser={currentUser} lang={lang} fishDb={fishDb} navigate={navigate} />}

      {authOpen && (
        <AuthModal
          text={text}
          onClose={() => setAuthOpen(false)}
          onLogin={(user, message) => {
            setCurrentUser(user);
            setParams(defaultParams);
            setHasAnalyzed(false);
            setSensorTelemetry(null);
            setSensorTrend([]);
            setSensorAnalysis(null);
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
  activeTab,
  onTabChange,
  onHome,
  onProfile,
  onAuth,
  onLogout,
  text
}: {
  lang: Lang;
  setLang: (lang: Lang) => void;
  clock: Date;
  currentUser: AppUser | null;
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  onHome: () => void;
  onProfile: () => void;
  onAuth: () => void;
  onLogout: () => void;
  text: typeof ui.en;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileTabs: Array<{ id: AppTab; label: string; icon: typeof BarChart3 }> = [
    { id: "analysis", label: text.analysis, icon: BarChart3 },
    { id: "history", label: text.history, icon: History },
    { id: "harvest", label: text.harvest, icon: CalendarDays }
  ];

  const chooseTab = (nextTab: AppTab) => {
    onTabChange(nextTab);
    setMenuOpen(false);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(document.querySelectorAll<HTMLElement>('.farmer-menu button, .farmer-menu a, .farmer-menu input, .farmer-menu select')).filter(element => !element.hasAttribute('disabled'));
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
      previousFocus?.focus();
    };
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-3 px-3 py-3 sm:px-6 sm:py-4 lg:flex-row lg:items-center lg:justify-between">
        <button className="flex min-w-0 items-center gap-2 text-left sm:gap-3" onClick={onHome} title="PondSense dashboard">
          <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-white ring-1 ring-teal-100 sm:h-12 sm:w-12 sm:rounded-2xl">
            <img src="/logofishpond.png?v=logo-20260612" alt="PondSense of Us logo" className="h-full w-full object-cover" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-base font-black leading-tight text-slate-950 sm:text-lg">PondSense of Us</span>
            <span className="block truncate text-xs text-slate-500 sm:text-sm">{text.subtitle}</span>
          </span>
        </button>

        <button
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-slate-50 md:hidden"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label="Open menu"
          aria-expanded={menuOpen}
        >
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>

        <div className="hidden items-center gap-2 md:flex md:flex-wrap">
          <div className="flex rounded-xl bg-slate-100 p-1">
            {(["en", "tl"] as const).map((item) => (
              <button
                key={item}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-black transition ${lang === item ? "bg-teal-600 text-white shadow-sm" : "text-slate-500 hover:text-teal-700"}`}
                onClick={() => setLang(item)}
              >
                {item.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-600">
            <Clock3 size={16} /> {formattedClock(clock)}
          </span>
          <button className="inline-flex min-w-0 items-center justify-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm font-bold text-amber-700 ring-1 ring-amber-100 hover:bg-amber-100" onClick={currentUser ? onProfile : onAuth} title={currentUser ? "Profile and ESP32 pairing" : "Login"}>
            <User size={16} className="shrink-0" /> <span className="truncate">{currentUser ? currentUser.fullName : text.guest}</span>
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
      {menuOpen && createPortal(
        <>
          <button
            className="fixed inset-0 z-50 bg-slate-950/35 backdrop-blur-[2px] md:hidden"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
          <div className="farmer-menu fixed inset-y-0 right-0 z-[60] w-full max-w-sm overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-xl md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-2xl bg-white ring-1 ring-teal-100">
                  <img src="/logofishpond.png?v=logo-20260612" alt="PondSense of Us logo" className="h-full w-full object-cover" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-base font-black leading-tight text-slate-950">PondSense of Us</p>
                  <p className="truncate text-xs font-semibold text-slate-500">{text.subtitle}</p>
                </div>
              </div>
              <button
                className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-600"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
              >
                <X size={19} />
              </button>
            </div>

            <div className="grid gap-2">
              {mobileTabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={`flex min-h-12 items-center gap-3 rounded-lg border px-3 text-left text-base font-semibold transition ${
                    activeTab === id
                      ? "border-teal-200 bg-teal-50 text-teal-800 shadow-sm"
                      : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                  }`}
                  onClick={() => chooseTab(id)}
                >
                  <span className={`grid h-9 w-9 place-items-center rounded-full ${activeTab === id ? "bg-white text-teal-600" : "bg-white text-slate-400"}`}>
                    <Icon size={18} />
                  </span>
                  <span className="leading-tight">{label}</span>
                </button>
              ))}
            </div>

            <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="flex rounded-xl bg-white p-1 ring-1 ring-slate-200">
                  {(["en", "tl"] as const).map((item) => (
                    <button
                      key={item}
                      className={`flex-1 rounded-lg px-3 py-2 text-xs font-black transition ${lang === item ? "bg-teal-600 text-white shadow-sm" : "text-slate-500 hover:text-teal-700"}`}
                      onClick={() => setLang(item)}
                    >
                      {item.toUpperCase()}
                    </button>
                  ))}
                </div>
                <span className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-bold text-slate-600 ring-1 ring-slate-200">
                  <Clock3 size={16} /> {formattedClock(clock)}
                </span>
              </div>
              <button className="mt-2 inline-flex w-full min-w-0 items-center justify-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm font-black text-amber-700 ring-1 ring-amber-100" onClick={() => { currentUser ? onProfile() : onAuth(); setMenuOpen(false); }}>
                <User size={16} className="shrink-0" /> <span className="truncate">{currentUser ? currentUser.fullName : text.guest}</span>
              </button>
            </div>

            <div className="mt-3 grid gap-2">
              {currentUser ? (
                <button className="soft-button min-h-12 rounded-2xl bg-white" onClick={() => { onLogout(); setMenuOpen(false); }}>
                  <LogOut size={16} /> {text.logout}
                </button>
              ) : (
                <button className="primary-button col-span-2 min-h-12 rounded-2xl py-2" onClick={() => { onAuth(); setMenuOpen(false); }}>
                  <Lock size={16} /> {text.loginRegister}
                </button>
              )}
            </div>
          </div>
        </>
        ,
        document.body
      )}
    </header>
  );
}

function Tabs({ active, onChange, text }: { active: AppTab; onChange: (tab: AppTab) => void; text: typeof ui.en }) {
  const tabs: Array<{ id: AppTab; label: string; icon: typeof BarChart3 }> = [
    { id: "analysis", label: text.analysis, icon: BarChart3 },
    { id: "history", label: text.history, icon: History },
    { id: "harvest", label: text.harvest, icon: CalendarDays }
  ];

  return (
    <nav className="mx-auto hidden max-w-[1500px] gap-2 overflow-x-auto px-3 py-3 sm:px-6 sm:py-4 md:flex">
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-black transition sm:gap-2 sm:px-4 sm:py-2.5 sm:text-sm ${
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

function ConnectEsp32({ lang, telemetry, now }: { lang: Lang; telemetry: SensorTelemetry | null; now: number }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [devices, setDevices] = useState<Array<{ id: number; deviceName: string; lastReadingAt: string | null }>>([]);
  const connect = async () => {
    setBusy(true);
    setMessage("");
    const result = await apiJson<{ devices: typeof devices }>("/api/sensors/devices");
    setBusy(false);
    setChecked(true);
    if (result.error) return setMessage(result.error);
    setDevices(result.data?.devices || []);
    if (!result.data?.devices.length) setMessage(lang === "tl" ? "Wala pang ESP32 na naka-assign sa account mo. Ipa-assign ito sa administrator." : "No ESP32 is assigned to your account yet. Ask your administrator to assign it.");
  };
  useEffect(() => { void connect(); }, []);
  const live = sensorConnectionState(telemetry, now) === "live";
  return <section className="card p-4 sm:p-5">
    <div><h2 className="text-base font-black text-slate-950">{lang === 'tl' ? 'Kalagayan ng sensor' : 'Sensor status'}</h2><p className="text-xs text-slate-600">{busy ? (lang === 'tl' ? 'Sinusuri...' : 'Checking...') : (lang === 'tl' ? 'Mga sensor ng account mo' : "Your account's sensors")}</p></div>
    {checked && <div className="mt-3 border-t border-slate-100 pt-3">
      {devices.length > 0 && <><p className="mb-2 text-xs font-semibold text-slate-500">{devices.length} {lang === "tl" ? "naka-assign na ESP32" : "assigned ESP32 device(s)"}</p><ul className="space-y-2 text-sm text-slate-700">{devices.map((device) => <li key={device.id} className="flex items-center justify-between gap-2"><span className="font-semibold">{device.deviceName} <span className="text-slate-500">#{device.id}</span></span><span className={`rounded-full px-2 py-1 text-xs font-bold ${live && telemetry?.deviceId === device.id ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{live && telemetry?.deviceId === device.id ? "Live" : (lang === "tl" ? "Walang bagong reading" : "No recent reading")}</span></li>)}</ul></>}
      {message && <p className="text-sm font-semibold text-slate-700" role="status">{message}</p>}
    </div>}
  </section>;
}

function AnalysisPage({
  onManualSaved,
  ownerId,
  lang,
  params,
  setParams,
  sensorTelemetry,
  sensorTrend,
  sensorAnalysis,
  now,
  sessions,
  fishDb,
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
  onManualSaved: (record: SessionRecord) => void;
  ownerId?: string;
  lang: Lang;
  params: WaterParams;
  setParams: (params: WaterParams) => void;
  sensorTelemetry: SensorTelemetry | null;
  sensorTrend: SensorTelemetry[];
  sensorAnalysis: SensorAnalysisState | null;
  now: number;
  sessions: SessionRecord[];
  fishDb: FishSpecies[];
  scores: FishScore[];
  alerts: AlertItem[];
  selectedScore: FishScore;
  selectedRank: number;
  best: FishScore;
  currentStatus: AlertLevel;
  hasAnalyzed: boolean;
  onAnalyze: (values: WaterParams) => void | Promise<void>;
  onTestSms: () => void;
  onSelectFish: (id: string) => void;
  text: typeof ui.en;
}) {
  const [showParameterDetails, setShowParameterDetails] = useState(false);
  const [showAllActions, setShowAllActions] = useState(false);
  const sensorFresh = sensorConnectionState(sensorTelemetry, now) === "live";
  const [mode, setMode] = useState<"monitoring" | "manual">("monitoring");
  const showManual = mode === "manual";
  const [partialManual, setPartialManual] = useState<Partial<WaterParams> | null>(null);
  const showManualResults = hasAnalyzed && scores.length > 0 && showManual && !partialManual;
  const submitManual = async (values: Partial<WaterParams>) => {
    if (Object.keys(values).length === 5) {
      await onAnalyze(values as WaterParams);
      setPartialManual(null);
    } else {
      const result = await postJson<{ saved: boolean; session: SessionRecord }>('/api/readings', { ...values, partialManual: true });
      if (result.error || !result.data?.saved) throw new Error(result.error || 'Manual test was not saved.');
      onManualSaved(result.data.session);
      setPartialManual({ ...values });
    }
  };

  return (
    <main className={`farmer-analysis ${showManual ? "manual-mode" : "monitoring-mode"} mx-auto grid max-w-[1500px] grid-cols-1 gap-5 px-4 pb-8 sm:px-6`}>
      <div className="analysis-heading flex flex-wrap items-center justify-between gap-4 py-4">
        <div><h1 className="text-2xl font-bold">{lang === "tl" ? "Kalagayan ng tubig" : "Water monitoring"}</h1><p className="mt-1 text-sm text-slate-600">{lang === "tl" ? "Mga sukat at susunod na hakbang para sa iyong palaisdaan." : "Measurements and next steps for your fishpen."}</p></div>
        <div className="flex rounded-lg border border-slate-300 bg-white p-1" aria-label="Analysis mode">
          {(["monitoring", "manual"] as const).map(value => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)} className={`min-h-11 rounded-md px-4 text-sm font-semibold ${mode === value ? "bg-teal-700 text-white" : "text-slate-600"}`}>{value === "monitoring" ? (lang === "tl" ? "Mga sensor" : "Monitoring") : (lang === "tl" ? "Manu-mano" : "Manual test")}</button>)}
        </div>
      </div>
      <aside className="analysis-inputs space-y-5">
        {showManual ? <ManualWaterForm lang={lang} fish={fishDb} onAnalyze={submitManual} /> : <WaterParametersPanel
          lang={lang}
          params={params}
          setParams={setParams}
          sensorTelemetry={sensorTelemetry}
          sensorFresh={sensorFresh}
          showManual={false}
          onAnalyze={() => {}}
          text={text}
        />}
        <details className="card p-4"><summary className="cursor-pointer py-2 font-semibold">{lang === "tl" ? "Mga setting ng device at SMS" : "Device & SMS settings"}</summary><div className="mt-4 space-y-4"><ConnectEsp32 lang={lang} telemetry={sensorTelemetry} now={now} />{ownerId && <FishpenSmsSettings key={ownerId} ownerId={ownerId} lang={lang} />}</div></details>
        {showManualResults && (
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

      <section className="analysis-results min-w-0 space-y-5">
        {!showManual && (sensorTelemetry ? <LiveSensorTrends telemetry={sensorTelemetry} readings={sensorTrend} lang={lang} now={now} /> : <section className="card p-5"><h2 className="text-lg font-bold">{lang === "tl" ? "Wala pang sukat ng tubig" : "No water measurement yet"}</h2><p className="mt-2 text-base text-slate-600">{lang === "tl" ? "Hindi pa matutukoy ang kalagayan ng tubig. Suriin ang sensor o gumamit ng manu-manong pagsusuri." : "Water condition is not yet known. Check your sensor or enter a manual water test."}</p></section>)}
        {ownerId && !showManual && <RecommendedActions lang={lang} refreshKey={`${sensorTelemetry?.id || 0}:${sessions[0]?.id || ""}`} />}
        {showManual && partialManual && <section className="card space-y-4 p-5" aria-live="polite">
          <h2 className="text-lg font-bold">{lang === "tl" ? "Bahagyang manu-manong pagsusuri" : "Partial manual assessment"}</h2>
          <p className="text-sm text-amber-800">{lang === "tl" ? "Batay lamang sa mga isinumiteng sukat. Hindi nito kinukumpirma na ligtas ang tubig." : "Based only on submitted measurements. This does not confirm overall water safety."}</p>
          {parameterMeta.filter(meta => partialManual[meta.key] !== undefined).map(meta => {
            const value = partialManual[meta.key]!;
            const status = statusFor(meta.key, value);
            return <div key={meta.key} className={`rounded-lg border p-4 ${levelClasses(status)}`}>
              <h3 className="font-semibold">{meta.key === "ph" ? "pH" : meta.key === "dissolvedOxygen" ? "Dissolved oxygen" : meta.key}</h3>
              <span className={measurementBadge(status)}>{lang === 'tl' ? (status === 'safe' ? 'Ligtas sa saklaw' : status === 'warning' ? 'Babala' : 'Kritikal') : status === 'safe' ? 'Safe' : status === 'warning' ? 'Warning' : 'Critical'}</span>
              <p className="text-xl font-bold">{value} {meta.key === "temperature" ? "°C" : meta.key === "turbidity" ? "NTU" : meta.key === "ph" ? "" : "mg/L"}</p>
              <p>{status === "safe" ? (lang === "tl" ? "Pasok sa saklaw para sa sukat na ito" : "Within range for this parameter") : localize(status === "critical" ? "Critical Water Condition" : "Water Quality Warning", lang)}</p>
              {status !== "safe" && <p className="mt-2 text-sm">{lang === "tl" ? "Ulitin ang pagsukat, obserbahan ang isda, at kumonsulta sa BFAR/LGU kung may senyales ng stress." : "Recheck the measurement, observe the fish, and consult BFAR/LGU if fish show distress."}</p>}
            </div>;
          })}
          <p className="text-sm text-slate-600">{lang === "tl" ? "Nai-save sa Session History. Hindi nasukat ang mga blangkong field. Walang SMS na ipinadala para sa bahagyang pagsusuring ito." : "Saved to Session History. Blank fields are unmeasured. No SMS was sent for this partial assessment."}</p>
        </section>}
        {!showManual || partialManual ? null : showManualResults ? (
          <>
            <p className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm font-semibold text-sky-900">{lang === "tl" ? "Manu-manong analysis ito, hindi galing sa ESP32." : "Manual analysis only. These values did not come from the ESP32."}</p>
            <AlertBanner alert={alerts[0]} lang={lang} />
            <SummaryBanner status={currentStatus} lang={lang} />
            <WhatToDoNow alerts={alerts} status={currentStatus} lang={lang} />
            <QuickStatusCards lang={lang} params={params} />
            {sessions.length > 0 && <DashboardTrends params={params} sessions={sessions} text={text} />}
            <BestMatchCard selectedScore={selectedScore} selectedRank={selectedRank} best={best} lang={lang} text={text} />
            <CollapsiblePanel
              title={lang === "tl" ? "Detalyadong Parameter Analysis" : "Detailed Parameter Analysis"}
              description={
                lang === "tl"
                  ? "Buksan ito kung gusto mong makita ang score ng bawat water parameter."
                  : "Open this only when you need the full score explanation for each water parameter."
              }
              open={showParameterDetails}
              onToggle={() => setShowParameterDetails((value) => !value)}
            >
              <ParameterAnalysis lang={lang} selectedScore={selectedScore} />
            </CollapsiblePanel>
            <CollapsiblePanel
              title={lang === "tl" ? "Lahat ng Corrective Actions" : "All Corrective Actions"}
              description={
                lang === "tl"
                  ? "Nasa taas na ang pinakamahalagang gagawin. Buksan ito para makita ang lahat ng hakbang."
                  : "The most urgent steps are already shown above. Open this to view the complete action list."
              }
              open={showAllActions}
              onToggle={() => setShowAllActions((value) => !value)}
            >
              <CorrectiveActions alerts={alerts} status={currentStatus} lang={lang} text={text} />
            </CollapsiblePanel>
          </>
        ) : (
          <section className="card p-6">
            <h2 className="text-lg font-bold text-slate-950">{lang === "tl" ? "Wala pang resulta ng pagsusuri" : "No manual test submitted"}</h2>
            <p className="mt-2 text-base text-slate-600">{lang === "tl" ? "Ilagay ang aktuwal na sukat mula sa iyong water test." : "Enter your measured water test values to see an analysis."}</p>
          </section>
        )}
      </section>

      {!showManual && sensorTelemetry ? (
        <aside className="card h-fit space-y-3 p-5">
          <h2 className="font-black">{lang === "tl" ? "Paunang paghahambing ng isda" : "Preliminary fish comparison"}</h2>
          <div className="flex flex-wrap items-center gap-2"><span className={`rounded-md px-2 py-1 text-xs font-bold ${badgeClasses(sensorMeasuredStatus(sensorTelemetry))}`}>{statusText(sensorMeasuredStatus(sensorTelemetry), lang)}</span><span className="text-xs text-slate-600">{lang === 'tl' ? 'Bahagyang pagsusuri; walang DO reading at hindi kasama ang tantiya sa turbidity.' : 'Partial assessment; DO is missing and estimated turbidity is excluded.'}</span></div>
          {!sensorFresh && <p className="rounded-md bg-amber-50 p-3 text-sm font-semibold text-amber-900">{lang === 'tl' ? 'Batay sa huling sukat, hindi live. Kumuha ng bagong sukat bago magpasya.' : 'Based on the last reading, not live. Obtain fresh measurements before making decisions.'}</p>}
          {(() => {
            const readings = { ph: sensorTelemetry.ph, temperature: sensorTelemetry.temperatureC, turbidity: null };
            const measured = Object.entries(readings).filter(([, value]) => value !== null && Number.isFinite(value));
            const ranked = rankPartialFish(fishDb.filter(fish => activeSpecies.some(species => species.id === fish.id)), readings);
            if (!measured.length) return <p className="text-sm text-slate-600">{lang === "tl" ? "Wala pang beripikadong sukat para ihambing ang isda." : "No verified measurements yet for fish comparison."}</p>;
            return <>
              {sensorTelemetry.turbidityNtu !== null && <p className="text-sm text-slate-600">{lang === 'tl' ? 'Hindi kasama ang tantyang turbidity sa paghahambing; kailangan muna ng calibration.' : 'Estimated turbidity is excluded from comparison until calibrated.'}</p>}
              <p className="text-sm text-amber-800">{lang === "tl" ? `Batay lamang sa ${measured.length} sukat. Hindi pa kumpirmadong angkop ang isda hangga't kulang ang ibang sukat.` : `Based on ${measured.length} measured parameter${measured.length === 1 ? "" : "s"} only. This is not a full suitability recommendation.`}</p>
              <p className="text-xs text-slate-600">{lang === 'tl' ? 'Ayos: mas maraming sukat na pasok sa saklaw, saka mas malapit sa saklaw ang mga labas na sukat.' : 'Order: more measurements within the species range, then closer to range for values outside it.'}</p>
              {ranked.length && ranked.every(item => item.matches.length === 0) && <p className="rounded-md bg-red-50 p-2 text-sm font-semibold text-red-800">{lang === "tl" ? "Walang isdang nasa saklaw ng kasalukuyang sukat. Ang nasa itaas ay pinakamalapit lamang." : "No fish is within the measured range. The top fish is only the closest match."}</p>}
              {ranked.map((item, index) => {
                const previous = ranked[index - 1];
                const next = ranked[index + 1];
                const tied = (other: typeof item | undefined) => Boolean(other && other.matches.length === item.matches.length && Math.abs(other.distance - item.distance) < 0.000001);
                const reason = index === 0
                  ? tied(next) ? (lang === 'tl' ? 'Tabla sa nasukat; pangalan lamang ang nag-ayos ng puwesto.' : 'Tied on measured evidence; listed alphabetically.')
                    : item.matches.length === measured.length ? (lang === 'tl' ? 'Pinakamaraming pasok sa nasukat na saklaw; hindi pa ito kumpletong rekomendasyon.' : 'Most measured values in range; still not a full recommendation.')
                    : (lang === 'tl' ? 'Pinakamalapit sa saklaw sa mga nasukat, pero hindi pa kumpirmadong angkop.' : 'Closest on measured values, but not confirmed suitable.')
                  : item.matches.length < previous.matches.length ? (lang === 'tl' ? 'Mas kaunting nasukat ang pasok kaysa sa nasa itaas.' : 'Fewer measured values are in range than the fish above.')
                    : tied(previous) ? (lang === 'tl' ? 'Tabla sa nasa itaas; pangalan lamang ang nag-ayos ng puwesto.' : 'Tied with the fish above; listed alphabetically.')
                    : (lang === 'tl' ? 'Pareho ang bilang na pasok, pero mas malayo sa saklaw ang labas na sukat.' : 'Same number in range, but the out-of-range value is farther from its species range.');
                return <section key={item.fish.id} className="border-t border-slate-200 py-3">
                  <div className="flex items-center gap-2"><span className="text-sm font-bold text-slate-500">#{index + 1}</span><img src={fishImageSrc(item.fish.id)} alt="" className="h-10 w-10 rounded-md object-cover" /><strong>{item.fish.name}</strong></div>
                  <p className="mt-2 text-xs font-semibold text-slate-700">{lang === 'tl' ? `${item.matches.length} sa ${measured.length} nasukat ang pasok` : `${item.matches.length} of ${measured.length} measured values in range`}</p>
                  {item.checks.map(check => <p key={check.key} className="mt-1 text-xs text-slate-600">
                    {check.key === 'ph' ? 'pH' : check.key === 'temperature' ? (lang === 'tl' ? 'Temperatura' : 'Temperature') : (lang === 'tl' ? 'Labo' : 'Turbidity')} {check.value}{check.key === 'temperature' ? ' °C' : check.key === 'turbidity' ? ' NTU' : ''}: {check.result === 'unknown' ? (lang === 'tl' ? 'walang beripikadong saklaw' : 'no verified range') : <><span className={check.result === 'within' ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-800'}>{check.result === 'within' ? (lang === 'tl' ? 'pasok' : 'within') : check.result === 'below' ? (lang === 'tl' ? 'mas mababa' : 'below') : (lang === 'tl' ? 'mas mataas' : 'above')}</span> ({check.min}–{check.max}{check.key === 'temperature' ? ' °C' : check.key === 'turbidity' ? ' NTU' : ''})</>}
                  </p>)}
                  <p className="mt-2 text-xs leading-relaxed text-slate-700">{reason}</p>
                </section>;
              })}
              {activeSpecies.filter(species => !fishDb.some(fish => fish.id === species.id)).map(species => <p key={species.id} className="text-xs text-slate-500">{species.name}: {lang === "tl" ? "kailangan ng kumpletong saklaw sa database" : "complete database thresholds needed"}</p>)}
            </>;
          })()}
        </aside>
      ) : showManual && partialManual ? (
        <aside className="card h-fit space-y-4 p-5">
          <h2 className="text-lg font-bold">{lang === "tl" ? "Paunang paghahambing ng isda" : "Preliminary fish comparison"}</h2>
          <p className="text-sm text-amber-800">{lang === "tl" ? "Batay lamang sa nasukat; hindi kumpletong rekomendasyon sa pag-aalaga." : "Measured parameters only; not a complete stocking recommendation."}</p>
          {fishDb.filter(fish => activeSpecies.some(species => species.id === fish.id)).map(fish => <section key={fish.id} className="border-t border-slate-200 pt-3">
            <div className="flex items-center gap-3"><img src={fishImageSrc(fish.id)} alt="" className="h-12 w-12 rounded-md object-cover" /><h3 className="font-bold">{fish.name}</h3></div>
            {Object.entries(partialManual).map(([key, value]) => {
              const range = fish.ranges[key as keyof WaterParams];
              const matches = value >= range[0] && value <= range[1];
              return <p key={key} className="mt-2 text-sm">{key}: {matches ? (lang === "tl" ? "Pasok sa saklaw" : "Within range") : (lang === "tl" ? "Labas sa saklaw" : "Outside range")} ({range.join(" - ")})</p>;
            })}
          </section>)}
        </aside>
      ) : showManual && showManualResults ? (
        <>
          <FishRankingPanel scores={scores} selectedId={selectedScore.fish.id} onSelectFish={onSelectFish} lang={lang} text={text} />
          <p className="text-sm">Mamali: {lang === "tl" ? "hinihintay ang beripikadong saklaw" : "threshold validation pending"}.</p>
        </>
      ) : (
        <aside className="card h-fit p-6">
          <h2 className="flex items-center gap-2 text-lg font-black text-slate-950">
            <Fish className="text-teal-600" size={21} /> Fish Suitability Ranking
          </h2>
          <p className="mt-3 text-sm font-medium leading-6 text-slate-600">
            {sensorFresh
              ? "Fish comparison is paused until the turbidity sensor is submerged and calibrated. A signal in air is not a valid water measurement."
              : "No fish ranking yet. Enter at least one measured value and run a manual analysis."}
          </p>
        </aside>
      )}
    </main>
  );
}

function AnalysisEmptyState({ sensorAnalysis, hasSensor }: { sensorAnalysis: SensorAnalysisState | null; hasSensor: boolean }) {
  return (
    <section className="card flex min-h-[360px] flex-col items-center justify-center p-6 text-center sm:min-h-[420px] sm:p-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-teal-50 text-teal-700 ring-1 ring-teal-100">
        <BarChart3 size={30} />
      </div>
      <h2 className="mt-5 text-2xl font-black text-slate-950">
        {hasSensor ? "Full water analysis not yet available" : "No water quality analysis yet"}
      </h2>
      {sensorAnalysis?.status === "waiting" ? (
        <p className="mt-3 max-w-xl text-sm font-medium leading-6 text-slate-600">
          Turbidity is being read live. Waiting {sensorAnalysis.secondsRemaining} seconds for the first sensor-only result. The other four parameters are not measured by this ESP32.
        </p>
      ) : (
        <p className="mt-3 max-w-xl text-sm font-medium leading-6 text-slate-600">
          {hasSensor ? "Only turbidity is connected. The live trend above shows that sensor; pH, temperature, oxygen, and ammonia have no sensor readings yet. For a full decision-support analysis, enter measured values for all five parameters and press Analyze." : "Enter measured pH, temperature, dissolved oxygen, turbidity, and ammonia values, then press Analyze Water Quality."}
        </p>
      )}
    </section>
  );
}

function LiveSensorTrends({ telemetry, readings, lang, now }: { telemetry: SensorTelemetry; readings: SensorTelemetry[]; lang: Lang; now: number }) {
  const value = sensorTurbidityValue(telemetry);
  const level = statusFor("turbidity", value);
  const calibrated = telemetry.turbidityNtu !== null;
  const measured = sensorMeasuredStatus(telemetry);
  const chart = readings.map((reading) => ({
    time: new Date(reading.recordedAt).toLocaleTimeString("en-PH"),
    // Show the same provisional value used in Water Parameters until the probe is calibrated.
    turbidity: sensorTurbidityValue(reading),
    temperature: reading.temperatureC,
    ph: reading.ph
  }));
  const connectionState = sensorConnectionState(telemetry, now);
  const live = connectionState === "live";
  return (
    <section className="card p-4 sm:p-5" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><Activity size={20} className="text-teal-600" /> {lang === "tl" ? "Live na Trend ng Kalidad ng Tubig" : "Live Water Quality Trends"}</h2>
          <p className="mt-1 text-sm text-slate-600">{lang === "tl" ? "Pinagmulan" : "Source"}: {telemetry.deviceName} · Device #{telemetry.deviceId}</p>
          <p className="text-xs text-slate-500">{lang === "tl" ? "Huling sukat" : "Last measurement"}: {new Date(telemetry.recordedAt).toLocaleString("en-PH", { timeZone: "Asia/Manila" })} (PHT)</p>
        </div>
        <div className="flex flex-wrap items-center gap-2"><span className={`rounded-md px-2 py-1 text-xs font-bold ${badgeClasses(measured)}`}>{statusText(measured, lang)}</span><span className={`rounded-full px-3 py-1 text-xs font-black ${live ? "bg-emerald-100 text-emerald-800" : connectionState === "stale" ? "bg-amber-100 text-amber-800" : "bg-slate-200 text-slate-700"}`}>{connectionState === "live" ? "Live" : connectionState === "stale" ? (lang === "tl" ? "Luma" : "Stale") : "Offline"}</span></div>
      </div>
      <p className="mt-2 text-xs text-slate-600">{lang === 'tl' ? 'Status ng mga nasukat lamang. Walang DO reading at hindi kasama ang tantiya sa turbidity; hindi pa matitiyak ang kabuuang kaligtasan ng tubig.' : 'Measured values only. DO is missing and estimated turbidity is excluded; overall water safety is not confirmed.'}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4"><p className="text-xs font-bold text-slate-500">pH</p><strong className="mt-1 block text-2xl text-slate-950">{telemetry.ph === null ? "--" : telemetry.ph.toFixed(2)}</strong>{telemetry.ph !== null && <span className={`mt-1 inline-block rounded-md px-2 py-1 text-xs font-bold ${badgeClasses(statusFor('ph', telemetry.ph))}`}>{shortStatusText(statusFor('ph', telemetry.ph), lang)}</span>}<p className="mt-1 text-xs text-slate-500">{telemetry.ph === null ? (lang === "tl" ? "Walang pH na natanggap mula sa device" : "No pH sent by device") : live ? "Live" : (lang === "tl" ? "Huling sukat" : "Last reading")}</p></div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-bold text-slate-500">{lang === "tl" ? "Temperatura" : "Temperature"}</p>
          <strong className="mt-1 block text-2xl text-slate-950">{telemetry.temperatureC === null ? "--" : `${telemetry.temperatureC.toFixed(1)} °C`}</strong>
          {telemetry.temperatureC !== null && <span className={`mt-1 inline-block rounded-md px-2 py-1 text-xs font-bold ${badgeClasses(statusFor('temperature', telemetry.temperatureC))}`}>{shortStatusText(statusFor('temperature', telemetry.temperatureC), lang)}</span>}
          <p className="mt-1 text-xs text-slate-500">{telemetry.temperatureC === null ? (lang === "tl" ? "Walang sukat. Ipasuri ang sensor sa administrator." : "No measurement. Ask the administrator to check the sensor.") : live ? "Live" : (lang === "tl" ? "Huling sukat" : "Last reading")}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-bold text-slate-500">{lang === "tl" ? "Labo ng tubig" : "Turbidity"}</p>
          <strong className="mt-1 block text-2xl text-slate-950">{calibrated ? "" : "~"}{value} <span className="text-base">NTU</span></strong>
          {calibrated && <span className={`mt-1 inline-block rounded-md px-2 py-1 text-xs font-bold ${badgeClasses(level)}`}>{shortStatusText(level, lang)}</span>}
        </div>
      </div>
      {!live && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs font-bold text-amber-900">{lang === "tl" ? "Hindi live ang sukat na ito. Tingnan ang koneksyon ng device o makipag-ugnayan sa administrator." : "This reading is not live. Check device connectivity or contact the administrator."}</p>}
      <div className="mt-4 h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={25} />
            <YAxis domain={[0, 500]} tick={{ fontSize: 10 }} width={34} />
            <Tooltip />
            <Line type="monotone" dataKey="turbidity" name={calibrated ? "Turbidity (NTU)" : "Estimated turbidity (NTU)"} stroke="#0d9488" strokeWidth={3} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {chart.some((point) => point.temperature !== null) && <div className="mt-3 h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={25} />
            <YAxis domain={[10, 40]} tick={{ fontSize: 10 }} width={34} />
            <Tooltip />
            <Line type="monotone" dataKey="temperature" name="Temperature (°C)" stroke="#ea580c" strokeWidth={3} dot={false} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>}
      {chart.some((point) => point.ph !== null) && <div className="mt-3 h-40 w-full"><ResponsiveContainer width="100%" height="100%"><LineChart data={chart}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={25} /><YAxis domain={[0, 14]} tick={{ fontSize: 10 }} width={34} /><Tooltip /><Line type="monotone" dataKey="ph" name="pH" stroke="#7c3aed" strokeWidth={3} dot={false} connectNulls={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div>}
      <p className="mt-2 text-xs font-semibold text-slate-600">{lang === "tl" ? "Ang walang reading ay hindi zero. Hindi sapat ang bahagyang sensor data upang matiyak ang pangkalahatang kaligtasan ng tubig." : "Missing readings are not zero. Partial sensor data cannot confirm overall water safety."}</p>
    </section>
  );
}

function turbidityMatches(value: number, fish: FishSpecies[]) {
  return fish.map((species) => {
    const [minimum, maximum] = species.ranges.turbidity;
    const distance = value < minimum ? minimum - value : value > maximum ? value - maximum : 0;
    return { fish: species, distance };
  }).sort((a, b) => a.distance - b.distance || a.fish.name.localeCompare(b.fish.name));
}

function temperatureMatches(value: number, fish: FishSpecies[]) {
  return fish.map((species) => {
    const [minimum, maximum] = species.ranges.temperature;
    const distance = value < minimum ? minimum - value : value > maximum ? value - maximum : 0;
    return { fish: species, distance };
  }).sort((a, b) => a.distance - b.distance || a.fish.name.localeCompare(b.fish.name));
}

function phMatches(value: number, fish: FishSpecies[]) {
  return fish.map((species) => {
    const [minimum, maximum] = species.ranges.ph;
    const distance = value < minimum ? minimum - value : value > maximum ? value - maximum : 0;
    return { fish: species, distance };
  }).sort((a, b) => a.distance - b.distance || a.fish.name.localeCompare(b.fish.name));
}

function PhAssessment({ telemetry, lang }: { telemetry: SensorTelemetry; lang: Lang }) {
  const ph = telemetry.ph!;
  return (
    <section className="card border border-sky-200 p-5" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-black text-slate-950">{lang === "tl" ? "Paunang live na pagsusuri" : "Preliminary live assessment"}</h2>
        <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-black text-sky-800">{lang === "tl" ? "pH lamang" : "pH-based"}</span>
      </div>
      <p className="mt-3 text-2xl font-black text-teal-800">pH {ph.toFixed(2)}</p>
      <p className="mt-2 text-sm font-semibold leading-6 text-slate-700">
        {lang === "tl"
          ? "Live ang pH at awtomatikong nag-a-update. Ginagamit ito para magpakita ng paunang tugma ng isda batay sa pH."
          : "pH is live and updates automatically. It is used to show preliminary fish matches by pH."}
      </p>
      <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs font-semibold leading-5 text-amber-900">
        {lang === "tl"
          ? "Paunang gabay lamang ito. Kailangan pa rin ng temperatura, DO, ammonia, at calibrated turbidity para sa buong water-quality decision."
          : "This is preliminary guidance only. Temperature, DO, ammonia, and calibrated turbidity are still needed for a full water-quality decision."}
      </p>
    </section>
  );
}

function PhFishRanking({ ph, fish, lang }: { ph: number; fish: FishSpecies[]; lang: Lang }) {
  const matches = phMatches(ph, fish);
  return (
    <aside className="card h-fit p-5">
      <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><Fish size={21} className="text-teal-600" />{lang === "tl" ? "Paunang Tugma ng Isda" : "Preliminary Fish Matches"}</h2>
      <p className="mt-2 text-xs font-semibold leading-5 text-sky-900">
        {lang === "tl" ? `Batay lamang sa live na pH ${ph.toFixed(2)}. Hindi pa ito buong fish recommendation.` : `Based only on the live pH ${ph.toFixed(2)}. This is not a full fish recommendation.`}
      </p>
      <ol className="mt-4 space-y-2">
        {matches.map(({ fish: species, distance }, index) => (
          <li key={species.id} className={`flex items-center gap-3 rounded-lg border p-3 ${index === 0 ? "border-teal-300 bg-teal-50" : "border-slate-200"}`}>
            <span className="w-7 shrink-0 text-sm font-black text-slate-500">#{index + 1}</span>
            <img src={`/fish/${species.id}.jpg`} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-900">{species.name}</p><p className="text-xs text-slate-500">pH {species.ranges.ph[0]}-{species.ranges.ph[1]}</p></div>
            <span className={`text-xs font-black ${distance === 0 ? "text-emerald-700" : "text-amber-700"}`}>{distance === 0 ? (lang === "tl" ? "Tugma" : "Matches") : (lang === "tl" ? "Labas" : "Outside")}</span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs font-semibold leading-5 text-slate-600">{lang === "tl" ? "Ikumpara rin ang temperatura, DO, ammonia, at calibrated turbidity bago pumili ng isda o gumawa ng mahalagang desisyon." : "Also check temperature, DO, ammonia, and calibrated turbidity before choosing fish or making an important decision."}</p>
    </aside>
  );
}

function TemperatureAssessment({ telemetry, lang }: { telemetry: SensorTelemetry; lang: Lang }) {
  const temperature = telemetry.temperatureC!;
  const estimatedTurbidity = sensorTurbidityValue(telemetry);
  return (
    <section className="card border border-sky-200 p-5" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-black text-slate-950">{lang === "tl" ? "Paunang live na pagsusuri" : "Preliminary live assessment"}</h2>
        <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-black text-sky-800">{lang === "tl" ? "Temperatura lamang" : "Temperature-based"}</span>
      </div>
      <p className="mt-3 text-2xl font-black text-teal-800">{temperature.toFixed(1)} °C</p>
      <p className="mt-2 text-sm font-semibold leading-6 text-slate-700">
        {lang === "tl"
          ? "Live ang temperatura at awtomatikong nag-a-update. Ginagamit ito para magpakita ng paunang tugma ng isda batay sa temperatura."
          : "Temperature is live and updates automatically. It is used to show preliminary fish matches by temperature."}
      </p>
      <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs font-semibold leading-5 text-amber-900">
        {lang === "tl"
          ? `Ang turbidity na ~${estimatedTurbidity} NTU ay tantiya pa lamang at hindi kasama sa ranking hanggang ma-calibrate. Kailangan pa rin ng pH, DO, at ammonia para sa buong water-quality decision.`
          : `The ~${estimatedTurbidity} NTU turbidity value is still an estimate, so it is not used in the ranking until calibrated. pH, DO, and ammonia are still needed for a full water-quality decision.`}
      </p>
    </section>
  );
}

function TemperatureFishRanking({ temperature, fish, lang }: { temperature: number; fish: FishSpecies[]; lang: Lang }) {
  const matches = temperatureMatches(temperature, fish);
  return (
    <aside className="card h-fit p-5">
      <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><Fish size={21} className="text-teal-600" />{lang === "tl" ? "Paunang Tugma ng Isda" : "Preliminary Fish Matches"}</h2>
      <p className="mt-2 text-xs font-semibold leading-5 text-sky-900">
        {lang === "tl" ? `Batay lamang sa live na ${temperature.toFixed(1)} °C na temperatura. Hindi pa ito buong fish recommendation.` : `Based only on the live ${temperature.toFixed(1)} °C temperature. This is not a full fish recommendation.`}
      </p>
      <ol className="mt-4 space-y-2">
        {matches.map(({ fish: species, distance }, index) => (
          <li key={species.id} className={`flex items-center gap-3 rounded-lg border p-3 ${index === 0 ? "border-teal-300 bg-teal-50" : "border-slate-200"}`}>
            <span className="w-7 shrink-0 text-sm font-black text-slate-500">#{index + 1}</span>
            <img src={`/fish/${species.id}.jpg`} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-900">{species.name}</p><p className="text-xs text-slate-500">{species.ranges.temperature[0]}-{species.ranges.temperature[1]} °C</p></div>
            <span className={`text-xs font-black ${distance === 0 ? "text-emerald-700" : "text-amber-700"}`}>{distance === 0 ? (lang === "tl" ? "Tugma" : "Matches") : (lang === "tl" ? "Labas" : "Outside")}</span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs font-semibold leading-5 text-slate-600">{lang === "tl" ? "Ikumpara rin ang pH, DO, ammonia, at calibrated turbidity bago pumili ng isda o gumawa ng mahalagang desisyon." : "Also check pH, DO, ammonia, and calibrated turbidity before choosing fish or making an important decision."}</p>
    </aside>
  );
}

function TurbidityAssessment({ telemetry, fish, lang }: { telemetry: SensorTelemetry; fish: FishSpecies[]; lang: Lang }) {
  const value = sensorTurbidityValue(telemetry);
  const estimated = telemetry.turbidityNtu === null;
  const level = statusFor("turbidity", value);
  const closest = turbidityMatches(value, fish)[0];
  return (
    <section className={`card border p-5 ${estimated ? "border-amber-200" : level === "critical" ? "border-red-200" : level === "warning" ? "border-amber-200" : "border-emerald-200"}`} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-black text-slate-950">{lang === "tl" ? "Awtomatikong pagsusuri ng labo ng tubig" : "Automatic turbidity assessment"}</h2>
        <span className={`rounded-full px-3 py-1 text-xs font-black ${estimated ? "bg-amber-100 text-amber-900" : badgeClasses(level)}`}>{estimated ? (lang === "tl" ? "Tantya lamang" : "Estimate only") : level === "safe" ? (lang === "tl" ? "Katanggap-tanggap na labo" : "Acceptable turbidity") : level === "warning" ? (lang === "tl" ? "Maulap ang tubig" : "Cloudy water") : (lang === "tl" ? "Napakalabo ng tubig" : "Very cloudy water")}</span>
      </div>
      <p className="mt-3 text-2xl font-black text-teal-800">{estimated ? "~" : ""}{value} NTU {estimated && <span className="text-sm text-amber-800">(estimate)</span>}</p>
      <p className="mt-2 text-sm text-slate-700">{lang === "tl" ? "Awtomatikong nagbabago sa bawat bagong ESP32 reading; hindi kailangan pindutin ang Analyze." : "Updates automatically with each ESP32 reading; no Analyze click is needed."}</p>
      {closest && <p className="mt-3 text-sm font-bold text-slate-800">{lang === "tl" ? "Pinakamalapit na tugma batay sa labo lamang" : "Closest match by turbidity only"}: {closest.fish.name}</p>}
      <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs font-semibold leading-5 text-amber-900">{lang === "tl" ? "Paunang resulta lamang. Hindi sapat ang isang sensor para matiyak ang kaligtasan ng tubig o ang pinakamainam na isda. Tinatayang NTU ito hangga't hindi na-calibrate; may signal din ang probe kahit nasa hangin." : "Preliminary result only. One sensor cannot confirm overall water safety or the best fish. This is an estimated NTU until calibrated; the probe also produces a signal in air."}</p>
    </section>
  );
}

function TurbidityFishRanking({ value, fish, lang }: { value: number; fish: FishSpecies[]; lang: Lang }) {
  const matches = turbidityMatches(value, fish);
  return (
    <aside className="card h-fit p-5">
      <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><Fish size={21} className="text-teal-600" />{lang === "tl" ? "Tugma sa Labo ng Tubig" : "Turbidity-Only Fish Match"}</h2>
      <p className="mt-2 text-xs font-semibold leading-5 text-amber-900">{lang === "tl" ? "Paunang paghahambing lamang. Hindi pa ito buong fish recommendation." : "Preliminary comparison, not a full fish recommendation."}</p>
      <ol className="mt-4 space-y-2">
        {matches.map(({ fish: species, distance }, index) => (
          <li key={species.id} className={`flex items-center gap-3 rounded-lg border p-3 ${index === 0 ? "border-teal-300 bg-teal-50" : "border-slate-200"}`}>
            <span className="w-7 shrink-0 text-sm font-black text-slate-500">#{index + 1}</span>
            <img src={`/fish/${species.id}.jpg`} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-900">{species.name}</p><p className="text-xs text-slate-500">{species.ranges.turbidity[0]}-{species.ranges.turbidity[1]} NTU</p></div>
            <span className={`text-xs font-black ${distance === 0 ? "text-emerald-700" : "text-amber-700"}`}>{distance === 0 ? (lang === "tl" ? "Sakop" : "In range") : (lang === "tl" ? "Labas" : "Outside")}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function SensorAnalysisNotice({ analysis, lang }: { analysis: SensorAnalysisState; lang: Lang }) {
  const measuredLabel = analysis.isEstimated
    ? (lang === "tl" ? "tinatayang turbidity" : "estimated turbidity")
    : (lang === "tl" ? "na-calibrate na turbidity" : "calibrated turbidity");

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950 shadow-sm">
      <div className="flex items-start gap-3">
        <Activity className="mt-0.5 shrink-0 text-amber-700" size={21} />
        <div>
          <p className="font-black">{lang === "tl" ? "Live turbidity analysis" : "Live turbidity analysis"}</p>
          <p className="mt-1 text-sm font-semibold leading-5 text-amber-900">
            {lang === "tl"
              ? `Gamit ang ${measuredLabel} na ${analysis.turbidity} NTU. Patuloy itong nagre-refresh kapag may bagong sensor reading. Ang pH, temperatura, DO, at ammonia ay current dashboard values pa rin.`
              : `Using ${measuredLabel} of ${analysis.turbidity} NTU. This refreshes when a new sensor reading arrives. pH, temperature, DO, and ammonia still use the current dashboard values.`}
          </p>
        </div>
      </div>
    </section>
  );
}

function CollapsiblePanel({
  title,
  description,
  open,
  onToggle,
  children
}: {
  title: string;
  description: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="card p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-950">{title}</h2>
          <p className="mt-1 text-sm font-semibold leading-6 text-slate-500">{description}</p>
        </div>
        <button className="soft-button shrink-0" onClick={onToggle}>
          {open ? "Hide details" : "View details"}
        </button>
      </div>
      {open && <div className="mt-5">{children}</div>}
    </section>
  );
}

function WaterParametersPanel({
  lang,
  params,
  setParams,
  sensorTelemetry,
  sensorFresh,
  showManual,
  onAnalyze,
  text
}: {
  lang: Lang;
  params: WaterParams;
  setParams: (params: WaterParams) => void;
  sensorTelemetry: SensorTelemetry | null;
  sensorFresh: boolean;
  showManual: boolean;
  onAnalyze: () => void;
  text: typeof ui.en;
}) {
  if (!showManual && !sensorTelemetry) return <section className="card p-5"><h2 className="mb-4 text-lg font-bold">{text.waterParameters}</h2><dl className="divide-y divide-slate-100">{parameterMeta.map(meta => <div key={meta.key} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><dt>{meta.label[lang]}</dt><dd className="text-slate-500">{lang === "tl" ? "Wala pang sukat" : "No measurement"}</dd></div>)}</dl></section>;
  return (
    <section className="card h-fit p-4 sm:p-5">
      <h2 className="mb-5 flex items-center gap-2 text-lg font-black text-slate-950">
        <Droplets className="text-teal-600" size={21} /> {text.waterParameters}
      </h2>
      {sensorTelemetry && !showManual && (
        <div className="space-y-3 text-sm">
          <p className={`rounded-lg p-3 font-bold ${sensorFresh ? "bg-teal-50 text-teal-800" : "bg-amber-50 text-amber-900"}`}>{sensorFresh ? (lang === "tl" ? "Awtomatikong nag-a-update ang mga sukat ng sensor." : "Sensor measurements update automatically.") : (lang === "tl" ? "Walang bagong reading. Ang value sa ibaba ay huling natanggap lamang." : "No recent reading. The values below are the last received, not live.")}</p>
          {parameterMeta.filter(meta => meta.key !== "ammonia").map((meta) => (
            <div key={meta.key} className="flex items-center justify-between border-b border-slate-100 py-2">
              <span className="font-semibold text-slate-700">{meta.label[lang]}</span>
              <span className={meta.key === "turbidity" || meta.key === "temperature" || meta.key === "ph" ? "font-black text-teal-700" : "font-semibold text-slate-500"}>{meta.key === "turbidity" ? `${sensorTelemetry.turbidityNtu === null ? "~" : ""}${sensorTurbidityValue(sensorTelemetry)} NTU${sensorTelemetry.turbidityNtu === null ? " (est.)" : ""}` : meta.key === "temperature" && sensorTelemetry.temperatureC !== null ? `${sensorTelemetry.temperatureC.toFixed(1)} °C` : meta.key === "ph" && sensorTelemetry.ph !== null ? sensorTelemetry.ph.toFixed(2) : (lang === "tl" ? "Walang sensor reading" : "No sensor reading")}</span>
            </div>
          ))}
          <p className="text-xs text-slate-600">{lang === "tl" ? "Ang dash ay hindi zero. Wala pang nakakabit na sensor para sa ibang parameter." : "Missing is not zero. No connected sensor has measured the other parameters."}</p>
        </div>
      )}
      {sensorTelemetry && !showManual ? null : <>
      <p className="mb-4 text-xs font-semibold leading-5 text-slate-600">{lang === "tl" ? "Manu-manong input ang mga slider sa ibaba. Halimbawa lamang ang panimulang value; hindi ito galing sa sensor. Ipasok ang aktuwal na sukat bago mag-full analysis." : "The sliders below are manual inputs. Starting values are examples, not sensor measurements. Enter actual measurements before a full analysis."}</p>
      <div className="space-y-5 sm:space-y-6">
        {parameterMeta.filter(meta => meta.key !== "ammonia").map((meta) => {
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
      <button className="primary-button mt-5 w-full py-3.5 sm:mt-6 sm:py-4" onClick={onAnalyze}>
        <Fish size={18} /> {text.analyze}
      </button>
      </>}
    </section>
  );
}


function AlertBanner({ alert, lang }: { alert: AlertItem; lang: Lang }) {
  const Icon = alert.level === "safe" ? Check : AlertTriangle;
  return (
    <section className={`flex items-start gap-3 rounded-2xl border p-4 shadow-card sm:gap-4 sm:p-5 ${levelClasses(alert.level)}`}>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/70 sm:h-11 sm:w-11">
        <Icon size={23} />
      </span>
      <div>
        <h2 className="text-base font-black sm:text-lg">{localize(alert.title, lang)}</h2>
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
    <section className={`flex items-center gap-3 rounded-2xl border p-4 shadow-card sm:gap-4 sm:p-5 ${levelClasses(status)}`}>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/70 ring-1 ring-current/10 sm:h-12 sm:w-12 sm:rounded-2xl">
        <Icon size={24} />
      </span>
      <div>
        <h2 className="text-base font-black sm:text-lg">{localize(title, lang)}</h2>
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
    <section className={`rounded-2xl border p-4 shadow-card sm:p-5 ${levelClasses(status)}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-wide opacity-80">
            {lang === "tl" ? "Gabay ng mangingisda" : "Farmer action guide"}
          </p>
          <h2 className="mt-1 text-xl font-black sm:text-2xl">{title}</h2>
          <p className="mt-1 text-sm font-semibold opacity-90">{subtitle}</p>
        </div>
        <span className={`w-fit rounded-full px-3 py-1 text-xs font-black ring-1 ${badgeClasses(status)}`}>
          {status === "critical" ? (lang === "tl" ? "Kritikal" : "Critical") : status === "warning" ? (lang === "tl" ? "Babala" : "Warning") : (lang === "tl" ? "Ligtas" : "Safe")}
        </span>
      </div>
      <ol className="mt-4 grid gap-3 sm:grid-cols-3">
        {mainActions.map((action, index) => (
          <li key={action} className="rounded-xl bg-white/75 p-3 text-sm font-bold shadow-sm ring-1 ring-current/10 sm:p-4">
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
    <section className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-5">
      {parameterMeta.map((meta) => {
        const status = statusFor(meta.key, params[meta.key]);
        return (
          <article key={meta.key} className={`rounded-2xl border bg-white p-3 shadow-card sm:p-4 ${status === "critical" ? "border-red-200" : status === "warning" ? "border-amber-200" : "border-emerald-100"}`}>
            <p className="text-xs font-bold text-slate-500">{meta.label[lang]}</p>
            <p className="mt-1 break-words text-xl font-black text-slate-950 sm:text-2xl">{valueText(meta.key, params[meta.key])}{meta.unit}</p>
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
  lang,
  text
}: {
  selectedScore: FishScore;
  selectedRank: number;
  best: FishScore;
  lang: Lang;
  text: typeof ui.en;
}) {
  const isBest = selectedScore.fish.id === best.fish.id;
  return (
    <section className="card overflow-hidden p-4 sm:p-6">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-4">
          <div className="relative grid h-20 w-24 shrink-0 place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-slate-100 to-teal-100 ring-1 ring-slate-200 sm:h-24 sm:w-28">
            <img
              src={fishImageSrc(selectedScore.fish.id)}
              alt={selectedScore.fish.name}
              className="h-full w-full object-cover"
            />
            <span className="absolute bottom-2 right-2 rounded-full bg-teal-600 px-2 py-1 text-xs font-black text-white">#{selectedRank}</span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-black uppercase tracking-wider text-teal-700">{isBest ? text.bestMatch : text.selectedFish}</p>
            <h1 className="mt-2 text-2xl font-black text-slate-950 sm:text-3xl">{selectedScore.fish.name}</h1>
            <p className="mt-1 text-sm italic text-slate-500">{selectedScore.fish.scientificName}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className={`rounded-full px-3 py-1 text-xs font-black ring-1 ${badgeClasses(selectedScore.confidence)}`}>
                ✓ {selectedScore.confidence} {text.confidence}
              </span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">{selectedScore.fish.category}</span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">{selectedScore.fish.marketValue} {text.marketValue}</span>
            </div>
            <div className="mt-4 rounded-2xl border border-teal-100 bg-teal-50 p-3">
              <p className="text-xs font-black uppercase tracking-wide text-teal-700">
                {lang === "tl" ? "Bakit ito ang napili" : "Why this fish"}
              </p>
              <p className="mt-1 text-sm font-bold leading-6 text-slate-700">{strongestFishReason(selectedScore, lang)}</p>
              <p className="mt-1 text-xs font-semibold text-slate-500">{bestFishExplanation(selectedScore, lang)}</p>
            </div>
          </div>
        </div>
        <div className="self-center sm:self-auto">
          <ScoreGauge score={selectedScore.score} confidence={selectedScore.confidence} />
        </div>
      </div>
    </section>
  );
}

function ScoreGauge({ score, confidence }: { score: number; confidence: FishScore["confidence"] }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative grid h-28 w-28 shrink-0 place-items-center sm:h-32 sm:w-32">
      <svg className="h-28 w-28 -rotate-90 sm:h-32 sm:w-32" viewBox="0 0 110 110" aria-label={`Score ${score}%`}>
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
        <div className="text-2xl font-black text-teal-700 sm:text-3xl">{score}%</div>
        <div className="text-xs font-bold text-slate-500">{confidence}</div>
      </div>
    </div>
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
            <article key={meta.key} className={`rounded-2xl border p-4 shadow-card sm:p-5 ${levelClasses(status)}`}>
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
    <section className="card p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-black text-slate-950">{text.correctiveActions}</h2>
        <span className={`rounded-full px-3 py-1 text-xs font-black ring-1 ${badgeClasses(status)}`}>{status}</span>
      </div>
      <div className="mt-4 space-y-3">
        {alerts.map((alert) => (
          <article key={alert.title} className={`overflow-hidden rounded-2xl border ${levelClasses(alert.level)}`}>
            <div className="flex items-center justify-between gap-3 border-b border-current/10 px-3 py-3 sm:px-4">
              <strong>{localize(alert.title, lang)}</strong>
              <span className={`rounded-full px-2.5 py-1 text-xs font-black ring-1 ${badgeClasses(alert.level)}`}>{alert.level}</span>
            </div>
            <ol className="space-y-2 px-3 py-3 text-sm font-medium sm:px-5 sm:py-4">
              {alert.actions.map((action, index) => (
                <li key={action} className="flex gap-2 rounded-xl bg-white/50 p-3 sm:gap-3">
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
    <section className="card p-4 sm:p-5">
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
  lang,
  text
}: {
  scores: FishScore[];
  selectedId: string;
  onSelectFish: (id: string) => void;
  lang: Lang;
  text: typeof ui.en;
}) {
  return (
    <section className="card h-fit p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-lg font-black text-slate-950">
        <Fish className="text-teal-600" size={21} /> {text.ranking}
      </h2>
      <p className="mt-2 text-sm font-medium text-slate-500">{text.clickFish}</p>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[11px] font-black">
        <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-700 ring-1 ring-emerald-100">{lang === "tl" ? "Angkop" : "Good"}</span>
        <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-700 ring-1 ring-amber-100">{lang === "tl" ? "Bantayan" : "Caution"}</span>
        <span className="rounded-full bg-red-50 px-2 py-1 text-red-700 ring-1 ring-red-100">{lang === "tl" ? "Problema" : "Risk"}</span>
      </div>
      <div className="mt-5 space-y-3">
        {scores.map((score, index) => {
          const confidence = confidenceLevel(score.score);
          const isTop = index === 0;
          const isSelected = selectedId === score.fish.id;
          const parameterBadges = parameterMeta.map((meta) => {
            const matchLevel = parameterMatchLevel(score.breakdown[meta.key]);
            return { meta, matchLevel, value: score.breakdown[meta.key] };
          });
          return (
            <button
              key={score.fish.id}
              className={`w-full rounded-2xl border bg-white p-3 text-left transition hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-card sm:p-4 ${
                isTop ? "border-teal-500 ring-2 ring-teal-100" : isSelected ? "border-teal-300" : "border-slate-200"
              }`}
              onClick={() => onSelectFish(score.fish.id)}
            >
              <div className="flex items-start gap-3">
                <span className="mt-1 text-sm font-black text-slate-500">#{index + 1}</span>
                <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-100 ring-1 ring-slate-200 sm:h-12 sm:w-12 sm:rounded-2xl">
                  <img src={fishImageSrc(score.fish.id)} alt={score.fish.name} className="h-full w-full object-cover" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-black text-slate-950">{score.fish.name}</span>
                  <span className="block truncate text-xs italic text-slate-500">{score.fish.scientificName}</span>
                </span>
                <span className="text-sm font-black text-teal-700">{score.score}%</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-black ring-1 ${recommendationClasses(score.score)}`}>
                  {recommendationLabel(score.score, lang)}
                </span>
                {isTop && (
                  <span className="rounded-full bg-teal-50 px-2.5 py-1 text-[11px] font-black text-teal-700 ring-1 ring-teal-100">
                    {lang === "tl" ? "Pinakaangkop" : "Top Match"}
                  </span>
                )}
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full ${progressColor(score.score)} ${progressWidth(score.score)}`} />
              </div>
              <p className="mt-3 text-xs font-semibold leading-5 text-slate-600">{strongestFishReason(score, lang)}</p>
              <div className="mt-3 grid grid-cols-5 gap-1">
                {parameterBadges.filter(({ meta }) => meta.key !== "ammonia").map(({ meta, matchLevel, value }) => (
                  <span
                    key={meta.key}
                    className={`rounded-lg px-1.5 py-1 text-center text-[10px] font-black ring-1 ${badgeClasses(matchLevel)}`}
                    title={`${meta.label[lang]} ${value}%`}
                  >
                    {meta.key === "dissolvedOxygen" ? "DO" : meta.key === "temperature" ? "Temp" : meta.key === "ammonia" ? "NH3" : meta.key === "turbidity" ? "Turb" : "pH"}
                  </span>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-slate-500">{bestFishExplanation(score, lang)}</span>
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
  ] as const;

  return (
    <section className="card p-4 sm:p-5">
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

      <div className="mt-4 flex snap-x gap-3 overflow-x-auto pb-2 md:grid md:grid-cols-2 md:overflow-visible md:pb-0 2xl:grid-cols-5">
        {trendCards.map((card) => (
          <article key={card.key} className="min-w-[230px] snap-start rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:min-w-[260px] sm:p-4 md:min-w-0">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-black uppercase tracking-wide text-slate-600">{card.label}</h3>
              <span className="text-sm font-black text-slate-950">
                {valueText(card.key, params[card.key])}
              </span>
            </div>
            <div className="mt-3 h-28 sm:h-32">
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

function historyMeasurements(row: SessionRecord): [string, string | number | null][] {
  return [
    ["pH", row.ph],
    ["Temperature", row.temperature == null ? "--" : `${row.temperature} °C`],
    ["DO", row.dissolvedOxygen == null ? "--" : `${row.dissolvedOxygen} mg/L`],
    ["Turbidity", row.turbidity == null ? "--" : `${row.turbidity} NTU`]
  ];
}

function HistoryPage({ sessions, onExport, text, lang }: { sessions: SessionRecord[]; onExport: () => void; text: typeof ui.en; lang: Lang }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const counts = sessions.reduce(
    (acc, row) => {
      acc[historyStatus(row)] += 1;
      return acc;
    },
    { safe: 0, warning: 0, critical: 0, partial: 0 }
  );
  const filteredSessions = sessions.filter((row) => {
    const status = historyStatus(row);
    const haystack = `${row.timestamp} ${row.bestFish} ${status}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (statusFilter === "all" || statusFilter === 'partial' && isPartialSession(row) || status === statusFilter);
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
            <span className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-black text-slate-700">Partial {sessions.filter(isPartialSession).length}</span>
          </div>
        </div>
        <p className="mt-3 text-sm text-slate-600">{lang === 'tl' ? 'Ang Safe, Warning, at Critical ay para lamang sa mga sinukat na parameter. Hindi kinukumpirma ng bahagyang pagsusuri na ligtas ang buong tubig.' : 'Safe, Warning, and Critical describe measured parameters only. A partial test does not confirm overall water safety.'}</p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="min-h-11 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold outline-none focus:border-teal-400 focus:ring-4 focus:ring-teal-100"
              placeholder="Search fish, date, status..."
              aria-label={lang === "tl" ? "Hanapin ang tala" : "Search records"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              className="min-h-11 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-black text-slate-600"
              value={statusFilter}
              aria-label={lang === "tl" ? "Salain ayon sa kalagayan" : "Filter by status"}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All status</option>
              <option value="safe">Safe</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
              <option value="partial">Partial</option>
            </select>
          </div>
          <button className="soft-button" onClick={onExport}>
            <Download size={16} /> {text.exportCsv}
          </button>
        </div>
        <div className="mt-5 space-y-3 sm:hidden">
          {filteredSessions.map(row => <article key={row.id} className="rounded-lg border border-slate-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">{row.timestamp}</h3><span className={measurementBadge(historyStatus(row))}>{historyStatus(row)}</span></div>
            <p className="text-sm text-slate-600">{row.inputMode === 'manual' ? (lang === 'tl' ? 'Manu-manong pagsusuri' : 'Manual Analysis') : (lang === 'tl' ? 'Tala ng sensor' : 'Sensor Reading')}</p>
            {row.turbidityEstimated && row.turbidity !== null && <p className="text-sm text-amber-800">{lang === 'tl' ? 'Tantya lamang ang turbidity; hindi kasama sa status.' : 'Turbidity is an estimate; excluded from status.'}</p>}
            {isPartialSession(row) && <p className="text-sm text-slate-600">{lang === 'tl' ? 'Bahagyang pagsusuri - sinukat na values lamang' : 'Partial test - measured values only'}</p>}
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              {[["pH", row.ph], ["Temperature", row.temperature == null ? '--' : `${row.temperature} °C`], ["DO", row.dissolvedOxygen == null ? '--' : `${row.dissolvedOxygen} mg/L`], ["Turbidity", row.turbidity == null ? '--' : `${row.turbidity} NTU`], ["Ammonia", row.ammonia == null ? '--' : `${row.ammonia} mg/L`]].map(([label, value]) => <div key={label}><dt className="text-slate-600">{label}</dt><dd className="font-semibold">{value ?? "--"}</dd></div>)}
            </dl><p className="mt-3 border-t border-slate-100 pt-3 font-semibold">{row.bestFish || '--'} · {row.score == null ? '--' : `${row.score}%`}</p>
          </article>)}
          {!filteredSessions.length && <p className="py-6 text-sm text-slate-600">{text.noHistory}</p>}
        </div>
        <div className="mt-5 hidden overflow-x-auto sm:block">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                <th className="px-4 py-3">{text.dateTime}</th>
                <th className="px-4 py-3">pH</th>
                <th className="px-4 py-3">Temp</th>
                <th className="px-4 py-3">DO</th>
                <th className="px-4 py-3">Turbidity</th>
                <th className="px-4 py-3">Best Fish</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">{text.status}</th>
              </tr>
            </thead>
            <tbody>
              {filteredSessions.map((row) => {
                const status = historyStatus(row);
                return (
                  <tr key={row.id} className="border-b border-slate-100">
                    <td className="px-4 py-3 font-semibold text-slate-700">{row.timestamp}<span className="block text-xs font-normal">{row.inputMode === 'manual' ? (lang === 'tl' ? 'Manu-manong pagsusuri' : 'Manual Analysis') : (lang === 'tl' ? 'Tala ng sensor' : 'Sensor Reading')}</span></td>
                    <td className="px-4 py-3">{row.ph ?? '--'}</td>
                    <td className="px-4 py-3">{row.temperature ?? '--'}</td>
                    <td className="px-4 py-3">{row.dissolvedOxygen ?? '--'}</td>
                    <td className="px-4 py-3">{row.turbidity == null ? '--' : row.turbidityEstimated ? `~${row.turbidity} (est.)` : row.turbidity}</td>
                    <td className="px-4 py-3 font-bold">{row.bestFish || '--'}</td>
                    <td className="px-4 py-3 font-black text-teal-700">{row.score == null ? '--' : `${row.score}%`}</td>
                    <td className="px-4 py-3">
                      <span className={measurementBadge(status)}>{status}</span>
                      {isPartialSession(row) && <span className="mt-1 block text-xs text-slate-600">{lang === 'tl' ? 'Bahagyang pagsusuri - sinukat lamang' : 'Partial test - measured only'}</span>}
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


function AuthPage({ navigate, onLogin }: { initialMode?: 'login' | 'register'; text: typeof ui.en; navigate: (path: string) => void; onLogin: (user: AppUser, message: string) => void }) {
  return <OwnerLogin navigate={navigate} onLogin={onLogin} />;
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

function HarvestPage({ currentUser, lang, fishDb, navigate }: { currentUser: AppUser | null; lang: Lang; fishDb: FishSpecies[]; navigate: (path: string) => void }) {
  const [assignment, setAssignment] = useState<{ id: number; name: string; deviceId: number | null } | null>(null);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  const emptyForm = { notes: "", sensorDeviceId: "", species: fishDb[0]?.name || "Tilapia", fishpenName: "", targetWeightG: "", reminderSms: false, stockingDate: today, stockedCount: "", targetHarvestDate: "", actualHarvestDate: "", harvestedKg: "", sellingPrice: "" };
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [records, setRecords] = useState<HarvestBatch[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [devices, setDevices] = useState<Array<{ id: number; deviceName: string }>>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [action, setAction] = useState<"batch" | "harvest" | "sample" | "mortality">("batch");
  const [eventForm, setEventForm] = useState({ harvestType: "partial", harvestDate: today, fishCount: "", weightKg: "", pricePerKg: "", notes: "" });
  const [sampleForm, setSampleForm] = useState({ sampledAt: today, sampleSize: "", averageWeightG: "", notes: "" });
  const [mortalityForm, setMortalityForm] = useState({ mortalityDate: today, deadCount: "", notes: "" });
  const [penFilter, setPenFilter] = useState("");
  const [speciesFilter, setSpeciesFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    const result = await apiJson<{ harvests: HarvestBatch[]; fishpenAssignment: { id: number; name: string; deviceId: number | null } | null }>("/api/harvests");
    setLoading(false);
    if (result.data) { setRecords(result.data.harvests); setAssignment(result.data.fishpenAssignment); }
    else setMessage(result.error || "Unable to load harvest records.");
  };
  useEffect(() => { setRecords([]); if (currentUser) { void refresh(); void apiJson<{ devices: Array<{ id: number; deviceName: string }> }>("/api/sensors/devices").then(r => setDevices(r.data?.devices || [])); } }, [currentUser?.id]);
  const save = async () => {
    if (!assignment) return setMessage(lang === 'tl' ? 'Ipa-assign muna sa administrator ang iyong fishpen.' : 'Ask the administrator to assign your fishpen first.');
    if (!form.species || !form.stockingDate || !form.targetHarvestDate || !Number(form.stockedCount)) {
      setMessage(lang === "tl" ? "Punan ang isda, petsa, at dami ng inalagaan." : "Enter species, dates, and number stocked.");
      return;
    }
    setBusy(true);
    const result = await apiJson(editingId ? `/api/harvests/${editingId}` : "/api/harvests", {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify({ species: form.species, notes: form.notes, reminderSms: form.reminderSms, stockingDate: form.stockingDate, targetHarvestDate: form.targetHarvestDate, stockedCount: Number(form.stockedCount), targetWeightG: form.targetWeightG || null, actualHarvestDate: form.actualHarvestDate || null, harvestedKg: form.harvestedKg || null, sellingPrice: form.sellingPrice || null })
    });
    setBusy(false);
    if (result.error) return setMessage(result.error);
    setMessage(lang === "tl" ? "Nai-save ang tala ng ani." : "Harvest record saved.");
    setShowForm(false);
    setForm(emptyForm);
    setEditingId(null);
    void refresh();
  };
  const edit = (row: HarvestBatch) => {
    setEditingId(row.id);
    setShowForm(true);
    setForm({ notes: row.notes || "", sensorDeviceId: row.sensorDeviceId ? String(row.sensorDeviceId) : "", species: row.species, fishpenName: row.fishpenName || "", targetWeightG: row.targetWeightG === null ? "" : String(row.targetWeightG), reminderSms: Boolean(row.reminderSms), stockingDate: String(row.stockingDate).slice(0, 10), stockedCount: String(row.stockedCount), targetHarvestDate: String(row.targetHarvestDate).slice(0, 10), actualHarvestDate: row.actualHarvestDate ? String(row.actualHarvestDate).slice(0, 10) : "", harvestedKg: row.harvestedKg === null ? "" : String(row.harvestedKg), sellingPrice: row.sellingPrice === null ? "" : String(row.sellingPrice) });
    setAction("batch");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const remove = async (id: number) => {
    if (!window.confirm(lang === "tl" ? "Burahin ang batch at lahat ng sample, mortality, obserbasyon at ani nito? Hindi ito maibabalik." : "Delete this batch and all its samples, mortality, observations and harvests? This cannot be undone.")) return;
    const result = await apiJson(`/api/harvests/${id}`, { method: "DELETE" });
    setMessage(result.error || (lang === "tl" ? "Nabura ang tala." : "Record deleted."));
    if (!result.error) void refresh();
  };
  const completed = records.filter((row) => row.actualHarvestDate);
  const activeBatchCount = records.length - completed.length;
  const createBatch = () => {
    setAction('batch'); setEditingId(null); setForm(emptyForm); setShowForm(true); setMessage('');
    window.setTimeout(() => document.getElementById('harvest-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };
  const totalKg = records.reduce((sum, row) => sum + (row.harvestEvents?.length ? row.harvestEvents.reduce((part, event) => part + Number(event.weightKg), 0) : Number(row.harvestedKg || 0)), 0);
  const grossSales = records.reduce((sum, row) => sum + (row.harvestEvents?.length ? row.harvestEvents.reduce((part, event) => part + Number(event.weightKg) * Number(event.pricePerKg || 0), 0) : Number(row.harvestedKg || 0) * Number(row.sellingPrice || 0)), 0);
  const filtered = records.filter((row) => (!penFilter || (row.fishpenName || "").toLowerCase().includes(penFilter.toLowerCase())) && (!speciesFilter || row.species === speciesFilter) && (!dateFilter || row.targetHarvestDate >= dateFilter));
  const selected = records.find((row) => row.id === selectedId);
  const remainingStock = (row: HarvestBatch) => estimatedRemainingStock(row.stockedCount, row.mortalities || [], row.harvestEvents || []);
  const submitAction = async () => {
    if (!selected) return;
    const confirmComplete = action === "harvest" && eventForm.harvestType === "complete";
    if (confirmComplete && !window.confirm(lang === "tl" ? "Tapusin ang batch pagkatapos nitong ani? Mananatili ang kasaysayan." : "Complete this batch after recording this harvest? Its history will be preserved.")) return;
    setBusy(true);
    const endpoint = action === "harvest" ? "events" : action === "sample" ? "samples" : "mortalities";
    const payload = action === "harvest" ? { ...eventForm, confirmComplete } : action === "sample" ? sampleForm : mortalityForm;
    const result = await apiJson(`/api/harvests/${selected.id}/${endpoint}`, { method: "POST", body: JSON.stringify(payload) });
    setBusy(false);
    setMessage(result.error || (lang === "tl" ? "Nai-save ang tala." : "Record saved."));
    if (!result.error) { setEventForm({ harvestType: "partial", harvestDate: today, fishCount: "", weightKg: "", pricePerKg: "", notes: "" }); setSampleForm({ sampledAt: today, sampleSize: "", averageWeightG: "", notes: "" }); setMortalityForm({ mortalityDate: today, deadCount: "", notes: "" }); void refresh(); }
  };
  const exportCsv = () => {
    const lines = [["Fishpen", "Species", "Stocking date", "Stocked fish", "Target harvest", "Actual harvest", "Harvest type", "Fish harvested", "Harvested kg", "Price per kg", "Estimated gross sales"]];
    filtered.forEach((row) => {
      if (row.harvestEvents?.length) row.harvestEvents.forEach((event) => lines.push([row.fishpenName || "", row.species, row.stockingDate, String(row.stockedCount), row.targetHarvestDate, event.harvestDate, event.harvestType, String(event.fishCount ?? ""), String(event.weightKg), String(event.pricePerKg ?? ""), event.pricePerKg === null ? "" : String(Number(event.weightKg) * Number(event.pricePerKg))]));
      else lines.push([row.fishpenName || "", row.species, row.stockingDate, String(row.stockedCount), row.targetHarvestDate, row.actualHarvestDate || "", row.actualHarvestDate ? "complete" : "", "", String(row.harvestedKg ?? ""), String(row.sellingPrice ?? ""), row.sellingPrice === null ? "" : String(Number(row.harvestedKg || 0) * Number(row.sellingPrice))]);
    });
    const csv = lines.map((line) => line.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "pondsense-harvests.csv"; link.click(); URL.revokeObjectURL(url);
  };
  const upcoming = records.filter((row) => {
    if (row.actualHarvestDate) return false;
    const days = Math.round((Date.parse(String(row.targetHarvestDate).slice(0, 10) + "T00:00:00") - Date.parse(today + "T00:00:00")) / 86400000);
    return days >= 0 && days <= 7;
  }).sort((a, b) => a.targetHarvestDate.localeCompare(b.targetHarvestDate));
  const overdue = records.filter(row => !row.actualHarvestDate && daysUntilHarvest(row.targetHarvestDate, today) < 0);
  const recentHarvests = records.flatMap(row => row.harvestEvents.map(event => ({ ...event, species: row.species, fishpen: row.fishpenName }))).sort((a, b) => b.harvestDate.localeCompare(a.harvestDate) || b.id - a.id).slice(0, 5);
  if (!currentUser) return <main className="mx-auto max-w-3xl p-5"><p>{lang === 'tl' ? 'Mag-login upang makita ang tala ng pag-aani.' : 'Log in to view your harvest records.'}</p><button className="primary-button mt-4" onClick={() => navigate('/login')}>Login</button></main>;
  return <HarvestWorkspace lang={lang} today={today} assignment={assignment} records={records} filtered={filtered}
    totalKg={totalKg} grossSales={grossSales} loading={loading} busy={busy} message={message}
    editingId={editingId} action={action} showForm={showForm} selectedId={selectedId} setSelectedId={setSelectedId}
    form={form} setForm={setForm} eventForm={eventForm} setEventForm={setEventForm}
    sampleForm={sampleForm} setSampleForm={setSampleForm} mortalityForm={mortalityForm} setMortalityForm={setMortalityForm}
    species={activeSpecies.map(f => f.name)} onCreate={createBatch} onAction={(next, id) => { setAction(next); setSelectedId(id || null); setShowForm(true); setMessage(''); }}
    onCancel={() => { setShowForm(false); setEditingId(null); setAction('batch'); setMessage(''); }}
    onSave={() => void save()} onSubmit={() => void submitAction()} onEdit={edit} onRemove={id => void remove(id)}
    onExport={exportCsv} onRetry={() => void refresh()} penFilter={penFilter} setPenFilter={setPenFilter}
    speciesFilter={speciesFilter} setSpeciesFilter={setSpeciesFilter} dateFilter={dateFilter} setDateFilter={setDateFilter} />;
}

function AuthModal({ onClose, onLogin }: { text: typeof ui.en; onClose: () => void; onLogin: (user: AppUser, message: string) => void }) {
  return <OwnerLogin navigate={() => onClose()} onLogin={onLogin} />;
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
          {path === '/admin/settings' && <AdminDeviceSettings />}
          {path === '/admin/settings' && <AdminFishpenAssignments />}
        </section>
      </main>
    </div>
  );
}

function AdminLoginPage({ navigate }: { navigate: (path: string) => void }) {
  const [deviceFlow, setDeviceFlow] = useState<{ token: string; bootstrap: boolean } | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [identifier, setIdentifier] = useState("admin");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const login = async () => {
    setError("");
    setSubmitting(true);
    const result = await postJson<{ admin?: AdminUser; token?: string; webauthnRequired?: boolean; bootstrapRequired?: boolean }>("/api/admin/login", { identifier, password, pin });
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.data?.token) {
      setPassword('');
      setPin('');
      setDeviceFlow({ token: result.data.token, bootstrap: Boolean(result.data.bootstrapRequired) });
      setEnrolling(Boolean(result.data.bootstrapRequired));
      return;
    }
    setError('Device verification could not start. Please try again.');
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
          {deviceFlow && <div className="space-y-3">
            {!deviceFlow.bootstrap && !enrolling && <button className="primary-button w-full" disabled={submitting} onClick={async () => {
              setSubmitting(true); setError('');
              try { await verifyAdminDevice(deviceFlow.token); navigate('/admin/dashboard'); }
              catch (e) { setError((e as Error).message); setDeviceFlow(null); }
              finally { setSubmitting(false); }
            }}>Verify this authorized device</button>}
            {!deviceFlow.bootstrap && !enrolling && <button className="soft-button w-full" onClick={() => setEnrolling(true)}>Request enrollment of a new device</button>}
            {enrolling && <AdminDeviceEnrollment token={deviceFlow.token} bootstrap={deviceFlow.bootstrap} onDone={() => navigate('/admin/dashboard')} />}
            {deviceFlow.bootstrap && <button className="soft-button w-full" onClick={() => navigate('/admin/dashboard')}>Continue existing admin access until setup</button>}
          </div>}
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
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  const refresh = async () => {
    const result = await apiJson<{ users: AdminUser[] }>('/api/admin/users');
    if (result.data) setUsers(result.data.users);
    else setError(result.error || 'Unable to load users.');
  };
  const updateStatus = async (user: AdminUser, status: string) => {
    if (!window.confirm(`${status}: ${user.fullName}?`)) return;
    setBusy(user.id); setError('');
    const result = await apiJson(`/api/admin/users/${user.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    if (result.error) setError(result.error);
    else await refresh();
    setBusy(null);
  };
  const [query, setQuery] = useState("");
  useEffect(() => {
    void refresh();
  }, []);
  const filteredUsers = users.filter((user) => {
    const value = `${user.fullName} ${user.username || ""} ${user.email || ""} ${user.phone || ""} ${user.role}`.toLowerCase();
    return value.includes(query.toLowerCase());
  });
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-black text-slate-950">Owner Accounts</h2>
          {error && <p role="alert" className="text-red-700">{error}</p>}
          <p className="text-sm font-semibold text-slate-500">{filteredUsers.length} of {users.length} accounts shown</p>
        </div>
        <input
          className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold outline-none focus:border-teal-400 focus:ring-4 focus:ring-teal-100 sm:max-w-xs"
          placeholder="Search name, phone, role..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <ProvisionOwner onSaved={() => void refresh()} />
      {temporaryPassword && <div className="mb-4 rounded-md bg-amber-50 p-4"><p>Temporary password — expires in 24 hours; provide privately.</p><code className="block break-all">{temporaryPassword}</code><button className="soft-button mt-2" onClick={() => setTemporaryPassword('')}>Hide password</button></div>}
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
                <td className="px-4 py-3"><span className={badgeClasses(user.role === "admin" ? "High" : "Medium")}>{user.role}</span>
                  {user.role === 'farmer' && <div className="mt-2 space-y-2"><strong>{user.accountStatus}</strong><div className="flex flex-wrap gap-2">
                    {user.accountStatus !== 'ACTIVE' && <button disabled={busy !== null} className="soft-button" onClick={() => void updateStatus(user, 'ACTIVE')}>Reactivate</button>}
                    {user.accountStatus === 'ACTIVE' && <button disabled={busy !== null} className="soft-button" onClick={() => void updateStatus(user, 'SUSPENDED')}>Suspend</button>}
                    <button disabled={busy !== null} className="soft-button" onClick={async () => { if (!window.confirm(`Reset password for ${user.fullName}? Existing sessions will be invalidated.`)) return; setBusy(user.id); setError(''); setTemporaryPassword(''); const r = await apiJson<{ temporaryPassword: string }>(`/api/admin/owners/${user.id}/reset-password`, { method: 'POST', body: '{}' }); if (r.error) setError(r.error); else setTemporaryPassword(r.data!.temporaryPassword); setBusy(null); }}>Reset password</button>
                  </div></div>}
                </td>
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
  const [planningSms, setPlanningSms] = useState<Array<Record<string, unknown>>>([]);
  const [alerts, setAlerts] = useState<Array<Record<string, unknown>>>([]);
  const [auditLogs, setAuditLogs] = useState<Array<Record<string, unknown>>>([]);
  const [logSearch, setLogSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [smsFilter, setSmsFilter] = useState("all");
  useEffect(() => {
    apiJson<{ logs: Array<Record<string, unknown>> }>("/api/admin/logs").then((result) => result.data && setLogs(result.data.logs));
    apiJson<{ alerts: Array<Record<string, unknown>> }>("/api/admin/alerts").then((result) => result.data && setAlerts(result.data.alerts));
    apiJson<{ logs: Array<Record<string, unknown>> }>('/api/admin/planning-sms').then(result => result.data && setPlanningSms(result.data.logs));
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
      <WaterSmsLogs />
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
          <h2 className="text-xl font-black text-slate-950">Planning SMS Attempts</h2>
          <p className="text-sm text-slate-600">Provider acceptance is not confirmation of delivery to the phone.</p>
          <div className="mt-3 max-h-80 space-y-2 overflow-y-auto">{planningSms.map(row => <div key={String(row.id)} className="rounded-lg border p-3 text-sm">
            <p className="font-bold">{String(row.full_name || 'Deleted account')} · {String(row.phone || '')}</p>
            <p>{String(row.kind)} · {row.status === 'sent' ? 'Provider accepted' : String(row.status)} · {new Date(String(row.created_at)).toLocaleString()}</p>
            {Boolean(row.error_message) && <p className="text-red-700">{String(row.error_message)}</p>}
          </div>)}</div>
          {!planningSms.length && <p className="mt-3 text-sm text-slate-600">No planning SMS attempts.</p>}
          <h2 className="mt-6 text-xl font-black text-slate-950">Admin Audit Logs</h2>
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
    { key: "optimal_ph_min", label: "Minimum pH", help: "Lowest acceptable pH", step: "0.01" },
    { key: "optimal_ph_max", label: "Maximum pH", help: "Highest acceptable pH", step: "0.01" },
    { key: "optimal_temp_min", label: "Minimum Temp", help: "Lowest water temperature (C)", step: "0.01" },
    { key: "optimal_temp_max", label: "Maximum Temp", help: "Highest water temperature (C)", step: "0.01" },
    { key: "optimal_do_min", label: "Minimum DO", help: "Lowest dissolved oxygen (mg/L)", step: "0.01" },
    { key: "optimal_do_max", label: "Maximum DO", help: "Highest dissolved oxygen (mg/L)", step: "0.01" },
    { key: "optimal_turb_min", label: "Minimum Turbidity", help: "Lowest turbidity level (NTU)", step: "0.01" },
    { key: "optimal_turb_max", label: "Maximum Turbidity", help: "Highest turbidity level (NTU)", step: "0.01" },
    { key: "max_ammonia", label: "Max Ammonia", help: "Highest safe NH3 level (mg/L)", step: "0.0001" }
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
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {fields.map((field) => (
                <label key={field.key} className="rounded-xl bg-slate-50 p-3 text-xs font-bold uppercase text-slate-500">
                  {field.label}
                  <input className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-black text-slate-900" type="number" step={field.step} value={String(row[field.key] ?? "")} onChange={(event) => {
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
    <div className="space-y-5"><AdminDevicesPage /><section className="card p-5">
      <h2 className="text-xl font-black text-slate-950">{text.settings}</h2>
      <div className="mt-5 max-w-md space-y-3">
        <input className="w-full rounded-xl border border-slate-200 px-4 py-3" type="password" placeholder="New admin PIN" value={pin} onChange={(event) => setPin(event.target.value)} />
        <button className="primary-button w-full" onClick={changePin}>Change Admin PIN</button>
        <button className="soft-button w-full" onClick={() => navigate("/admin/login")}>Go to Admin Login</button>
        <button className="w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-black text-white transition hover:bg-amber-600" onClick={clearLogs}>Clear Logs</button>
        <button className="w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-black text-white transition hover:bg-red-700" onClick={factoryReset}>Factory Reset</button>
        {message && <p className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-700">{message}</p>}
      </div>
    </section></div>
  );
}

function AdminDevicesPage() {
  type Device = { id: number; device_name: string; owner_user_id: number | null; owner_name: string | null; is_active: number; last_seen_at: string | null; last_reading_at: string | null; monitoring_fishpen_id: number | null };
  const [devices, setDevices] = useState<Device[]>([]);
  const [message, setMessage] = useState("");
  const [busyDevice, setBusyDevice] = useState<number | null>(null);
  const [replacementKey, setReplacementKey] = useState<{ deviceId: number; key: string } | null>(null);
  const refresh = async () => {
    const deviceResult = await apiJson<{ devices: Device[] }>("/api/admin/devices");
    if (deviceResult.data) setDevices(deviceResult.data.devices);
    if (deviceResult.error) setMessage(deviceResult.error);
  };
  useEffect(() => { void refresh(); }, []);
  const useForFishpen = async (device: Device) => {
    if (!device.owner_user_id) return;
    setBusyDevice(device.id);
    setMessage("");
    const result = await apiJson(`/api/admin/owners/${device.owner_user_id}/monitoring-device`, { method: "PUT", body: JSON.stringify({ deviceId: device.id }) });
    setMessage(result.error || `Device #${device.id} is now the fishpen monitor for ${device.owner_name}. Refresh the owner dashboard.`);
    if (!result.error) await refresh();
    setBusyDevice(null);
  };
  const replaceKey = async (device: Device) => {
    if (!device.owner_user_id || !window.confirm(`Replace the key for device #${device.id}? The current ESP32 key will stop working until you upload the new key to its firmware.`)) return;
    setBusyDevice(device.id);
    setReplacementKey(null);
    const result = await apiJson<{ deviceId: number; deviceKey: string }>(`/api/admin/owners/${device.owner_user_id}/device-key`, { method: "POST", body: "{}" });
    setMessage(result.error || "New key issued. Update the ESP32 firmware before monitoring resumes.");
    if (result.data) setReplacementKey({ deviceId: result.data.deviceId, key: result.data.deviceKey });
    setBusyDevice(null);
  };
  const ordered = [...devices].sort((a, b) => (b.last_reading_at ? new Date(b.last_reading_at).getTime() : 0) - (a.last_reading_at ? new Date(a.last_reading_at).getTime() : 0) || b.id - a.id);
  return <section className="card p-5"><h2 className="text-xl font-black text-slate-950">Sensor devices</h2><p className="mt-1 text-sm text-slate-600">A new owner gets one device key automatically. For older accounts, choose the device that is actually uploading. Selecting it disables that owner's other device keys but keeps all past readings.</p>
    {message && <p className="mt-3 text-sm font-semibold text-slate-700" role="status">{message}</p>}
    {replacementKey && <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm"><p className="font-bold">Replacement key for device #{replacementKey.deviceId}, shown once</p><code className="mt-2 block break-all">{replacementKey.key}</code><button className="soft-button mt-2" onClick={() => setReplacementKey(null)}>Hide key</button></div>}
    <div className="mt-4 space-y-2">{ordered.map((device) => <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3" key={device.id}><div><p className="font-bold text-slate-900">{device.device_name} · #{device.id}</p><p className="text-xs text-slate-600">{device.owner_name || "Unassigned"} · Last upload: {device.last_reading_at ? new Date(device.last_reading_at).toLocaleString("en-PH") : "None"}{Number(device.is_active) !== 1 ? " · Inactive" : ""}</p></div><div className="flex flex-wrap items-center gap-2">{device.monitoring_fishpen_id ? <><span className="text-sm font-bold text-teal-700">Fishpen monitor</span><button className="soft-button" disabled={busyDevice !== null} onClick={() => void replaceKey(device)}>Replace key</button></> : device.owner_user_id && Number(device.is_active) === 1 ? <button className="soft-button" disabled={busyDevice !== null} onClick={() => void useForFishpen(device)}>{busyDevice === device.id ? "Saving..." : "Use for fishpen"}</button> : null}</div></div>)}</div>
  </section>;
}



function AdminStat({ label, value }: { label: string; value: string | number }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-bold text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-black text-teal-700">{value}</p>
    </article>
  );
}
