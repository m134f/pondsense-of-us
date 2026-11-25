import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sensorTurbidityValue, compareSensorSamples, sensorConnectionState } from './lib/sensorDisplay';
import { SessionLoading } from './components/SessionLoading';
import { apiErrorMessage } from './lib/apiError';
import { OwnerLogin, OwnerPasswordChange, OwnerPasswordForm, sessionOwner, type OwnerSession } from './components/OwnerAuthentication';
import { AdminDeviceEnrollment, verifyAdminDevice } from './components/AdminDeviceSecurity';
import { AdminWorkspace, isAdminSection, type AdminAccount as AdminUser } from './components/AdminWorkspace';
import { farmerBrand } from './lib/farmerBrand';
import { HarvestWorkspace, type SavedHarvest } from './components/HarvestWorkspace';
import { FarmerLanguage, FarmerNavigation } from './components/FarmerNavigation';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  ChevronDown,
  Download,
  Droplets,
  Eye,
  Fish,
  History,
  Lock,
  LogOut,
  CalendarDays,
  Radio,
  Thermometer,
  Plus,
  User,
  X
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { activeSpecies, fishDatabase } from "./data/fish";
import { analyzeWaterQuality, detectRisks, feedingAdvice } from "./lib/decisionEngine";
import { rankPartialFish } from "./lib/partialFish";
import { historyFishFit } from "./lib/historyFishFit";
import { daysUntilHarvest, estimatedRemainingStock, harvestReminderDue, harvestStage, recentMortality, csvCell } from "./lib/harvest";
import { RecommendedActions, type WaterContext } from "./components/RecommendedActions";
import { HarvestReview } from "./components/HarvestReview";
import { FishpenSmsSettings, manualSmsPenKey } from "./components/FishpenSmsSettings";
import { ManualWaterForm } from "./components/ManualWaterForm";
import { ManualAssessment, ManualRecommendedActions } from "./components/ManualAssessment";
import { WaterQualityTrends } from './components/WaterQualityTrends';
import { manualParameters } from "./lib/manualValidation";
import { PublicMonitoring } from './components/PublicMonitoring';
import { measuredStatus, parameterStatus } from './lib/measurementStatus';
import { chartValue, classCGuidelines, classCSource, classCUrl } from './lib/waterGuidelines';
import { clearLegacyBrowserCredentials, storage, type AppUser } from "./lib/storage";
import type { AlertItem, AlertLevel, FishScore, FishSpecies, SessionRecord, WaterParams } from "./types";

type Lang = "en" | "tl";
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
  sampledAt?: string | null;
  receivedAt?: string;
};

type RequestState = 'loading' | 'ready' | 'error';

const SENSOR_OFFLINE_MS = 60_000;

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
  return (row.inputMode === 'manual' && row.ammonia == null) || farmerHistoryParameters.some(meta => row[meta.key] == null);
}

function historyFishDisplay(row: SessionRecord, fishDb: FishSpecies[], lang: Lang) {
  const fit = isPartialSession(row) && !row.bestFish && row.score == null ? historyFishFit(row, fishDb) : null;
  if (fit) return {
    fish: fit.hasMatch ? `${lang === 'tl' ? 'Paunang tugma' : 'Preliminary match'}: ${fit.fish}` :
      (lang === 'tl' ? 'Walang natukoy na angkop na isda' : 'No suitable fish identified'),
    score: `${fit.fit} ${lang === 'tl' ? 'nasukat' : 'measured'}`,
    note: fit.hasMatch ? null : (lang === 'tl' ? `Pinakamalapit sa saklaw: ${fit.fish}; walang sukat na pasok.` : `Closest by range: ${fit.fish}; no measured value is in range.`)
  };
  return { fish: row.bestFish || '--', score: row.score == null ? '--' : `${row.score}%`, note: null };
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
  const [historyState, setHistoryState] = useState<RequestState>('loading');
  const [historyAttempt, setHistoryAttempt] = useState(0);
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
  const [sensorState, setSensorState] = useState<RequestState>('loading');
  const [sensorTrend, setSensorTrend] = useState<SensorTelemetry[]>([]);
  const [trendState, setTrendState] = useState<RequestState>('loading');
  const retryTrendRef = useRef<(() => void) | null>(null);
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
    setHistoryState('loading');

    if (!currentUser) return () => {
      active = false;
    };

    apiJson<{ sessions: SessionRecord[] }>("/api/readings").then((result) => {
      if (!active) return;
      if (!result.data?.sessions) { setHistoryState('error'); return; }
      setHistoryState('ready');
      setSessions(result.data.sessions);
      storage.saveSessions(result.data.sessions, currentUser);
    });

    return () => {
      active = false;
    };
  }, [currentUser?.id, currentUser?.phone, path, historyAttempt]);

  useEffect(() => {
    if (!sensorTelemetry || !currentUser) return;
    const record: SessionRecord = {
      id: `sensor-${sensorTelemetry.id}`,
      timestamp: new Date(sensorTelemetry.recordedAt).toLocaleString("en-PH"),
      inputMode: "sensor",
      turbidityEstimated: false,
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
    setSensorState('loading');
    setTrendState('loading');
    setSensorTrend([]);

    if (!currentUser || currentUser.mustChangePassword || !currentUser.fishpenAssignment) {
      setSensorTelemetry(null);
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
        setSensorState('ready');
        setSensorTelemetry(result.data.telemetry);
        if (result.data.telemetry) {
          const latest = result.data.telemetry;
          setSensorTrend((previous) => previous.some((reading) => reading.id === latest.id)
            ? previous
            : [...previous, latest].sort(compareSensorSamples).slice(-60));
        }
      } else {
        failures += 1;
        setSensorState('error');
      }
      const delay = failures ? Math.min(30_000, 5_000 * 2 ** (failures - 1)) : Math.max(0, 5_000 - (Date.now() - startedAt));
      latestTimer = window.setTimeout(() => void loadLatest(), delay);
    };

    const loadTrend = async () => {
      if (!active || trendController) return;
      trendController = new AbortController();
      const timeout = window.setTimeout(() => trendController?.abort(), 8_000);
      const result = await apiJson<{ readings: SensorTelemetry[] }>("/api/sensors/trend", { signal: trendController.signal });
      window.clearTimeout(timeout);
      trendController = undefined;
      if (!active) return;
      if (Array.isArray(result.data?.readings)) {
        setTrendState('ready');
        setSensorTrend((previous) => {
          const merged = new Map(result.data!.readings.map((reading) => [reading.id, reading]));
          for (const reading of previous) merged.set(reading.id, reading);
          return [...merged.values()].sort(compareSensorSamples).slice(-60);
        });
      } else setTrendState('error');
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
    retryTrendRef.current = () => {
      if (!active || trendController) return;
      window.clearTimeout(trendTimer);
      setTrendState('loading');
      void loadTrend();
    };
    window.addEventListener("online", reconnect);

    return () => {
      active = false;
      window.clearTimeout(latestTimer);
      window.clearTimeout(trendTimer);
      latestController?.abort();
      trendController?.abort();
      retryTrendRef.current = null;
      window.removeEventListener("online", reconnect);
    };
  }, [currentUser?.id, currentUser?.phone, currentUser?.fishpenAssignment?.deviceId]);

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
    if (path === "/guide") navigate("/dashboard");
    window.scrollTo(0, 0);
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
      ["Date/Time", "pH", "Temp", "DO", "Turbidity", "Best Fish / Preliminary Match", "Score / Measured Fit", "Measured Parameter Status", "Coverage"],
      ...sessions.map((row) => [
        row.timestamp,
        row.ph,
        row.temperature,
        row.dissolvedOxygen,
        row.turbidity,
        historyFishDisplay(row, fishDb, 'en').fish,
        historyFishDisplay(row, fishDb, 'en').score,
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
    return <AdminRouter path={path} navigate={navigate} />;
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

  if (currentUser?.mustChangePassword) return <OwnerPasswordChange lang={lang} onDone={() => window.location.assign('/dashboard')} onLogout={async () => { await postJson('/api/logout', {}); storage.saveCurrentUser(null); setCurrentUser(null); navigate('/login'); }} />;
  if (currentUser && !currentUser.fishpenAssignment) return <main className="mx-auto max-w-lg space-y-4 p-6"><h1 className="text-xl font-bold">Fishpen assignment needed</h1><p>No fishpen is assigned to your account. Contact your administrator. / Ipa-assign muna sa administrator ang iyong fishpen.</p><button className="soft-button" onClick={() => window.location.reload()}>Check again</button><button className="soft-button" onClick={async () => { await postJson('/api/logout', {}); storage.saveCurrentUser(null); setCurrentUser(null); navigate('/login'); }}>Logout</button></main>;

  if (!currentUser) return <OwnerLogin navigate={navigate} onLogin={(user, message) => { setCurrentUser(user); storage.saveCurrentUser(user); setSms(message); navigate('/dashboard'); }} />;
  const farmerPath = ["/analysis", "/history", "/harvest", "/profile", "/profile/device-sms"].includes(path) ? path : "/dashboard";
  const logout = async () => {
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
  };

  return (
    <div className="farmer-shell min-h-screen bg-slate-100">
      {sms && (
        <button
          className="farmer-toast fixed inset-x-3 z-50 rounded-lg bg-slate-950 px-4 py-3 text-left text-sm font-medium text-white shadow-lg sm:inset-x-auto sm:right-5 sm:max-w-sm"
          onClick={() => setSms("")}
        >
          {sms}
        </button>
      )}

      <FarmerNavigation
        path={farmerPath}
        navigate={navigate}
        lang={lang}
        setLang={setLang}
        name={currentUser.fullName}
        fishpen={currentUser.fishpenAssignment?.name || ''}
        clockText={formattedClock(clock)}
        onLogout={logout}
      />

      <div className="farmer-workspace">
      {(farmerPath === "/dashboard" || farmerPath === "/analysis") && (
        <AnalysisPage
          key={currentUser?.id || 'guest'}
          ownerId={currentUser?.id}
          lang={lang}
          params={params}
          sensorTelemetry={sensorTelemetry}
          sensorState={sensorState}
          sensorTrend={sensorTrend}
          trendState={trendState}
          retryTrend={() => retryTrendRef.current?.()}
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
          onManualSaved={record => { setSessions(previous => { const next = [record, ...previous.filter(item => item.id !== record.id)].slice(0, 10); storage.saveSessions(next, currentUser); return next; }); }}
          onSelectFish={setSelectedFishId}
          text={text}
          showManual={farmerPath === '/analysis'}
          onModeChange={manual => navigate(manual ? '/analysis' : '/dashboard')}
        />
      )}

      {farmerPath === "/history" && (
        <HistoryPage sessions={sessions} requestState={historyState} onRetry={() => setHistoryAttempt(n => n + 1)} onExport={exportCsv} text={text} lang={lang} fishDb={fishDb} />
      )}

      {farmerPath === "/harvest" && <HarvestPage currentUser={currentUser} lang={lang} fishDb={fishDb} navigate={navigate} />}

      {farmerPath.startsWith('/profile') && <ProfilePage currentUser={currentUser} lang={lang} setLang={setLang} telemetry={sensorTelemetry} now={clock.getTime()} focusDevice={farmerPath === '/profile/device-sms'} onLogout={logout} onTestSms={hasAnalyzed && scores.length ? testSms : undefined} />}
      </div>

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
    <div><h2 className="flex items-center gap-2 text-lg font-bold text-slate-950"><Radio size={20} className="text-teal-700" aria-hidden="true" />{lang === 'tl' ? 'Aking Device' : 'My Device'}</h2><p className="mt-1 text-sm text-slate-600">{busy ? (lang === 'tl' ? 'Sinusuri...' : 'Checking...') : (lang === 'tl' ? 'Sensor na itinalaga ng administrator' : 'Monitoring device assigned by your administrator')}</p></div>
    {checked && <div className="mt-3 border-t border-slate-100 pt-3">
      {devices.length > 0 && <><p className="mb-2 text-xs font-semibold text-slate-500">{devices.length} {lang === "tl" ? "naka-assign na ESP32" : "assigned ESP32 device(s)"}</p><ul className="space-y-2 text-sm text-slate-700">{devices.map((device) => <li key={device.id} className="flex items-center justify-between gap-2"><span className="font-semibold">{device.deviceName} <span className="text-slate-500">#{device.id}</span></span><span className={`rounded-full px-2 py-1 text-xs font-bold ${live && telemetry?.deviceId === device.id ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{live && telemetry?.deviceId === device.id ? "Live" : (lang === "tl" ? "Walang bagong reading" : "No recent reading")}</span></li>)}</ul></>}
      {message && <p className="text-sm font-semibold text-slate-700" role="status">{message}</p>}
    </div>}
  </section>;
}

function AnalysisPage({
  onManualSaved,
  showManual,
  onModeChange,
  ownerId,
  lang,
  params,
  sensorTelemetry,
  sensorState,
  sensorTrend,
  trendState,
  retryTrend,
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
  onSelectFish,
  text
}: {
  onManualSaved: (record: SessionRecord) => void;
  showManual: boolean;
  onModeChange: (manual: boolean) => void;
  ownerId?: string;
  lang: Lang;
  params: WaterParams;
  sensorTelemetry: SensorTelemetry | null;
  sensorState: RequestState;
  sensorTrend: SensorTelemetry[];
  trendState: RequestState;
  retryTrend: () => void;
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
  onSelectFish: (id: string) => void;
  text: typeof ui.en;
}) {
  const [showParameterDetails, setShowParameterDetails] = useState(false);
  const [showAllActions, setShowAllActions] = useState(false);
  const sensorFresh = sensorState === 'ready' && sensorConnectionState(sensorTelemetry, now) === "live";
  const [manualResult, setManualResult] = useState<{ id: string; values: Partial<WaterParams> } | null>(null);
  const partialManual = manualResult?.values ?? null;
  const showManualResults = hasAnalyzed && scores.length > 0 && showManual && !partialManual;
  const submitManual = async (values: Partial<WaterParams>, manualSaveTime: string) => {
    const result = await postJson<{ saved: boolean; session: SessionRecord }>('/api/readings', { ...values, partialManual: true, manualSaveTime });
    if (result.error || !result.data?.saved || !result.data.session) {
      throw new Error(result.error || 'Manual test was not saved.', { cause: result.status });
    }
    const session = result.data.session;
    onManualSaved(session);
    const saved: Partial<WaterParams> = {};
    for (const key of manualParameters) if (session[key] !== null && session[key] !== undefined) saved[key] = session[key];
    setManualResult({ id: session.id, values: saved });
  };

  return (
    <main className={`farmer-analysis ${showManual ? "manual-mode" : "monitoring-mode"} mx-auto grid max-w-[1500px] grid-cols-1 gap-5 px-4 pb-8 sm:px-6`}>
      <div className="analysis-heading flex flex-wrap items-center justify-between gap-4 py-4">
        <div><h1>{showManual ? (lang === 'tl' ? 'Pagsusuri' : 'Analysis') : (lang === 'tl' ? 'Pagsubaybay sa Tubig' : 'Water Monitoring')}</h1><p className="mt-1 text-slate-600">{showManual ? (lang === 'tl' ? 'Manu-manong pagsusuri at paghahambing ng isda.' : 'Manual water testing and fish suitability comparison.') : (lang === 'tl' ? 'Mga sukat, kalagayan ng sensor at rekomendasyon.' : 'Sensor readings, water conditions, and recommended actions.')}</p></div>
        <div role="group" className={showManual ? 'manual-mode-switch' : 'flex rounded-lg border border-slate-300 bg-white p-1'} aria-label={lang === 'tl' ? 'Uri ng pagsusuri' : 'Analysis mode'}>
          {[false, true].map(manual => <button key={String(manual)} aria-pressed={showManual === manual} onClick={() => { if (showManual !== manual) onModeChange(manual); }} className={`min-h-11 rounded-md px-3 text-sm font-semibold ${showManual === manual ? "bg-teal-700 text-white" : "text-slate-600"}`}>{showManual && (manual ? <Activity size={16} aria-hidden="true" /> : <Radio size={16} aria-hidden="true" />)}{manual ? (lang === 'tl' ? 'Manu-mano' : 'Manual test') : (lang === 'tl' ? 'Mga sensor' : 'Monitoring')}</button>)}
        </div>
      </div>
      {!showManual && <LiveMonitoringOverview telemetry={sensorTelemetry} requestState={sensorState} lang={lang} now={now} onManual={() => onModeChange(true)} />}
      {showManual && <aside className="analysis-inputs space-y-4">
        <ManualWaterForm lang={lang} fish={fishDb} onAnalyze={submitManual} />
        {showManualResults && <FeedingCard params={params} lang={lang} text={text} />}
      </aside>}

      <section className="analysis-results min-w-0 space-y-5">
        {ownerId && !showManual && <div id="farmer-recommended-actions"><RecommendedActions lang={lang} snapshot={sensorFresh ? sensorTelemetry : null} now={now} refreshKey={`${sensorTelemetry?.id || 0}:${sessions[0]?.id || ""}`} /></div>}
        {showManual && partialManual && <ManualAssessment values={partialManual} lang={lang} />}
        {!showManual || partialManual ? null : showManualResults ? (
          <>
            <p className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm font-semibold text-sky-900">{lang === "tl" ? "Manu-manong analysis ito, hindi galing sa ESP32." : "Manual analysis only. These values did not come from the ESP32."}</p>
            <AlertBanner alert={alerts[0]} lang={lang} />
            <SummaryBanner status={currentStatus} lang={lang} />
            <WhatToDoNow alerts={alerts} status={currentStatus} lang={lang} />
            <QuickStatusCards lang={lang} params={params} />
            {sessions.length > 0 && <DashboardTrends sessions={sessions} text={text} lang={lang} />}
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
        <aside className="analysis-comparison card h-fit space-y-3 p-5">
          <h2 className="font-black">{lang === "tl" ? "Paunang paghahambing ng isda" : "Preliminary fish comparison"}</h2>
          <div className="flex flex-wrap items-center gap-2"><span className={`rounded-md px-2 py-1 text-xs font-bold ${badgeClasses(sensorMeasuredStatus(sensorTelemetry))}`}>{statusText(sensorMeasuredStatus(sensorTelemetry), lang)}</span><span className="text-xs text-slate-600">{sensorTelemetry.turbidityNtu === null ? (lang === 'tl' ? 'Bahagyang pagsusuri; walang DO reading at hindi kasama ang tantiya sa turbidity.' : 'Partial assessment; DO is missing and estimated turbidity is excluded.') : (lang === 'tl' ? 'Bahagyang pagsusuri; walang DO reading.' : 'Partial assessment; DO is missing.')}</span></div>
          {!sensorFresh && <p className="rounded-md bg-amber-50 p-3 text-sm font-semibold text-amber-900">{lang === 'tl' ? 'Batay sa huling sukat, hindi live. Kumuha ng bagong sukat bago magpasya.' : 'Based on the last reading, not live. Obtain fresh measurements before making decisions.'}</p>}
          {(() => {
            const readings = { ph: sensorTelemetry.ph, temperature: sensorTelemetry.temperatureC, turbidity: sensorTelemetry.turbidityNtu };
            const measured = Object.entries(readings).filter(([, value]) => value !== null && Number.isFinite(value));
            const ranked = rankPartialFish(fishDb.filter(fish => activeSpecies.some(species => species.id === fish.id)), readings);
            if (!measured.length) return <p className="text-sm text-slate-600">{lang === "tl" ? "Wala pang beripikadong sukat para ihambing ang isda." : "No verified measurements yet for fish comparison."}</p>;
            return <>
              {sensorTelemetry.turbidityNtu === null && <p className="text-sm text-slate-600">{lang === 'tl' ? 'Hindi kasama ang tantyang turbidity sa paghahambing; kailangan muna ng calibration.' : 'Estimated turbidity is excluded from comparison until calibrated.'}</p>}
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
        <section className="analysis-comparison card manual-ranking h-fit min-w-0 p-4 sm:p-5" aria-labelledby="manual-ranking-heading">
          <h2 id="manual-ranking-heading" className="text-lg font-bold">{lang === "tl" ? "Paunang ranggo ng mga isda" : "Fish suitability ranking"}</h2>
          {(() => {
            const ranked = rankPartialFish(fishDb.filter(fish => activeSpecies.some(species => species.id === fish.id)), partialManual);
            const measuredCount = Object.values(partialManual).filter(value => value !== null && Number.isFinite(value)).length;
            const tied = (a: typeof ranked[number], b: typeof ranked[number]) => a.matches.length === b.matches.length && Math.abs(a.distance - b.distance) < 0.000001;
            const leaders = ranked.filter(item => ranked[0] && tied(item, ranked[0]));
            const noMatch = leaders.length > 0 && leaders[0].matches.length === 0;
            return <>
              {noMatch && <div className="manual-ranking-note text-sm text-slate-600">
                <AlertTriangle size={16} aria-hidden="true" />
                <p className="font-semibold">{lang === 'tl' ? 'Walang natukoy na angkop na isda batay sa mga nasukat' : 'No suitable fish identified from the measured parameters'}</p>
              </div>}
              {!noMatch && leaders.length > 0 && <p className="border-l-4 border-teal-600 bg-teal-50 p-3 text-sm font-semibold text-teal-950">
                {lang === 'tl' ? `${leaders.length > 1 ? 'Magkakatabla sa unang puwesto' : 'Pinakamalapit sa nasukat'}: ${leaders.map(item => item.fish.name).join(', ')}. ${leaders[0].matches.length} sa ${measuredCount} sukat ang pasok. Hindi pa ito kumpirmadong ligtas na ilagay sa fishpen.` : `${leaders.length > 1 ? 'Tied for top measured fit' : 'Top measured fit'}: ${leaders.map(item => item.fish.name).join(', ')}. ${leaders[0].matches.length} of ${measuredCount} measurements in range. This does not confirm the fish is safe to stock.`}
              </p>}
              {!leaders.length && <p className="text-sm text-slate-600">{lang === 'tl' ? 'Walang species na maihahambing sa ngayon.' : 'No species are available for comparison.'}</p>}
              <div className="manual-fish-list">{ranked.map((item, index) => {
                const rank = ranked.findIndex(other => tied(other, item)) + 1;
                const fit = item.matches.length === 0 ? 'none' : item.matches.length === measuredCount ? 'measured' : 'partial';
                return <details key={`${manualResult?.id}:${item.fish.id}`} className="manual-fish-row manual-disclosure">
                  <summary>
                    <strong className="manual-fish-name"><span className="sr-only">#{rank} </span>{item.fish.name}</strong>
                    <span className="manual-fish-count">{lang === 'tl' ? `${item.matches.length} sa ${measuredCount} sukat ang pasok` : `${item.matches.length} of ${measuredCount} measurements in range`}</span>
                    <span className="manual-fish-fit" data-fit={fit}>{fit === 'none' ? (lang === 'tl' ? 'Walang pasok' : 'No match') :
                      fit === 'partial' ? (lang === 'tl' ? 'Bahagyang tugma' : 'Partial match') : (lang === 'tl' ? 'Pasok ang nasukat' : 'Measured fit')}</span>
                    <ChevronDown size={17} className="manual-disclosure-chevron" aria-hidden="true" />
                  </summary>
                  <div className="manual-disclosure-content text-sm">
                    <dl className="space-y-1">
                      {item.checks.map(check => {
                        const label = parameterMeta.find(meta => meta.key === check.key)?.label[lang] ?? check.key;
                        const unit = check.key === 'temperature' ? ' °C' : check.key === 'turbidity' ? ' NTU' : check.key === 'ph' ? '' : ' mg/L';
                        const within = check.result === 'within';
                        const known = check.result !== 'unknown';
                        return <div key={check.key} className="flex flex-wrap justify-between gap-x-2">
                          <dt className="font-medium">{label}: {check.value}{unit}</dt>
                          <dd className="text-slate-700">{!known ? (lang === 'tl' ? 'Walang beripikadong saklaw' : 'No verified range') : <>{within ? (lang === 'tl' ? 'Pasok sa saklaw' : 'Within range') : (lang === 'tl' ? 'Labas sa saklaw' : 'Outside range')} ({check.min}–{check.max}{unit})</>}</dd>
                        </div>;
                      })}
                    </dl>
                    {noMatch && <p className="mt-2 text-xs text-slate-600">{lang === 'tl' ? 'Batay sa lapit sa saklaw ang ranggo, hindi rekomendasyon na mag-stock.' : 'Ranked by closeness to range, not recommended for stocking.'}</p>}
                    {index > 0 && tied(item, ranked[index - 1]) && <p className="mt-2 text-xs text-slate-600">{lang === 'tl' ? 'Tabla sa nasa itaas; nakaayos ayon sa pangalan.' : 'Tied with the fish above; listed alphabetically.'}</p>}
                  </div>
                </details>;
              })}</div>
            </>;
          })()}
        </section>
      ) : showManual && showManualResults ? (
        <aside className="analysis-comparison space-y-3">
          <FishRankingPanel scores={scores} selectedId={selectedScore.fish.id} onSelectFish={onSelectFish} lang={lang} text={text} />
          <p className="text-sm">Mamali: {lang === "tl" ? "hinihintay ang beripikadong saklaw" : "threshold validation pending"}.</p>
        </aside>
      ) : null}
      {showManual && manualResult && <ManualRecommendedActions key={manualResult.id} values={manualResult.values} lang={lang} />}
      {!showManual && <WaterQualityTrends readings={sensorTrend} state={trendState} now={now} lang={lang} onRetry={retryTrend}
        connection={sensorState === 'loading' ? 'checking' : sensorState === 'error' ? 'unverified' : !sensorTelemetry ? 'no-upload' : sensorConnectionState(sensorTelemetry, now)} />}
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

function LiveMonitoringOverview({ telemetry, requestState, lang, now, onManual }: { telemetry: SensorTelemetry | null; requestState: RequestState; lang: Lang; now: number; onManual: () => void }) {
  const tl = lang === 'tl';
  const connection = sensorConnectionState(telemetry, now);
  const live = connection === 'live';
  const measured = telemetry ? sensorMeasuredStatus(telemetry) : 'partial';
  const lastUpload = telemetry ? Date.parse(telemetry.receivedAt || telemetry.recordedAt) : NaN;
  const online = Number.isFinite(lastUpload) && Math.max(0, now - lastUpload) < SENSOR_OFFLINE_MS;
  const connectionLabel = requestState === 'loading' ? (tl ? 'Sinusuri...' : 'Checking...') : requestState === 'error' ? (tl ? 'Hindi makumpirma' : 'Unable to verify') : telemetry ? (online ? 'Online' : 'Offline') : (tl ? 'Wala pang upload' : 'No upload yet');
  const timestampUnknown = telemetry?.sampledAt === null;
  const freshness = timestampUnknown ? (tl ? 'Hindi alam ang oras ng sukat' : 'Sample time unknown') : live && requestState !== 'error' ? 'Live' : telemetry ? (tl ? 'Lumang sukat' : 'Stale') : (tl ? 'Wala pang sukat' : 'No measurement');
  const partialSafe = measured === 'safe';
  const assessment = live && requestState === 'ready' ? (partialSafe ? (tl ? 'Pasok ang mga nasukat' : 'Measured values in range') : statusText(measured, lang)) : (tl ? 'Walang live na pagtatasa' : 'No live assessment');
  const hasAssessment = live && requestState === 'ready' && measured !== 'partial';
  const hasTurbiditySignal = telemetry !== null && Number.isFinite(telemetry.rawValue) && telemetry.rawValue >= 0 && telemetry.rawValue <= 4095;
  const cards = [
    { label: 'pH', key: 'ph', value: telemetry?.ph ?? null, unit: '', decimals: 2, Icon: Droplets },
    { label: tl ? 'Temperatura' : 'Temperature', key: 'temperature', value: telemetry?.temperatureC ?? null, unit: ' °C', decimals: 1, Icon: Thermometer },
    { label: 'Dissolved oxygen', key: 'dissolvedOxygen', value: null, unit: ' mg/L', decimals: 1, Icon: Droplets },
    { label: tl ? 'Labo ng tubig' : 'Turbidity', key: 'turbidity', value: telemetry && (telemetry.turbidityNtu !== null || hasTurbiditySignal) ? sensorTurbidityValue(telemetry) : null, unit: ' NTU', decimals: 0, Icon: Droplets, estimated: telemetry?.turbidityNtu === null },
  ] as const;
  const tone = live && requestState === 'ready' && measured !== 'partial' ? measured : 'neutral';
  const ConditionIcon = tone === 'safe' ? Activity : tone === 'neutral' ? Activity : AlertTriangle;
  return <section className="monitor-overview" aria-label={tl ? 'Kasalukuyang mga sukat' : 'Current measurements'}>
    <div className="monitor-summary">
      <div className={`monitor-summary-card monitor-condition-${tone}`}><ConditionIcon size={28} aria-hidden="true" /><div><h2>{tl ? 'Kalagayan ng tubig' : 'Water Condition'}</h2><strong>{assessment}</strong><p>{hasAssessment ? (tl ? 'Bahagyang pagtatasa' : 'Partial assessment') : (tl ? 'Walang napapanahong sukat' : 'No current measurements')}</p></div></div>
      <div className="monitor-summary-card"><CalendarDays size={27} aria-hidden="true" /><div><h2>{timestampUnknown ? (tl ? 'Huling natanggap' : 'Last Received') : (tl ? 'Huling sukat' : 'Last Measurement')}</h2><p>{telemetry && Number.isFinite(Date.parse(telemetry.recordedAt)) ? `${new Date(telemetry.recordedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} (PHT)` : '—'}</p><p className="font-semibold">{freshness}</p></div></div>
      <div className="monitor-summary-card"><Radio size={27} aria-hidden="true" /><div><h2>{tl ? 'Kalagayan ng device' : 'Device Status'}</h2><p>{telemetry ? `${telemetry.deviceName} · #${telemetry.deviceId} · ` : ''}{connectionLabel}</p></div></div>
    </div>
    <div className="monitor-measurements">
      {cards.map(card => {
        const { label, key, value, unit, decimals, Icon } = card;
        const estimated = 'estimated' in card && card.estimated;
        const valid = typeof value === 'number' && Number.isFinite(value) && (estimated || chartValue(key, value) !== null);
        const status = valid && !estimated && hasAssessment ? statusFor(key, value) : null;
        return <article className="monitor-metric" key={key}><h2><Icon size={19} aria-hidden="true" />{label}</h2><strong>{!valid ? '—' : `${estimated ? '~' : ''}${key === 'turbidity' ? value : value.toFixed(decimals)}${unit}`}</strong>
          {status && <span className={measurementBadge(status)}>{shortStatusText(status, lang)}</span>}
          <p>{value === null ? (tl ? 'Walang sukat' : 'Missing') : !valid ? (tl ? 'Hindi wastong sukat' : 'Invalid reading') : estimated ? `${tl ? 'Tantiya' : 'Estimated'} · ${freshness}` : freshness}</p></article>;
      })}
      <article className={`monitor-metric monitor-priority ${hasAssessment ? '' : 'monitor-priority-neutral'}`}><h2>{hasAssessment ? <AlertTriangle size={19} aria-hidden="true" /> : <Activity size={19} aria-hidden="true" />}{tl ? 'Susunod na Hakbang' : 'Next Step'}</h2><p>{!hasAssessment ? (tl ? 'Walang kasalukuyang sukat mula sa sensor. Itala ang manu-manong sukat kung mayroon.' : 'No current sensor assessment. Record a manual measurement when available.') : tl ? 'Tingnan ang gabay para sa mga nasukat.' : 'Review the guidance for your measured values.'}</p>{hasAssessment ? <a href="#farmer-recommended-actions">{tl ? 'Tingnan ang mga hakbang' : 'View sensor recommendations'}</a> : <button className="soft-button mt-2" onClick={onManual}>{tl ? 'Manu-manong pagsusuri' : 'Open manual test'}</button>}</article>
    </div>
    <p className="text-sm text-slate-600">{tl ? 'Ang nawawalang sukat ay hindi zero. Hindi sapat ang bahagyang sukat para masabing ligtas ang buong tubig.' : 'Missing readings are not zero. Partial readings do not confirm overall water safety.'}</p>
  </section>;
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
  sessions,
  text,
  lang
}: {
  sessions: SessionRecord[];
  text: typeof ui.en;
  lang: Lang;
}) {
  const tl = lang === 'tl';
  const chartData = [...sessions].reverse();
  const data = chartData.map(row => ({ ...row,
    ph: chartValue('ph', row.ph), temperature: chartValue('temperature', row.temperature),
    dissolvedOxygen: chartValue('dissolvedOxygen', row.dissolvedOxygen),
    turbidity: chartValue('turbidity', row.turbidity, Boolean(row.turbidityEstimated))
  }));
  const trendCards = [
    { key: "ph", label: "pH", color: "#0d9488", domain: [4, 11] },
    { key: "temperature", label: tl ? 'Temperatura (°C)' : 'Temperature (°C)', color: "#b45b13", domain: [10, 40] },
    { key: "dissolvedOxygen", label: "DO (mg/L)", color: "#2563eb", domain: [0, 15] },
    { key: "turbidity", label: tl ? 'Labo ng tubig (NTU)' : 'Turbidity (NTU)', color: "#736346", domain: [0, 500] },
  ] as const;

  return (
    <section aria-label={text.trendTitle}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-black text-slate-950">
            <BarChart3 className="text-teal-600" size={22} /> {text.trendTitle}
          </h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            {tl ? `${sessions.length} na naitalang sukat` : `${sessions.length} saved readings`}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        {trendCards.map((card) => (
          <article key={card.key} className="min-w-0 rounded-lg border border-slate-200 bg-white p-3 sm:p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-black uppercase tracking-wide text-slate-600">{card.label}</h3>
            </div>
            {data.some(row => row[card.key] !== null) ? <div className="mt-3 h-32 sm:h-40">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="timestamp" hide />
                  <YAxis domain={card.domain} width={34} tick={{ fontSize: 11 }} />
                  <Tooltip />
                   {classCGuidelines[card.key]?.min !== undefined && <ReferenceLine y={classCGuidelines[card.key]?.min} stroke="#334155" strokeDasharray="4 4" />}
                   {classCGuidelines[card.key]?.max !== undefined && <ReferenceLine y={classCGuidelines[card.key]?.max} stroke="#334155" strokeDasharray="4 4" />}
                  <Line
                    type="monotone"
                    dataKey={card.key}
                    stroke={card.color}
                    strokeWidth={3}
                     dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                     connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div> : <p className="my-5 text-sm text-slate-600">{tl ? 'Walang wastong naitalang sukat.' : 'No valid saved measurements.'}</p>}
             <p className="mt-2 text-xs text-slate-600">{card.key === 'turbidity' ? 'No verified official LLDA NTU limit; no guideline line.' : `Dashed: Class C freshwater ${classCGuidelines[card.key]?.min}${classCGuidelines[card.key]?.max !== undefined ? `–${classCGuidelines[card.key]?.max}` : ' minimum'} ${classCGuidelines[card.key]?.unit}.`}</p>
          </article>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-600">Only finite, in-range recorded values are plotted; missing, invalid, and estimated values leave gaps. Older saved readings may be stale and are not live. Dashed lines are environmental guidelines, not fish suitability or operational Critical thresholds. <a className="underline" href={classCUrl} target="_blank" rel="noreferrer">{classCSource}</a>. DO guideline applies to official daytime sampling (9 AM–4 PM).</p>
    </section>
  );
}

function historyMeasurements(row: SessionRecord): [string, string | number | null][] {
  return [
    ["pH", row.ph],
    ["Temperature", row.temperature == null ? "--" : `${row.temperature} °C`],
    ["DO", row.dissolvedOxygen == null ? "--" : `${row.dissolvedOxygen} mg/L`],
    ["Turbidity", row.turbidity == null ? "--" : `${row.turbidityEstimated ? '~' : ''}${row.turbidity} NTU${row.turbidityEstimated ? ' (est.)' : ''}`],
    ["Ammonia", row.ammonia == null ? "--" : `${row.ammonia} mg/L`]
  ];
}

function HistoryPage({ sessions, requestState, onRetry, onExport, text, lang, fishDb }: { sessions: SessionRecord[]; requestState: RequestState; onRetry: () => void; onExport: () => void; text: typeof ui.en; lang: Lang; fishDb: FishSpecies[] }) {
  const tl = lang === 'tl';
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState('all');
  const [record, setRecord] = useState<SessionRecord | null>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (record && !detailDialog.current?.open) detailDialog.current?.showModal(); }, [record]);
  const detailLabel = lang === 'tl' ? 'Tingnan ang tala' : 'View record';
  const recordStatus = (status: AlertLevel | 'partial') => status === 'partial' ? (tl ? 'Bahagya' : 'Partial') : shortStatusText(status, lang);
  const sourceLabel = (row: SessionRecord) => row.inputMode === 'manual' ? (tl ? 'Manu-manong pagsusuri' : 'Manual Analysis') : row.inputMode === 'sensor' ? (tl ? 'Tala ng sensor' : 'Sensor Reading') : (tl ? 'Di-tiyak ang pinagmulan' : 'Unknown source');
  const sourceBadge = (row: SessionRecord) => <span className="history-source" data-source={row.inputMode}>{sourceLabel(row)}</span>;
  const partialLabel = tl ? 'Bahagyang pagsusuri · sinukat lamang' : 'Partial assessment · measured values only';
  const counts = sessions.reduce(
    (acc, row) => {
      acc[historyStatus(row)] += 1;
      return acc;
    },
    { safe: 0, warning: 0, critical: 0, partial: 0 }
  );
  const filteredSessions = sessions.filter((row) => {
    const status = historyStatus(row);
    const haystack = `${row.timestamp} ${historyFishDisplay(row, fishDb, lang).fish} ${status} ${sourceLabel(row)}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase()) && (sourceFilter === 'all' || row.inputMode === sourceFilter) && (statusFilter === 'all' || statusFilter === 'partial' && isPartialSession(row) || status === statusFilter);
  });
  const noResults = sessions.length ? (tl ? 'Walang tumugmang tala sa mga filter.' : 'No records match your filters.') : text.noHistory;
  return (
    <main className="space-y-5">
      <header><h1>{text.history}</h1><p className="mt-1 text-slate-600">{lang === 'tl' ? 'Mga sukat ng tubig at resulta ng pagsusuri.' : 'Water measurements and analysis results.'}</p></header>
      {requestState === 'loading' && <p role="status" className="text-sm text-slate-600">{tl ? 'Kinukuha ang mga tala...' : 'Loading sessions...'}</p>}
      {requestState === 'error' && <div role="alert" className="farmer-alert farmer-alert-error"><p>{tl ? 'Hindi makuha ang pinakabagong mga tala.' : 'Could not refresh session history.'} {sessions.length > 0 && (tl ? 'Ipinapakita ang dating nakuha sa device.' : 'Showing the available saved readings.')}</p><button className="soft-button" onClick={onRetry}>{tl ? 'Subukan muli' : 'Try again'}</button></div>}
      {(sessions.length > 0 || requestState === 'ready') &&
      <section>
        <div className="history-counts">
          <span className="bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800">{tl ? 'Pasok sa saklaw' : 'Safe'} {counts.safe}</span>
          <span className="bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800">{tl ? 'Babala' : 'Warning'} {counts.warning}</span>
          <span className="bg-red-50 px-3 py-2 text-sm font-bold text-red-800">{tl ? 'Kritikal' : 'Critical'} {counts.critical}</span>
          <span className="bg-white px-3 py-2 text-sm font-bold text-slate-700">{tl ? 'Bahagya' : 'Partial'} {sessions.filter(isPartialSession).length}</span>
        </div>
        <p className="mt-3 text-sm text-slate-600">{lang === 'tl' ? 'Ang Safe, Warning, at Critical ay para lamang sa mga sinukat na parameter. Hindi kinukumpirma ng bahagyang pagsusuri na ligtas ang buong tubig.' : 'Safe, Warning, and Critical describe measured parameters only. A partial test does not confirm overall water safety.'}</p>
        <p className="mt-1 text-sm text-slate-600">{lang === 'tl' ? 'Ang paunang tugma at measured fit ay kinuwenta mula sa naitalang sukat gamit ang kasalukuyang fish ranges; hindi ito naka-save na full score o pahintulot nang mag-stock.' : 'Preliminary match and measured fit are calculated from saved readings using current fish ranges; they are not saved full scores or stocking approval.'}</p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex flex-1 flex-col gap-2 sm:flex-row">
            <input
              className="min-h-11 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-4 py-2 outline-none focus:border-teal-600"
              placeholder={tl ? 'Hanapin ang isda, petsa o status...' : 'Search fish, date, status...'}
              aria-label={lang === "tl" ? "Hanapin ang tala" : "Search records"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-800"
              value={statusFilter}
              aria-label={lang === "tl" ? "Salain ayon sa kalagayan" : "Filter by status"}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">{tl ? 'Lahat ng status' : 'All statuses'}</option>
              <option value="safe">{tl ? 'Pasok sa saklaw' : 'Safe'}</option>
              <option value="warning">{tl ? 'Babala' : 'Warning'}</option>
              <option value="critical">{tl ? 'Kritikal' : 'Critical'}</option>
              <option value="partial">{tl ? 'Bahagyang sukat' : 'Partial'}</option>
            </select>
            <select className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-800" aria-label={tl ? 'Salain ayon sa pinagmulan' : 'Filter by source'} value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}>
              <option value="all">{tl ? 'Lahat ng pinagmulan' : 'All sources'}</option>
              <option value="manual">{tl ? 'Manu-manong pagsusuri' : 'Manual tests'}</option>
              <option value="sensor">{tl ? 'Mga tala ng sensor' : 'Sensor readings'}</option>
            </select>
          </div>
          <button className="soft-button" disabled={!sessions.length} onClick={onExport}>
            <Download size={16} /> {text.exportCsv}
          </button>
        </div>
        <p className="mt-3 text-sm font-semibold text-slate-600" role="status">{tl ? `${filteredSessions.length} sa ${sessions.length} na tala` : `${filteredSessions.length} of ${sessions.length} records shown`}</p>
        {filteredSessions.length ? <>
        <div className="mt-5 space-y-3 sm:hidden">
          {filteredSessions.map(row => <article key={row.id} className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">{row.timestamp}</h3><span className={measurementBadge(historyStatus(row))}>{recordStatus(historyStatus(row))}</span></div>
            <div className="mt-1">{sourceBadge(row)}</div>
            {row.turbidityEstimated && row.turbidity !== null && <p className="text-sm text-amber-800">{lang === 'tl' ? 'Tantya lamang ang turbidity; hindi kasama sa status.' : 'Turbidity is an estimate; excluded from status.'}</p>}
            {isPartialSession(row) && <p className="mt-1 text-sm text-slate-600">{partialLabel}</p>}
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              {historyMeasurements(row).map(([label, value]) => <div key={label}><dt className="text-slate-600">{label}</dt><dd className="font-semibold">{value ?? '—'}</dd></div>)}
            </dl><p className="mt-3 border-t border-slate-100 pt-3 font-semibold">{historyFishDisplay(row, fishDb, lang).fish} · {historyFishDisplay(row, fishDb, lang).score}</p>
            {historyFishDisplay(row, fishDb, lang).note && <p className="mt-1 text-xs text-amber-800">{historyFishDisplay(row, fishDb, lang).note}</p>}
            <button className="soft-button mt-3" onClick={() => setRecord(row)}><Eye size={17} />{detailLabel}</button>
          </article>)}
        </div>
        <div className="farmer-table-frame mt-5 hidden sm:block" tabIndex={0} aria-label={text.history}>
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr>
                <th className="px-4 py-3">{text.dateTime}</th>
                <th className="px-4 py-3">pH</th>
                <th className="px-4 py-3">Temp (°C)</th>
                <th className="px-4 py-3">DO (mg/L)</th>
                <th className="px-4 py-3">Turbidity (NTU)</th>
                <th className="px-4 py-3">Best Fish</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">{text.status}</th>
                <th>{lang === 'tl' ? 'Aksyon' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody>
              {filteredSessions.map((row) => {
                const status = historyStatus(row);
                const fishDisplay = historyFishDisplay(row, fishDb, lang);
                return (
                  <tr key={row.id} className="border-b border-slate-100">
                    <td className="px-4 py-3 font-semibold text-slate-700">{row.timestamp}<div className="mt-1">{sourceBadge(row)}</div></td>
                    <td className="px-4 py-3">{row.ph ?? '--'}</td>
                    <td className="px-4 py-3">{row.temperature ?? '--'}</td>
                    <td className="px-4 py-3">{row.dissolvedOxygen ?? '--'}</td>
                    <td className="px-4 py-3">{row.turbidity == null ? '--' : row.turbidityEstimated ? `~${row.turbidity} (est.)` : row.turbidity}</td>
                    <td className="px-4 py-3 font-bold">{fishDisplay.fish}{fishDisplay.note && <span className="mt-1 block text-xs font-normal text-amber-800">{fishDisplay.note}</span>}</td>
                    <td className="px-4 py-3 font-black text-teal-700">{fishDisplay.score}</td>
                    <td className="px-4 py-3">
                      <span className={measurementBadge(status)}>{recordStatus(status)}</span>
                      {isPartialSession(row) && <span className="mt-1 block text-xs text-slate-600">{partialLabel}</span>}
                    </td>
                    <td><button className="farmer-icon-button" type="button" title={detailLabel} aria-label={`${detailLabel}: ${row.timestamp}`} onClick={() => setRecord(row)}><Eye size={18} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </> : <p className="card mt-4 p-5 text-sm text-slate-600">{noResults}</p>}
      </section>}
      {sessions.length > 0 && <details className="farmer-history-trends"><summary>{tl ? 'Mga trend sa kalidad ng tubig' : 'Historical water quality charts'}</summary><DashboardTrends sessions={sessions} text={text} lang={lang} /></details>}
      <dialog className="farmer-record-dialog" ref={detailDialog} onClose={() => setRecord(null)} aria-labelledby="water-record-title">
        {record && <><div className="flex items-start justify-between gap-3"><div><h2 id="water-record-title" className="text-xl font-bold">{lang === 'tl' ? 'Tala ng Pagsukat' : 'Measurement Record'}</h2><p>{record.timestamp}</p></div><form method="dialog"><button title={lang === 'tl' ? 'Isara' : 'Close'} aria-label={lang === 'tl' ? 'Isara' : 'Close'} className="farmer-icon-button" autoFocus><X size={20} /></button></form></div>
          <dl className="my-4 grid grid-cols-2 gap-3">{historyMeasurements(record).map(([label, value]) => <div key={label}><dt className="text-sm text-slate-600">{label}</dt><dd className="font-semibold">{value ?? '—'}</dd></div>)}</dl>
          <div className="flex flex-wrap items-center gap-2">{sourceBadge(record)}<span className={measurementBadge(historyStatus(record))}>{statusText(historyStatus(record), lang)}</span></div>
          {isPartialSession(record) && <p className="mt-2 text-sm text-slate-600">{partialLabel}</p>}
          <p className="mt-3 font-semibold">{historyFishDisplay(record, fishDb, lang).fish} · {historyFishDisplay(record, fishDb, lang).score}</p><p className="text-sm text-slate-600">{historyFishDisplay(record, fishDb, lang).note}</p></>}
      </dialog>
    </main>
  );
}


function AuthPage({ navigate, onLogin }: { initialMode?: 'login' | 'register'; text: typeof ui.en; navigate: (path: string) => void; onLogin: (user: AppUser, message: string) => void }) {
  return <OwnerLogin navigate={navigate} onLogin={onLogin} />;
}

function ProfilePage({ currentUser, lang, setLang, telemetry, now, focusDevice, onLogout, onTestSms }: { currentUser: AppUser; lang: Lang; setLang: (lang: Lang) => void; telemetry: SensorTelemetry | null; now: number; focusDevice: boolean; onLogout: () => void; onTestSms?: () => void }) {
  const tl = lang === 'tl';
  const deviceSection = useRef<HTMLDivElement>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);
  useEffect(() => {
    if (!focusDevice) return;
    const frame = requestAnimationFrame(() => { deviceSection.current?.focus({ preventScroll: true }); deviceSection.current?.scrollIntoView({ block: 'start' }); });
    return () => cancelAnimationFrame(frame);
  }, [focusDevice]);
  return <main className="space-y-6">
    <header><h1>{tl ? 'Account at Settings' : 'Account & Settings'}</h1><p className="mt-1 text-slate-600">{currentUser.fishpenAssignment?.name}</p></header>
    <div className="farmer-account-grid">
      <div className="space-y-4">
        <section className="card p-5">
          <h2 className="flex items-center gap-2 text-lg font-bold"><User size={20} className="text-teal-700" />{tl ? 'Aking Profile' : 'My Profile'}</h2>
          <dl className="mt-3 divide-y divide-slate-200">
            {[[tl ? 'Pangalan' : 'Name', currentUser.fullName], [tl ? 'Numero ng cellphone' : 'Mobile number', currentUser.phone], [tl ? 'Tungkulin' : 'Role', currentUser.role === 'farmer' ? (tl ? 'Tagapamahala ng fishpen' : 'Fishpen operator') : currentUser.role], ['Fishpen', currentUser.fishpenAssignment?.name]].map(([label, value]) => <div key={label} className="grid gap-1 py-3 sm:grid-cols-2"><dt className="text-slate-600">{label}</dt><dd className="break-words font-semibold">{value || '—'}</dd></div>)}
          </dl>
        </section>
        <section className="card p-5"><h2 className="mb-3 text-lg font-bold">{tl ? 'Wika' : 'Language'}</h2><FarmerLanguage lang={lang} setLang={setLang} /></section>
        <section className="card p-5">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Lock size={19} className="text-teal-700" />{tl ? 'Password at Seguridad' : 'Password & Security'}</h2>
          {passwordSaved && <p role="status" className="mt-2 text-sm font-semibold text-teal-800">{tl ? 'Napalitan na ang password.' : 'Password changed.'}</p>}
          <details className="mt-2" onToggle={e => { if (e.currentTarget.open) setPasswordSaved(false); }}><summary className="py-2 font-semibold text-teal-800">{tl ? 'Palitan ang password' : 'Change password'}</summary><OwnerPasswordForm lang={lang} onDone={() => setPasswordSaved(true)} /></details>
        </section>
        <button type="button" className="soft-button" onClick={onLogout}><LogOut size={17} />{tl ? 'Mag-logout' : 'Logout'}</button>
      </div>
      <div className="farmer-device-settings space-y-4" ref={deviceSection} tabIndex={-1} aria-label={tl ? 'Device at SMS' : 'Device & SMS Settings'}>
        <ConnectEsp32 lang={lang} telemetry={telemetry} now={now} />
        <FishpenSmsSettings key={currentUser.id} ownerId={currentUser.id} lang={lang} defaultOpen />
        {onTestSms && <button type="button" className="soft-button" onClick={onTestSms}>{tl ? 'Subukan ang SMS alert' : 'Test SMS Alert'}</button>}
      </div>
    </div>
  </main>;
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
  const [savedHarvest, setSavedHarvest] = useState<SavedHarvest | null>(null);
  const [sampleForm, setSampleForm] = useState({ sampledAt: today, sampleSize: "", averageWeightG: "", notes: "" });
  const [mortalityForm, setMortalityForm] = useState({ mortalityDate: today, deadCount: "", notes: "" });
  const [penFilter, setPenFilter] = useState("");
  const [speciesFilter, setSpeciesFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    setLoadError('');
    const result = await apiJson<{ harvests: HarvestBatch[]; fishpenAssignment: { id: number; name: string; deviceId: number | null } | null }>("/api/harvests");
    setLoading(false);
    if (result.data) { setRecords(result.data.harvests); setAssignment(result.data.fishpenAssignment); }
    else setLoadError(result.error || (lang === 'tl' ? 'Hindi makuha ang mga tala ng ani.' : 'Unable to load harvest records.'));
  };
  useEffect(() => { setRecords([]); if (currentUser) { void refresh(); void apiJson<{ devices: Array<{ id: number; deviceName: string }> }>("/api/sensors/devices").then(r => setDevices(r.data?.devices || [])); } }, [currentUser?.id]);
  const save = async () => {
    if (!assignment) return setMessage({ error: true, text: lang === 'tl' ? 'Ipa-assign muna sa administrator ang iyong fishpen.' : 'Ask the administrator to assign your fishpen first.' });
    if (!form.species || !form.stockingDate || !form.targetHarvestDate || !Number(form.stockedCount)) {
      setMessage({ error: true, text: lang === "tl" ? "Punan ang isda, petsa, at dami ng inalagaan." : "Enter species, dates, and number stocked." });
      return;
    }
    setBusy(true);
    const result = await apiJson(editingId ? `/api/harvests/${editingId}` : "/api/harvests", {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify({ species: form.species, notes: form.notes, reminderSms: form.reminderSms, stockingDate: form.stockingDate, targetHarvestDate: form.targetHarvestDate, stockedCount: Number(form.stockedCount), targetWeightG: form.targetWeightG || null, actualHarvestDate: form.actualHarvestDate || null, harvestedKg: form.harvestedKg || null, sellingPrice: form.sellingPrice || null })
    });
    setBusy(false);
    if (result.error) return setMessage({ text: result.error, error: true });
    setMessage({ text: lang === 'tl' ? 'Nai-save ang grupo ng isda.' : 'Fish group saved.' });
    setShowForm(false);
    setForm(emptyForm);
    setEditingId(null);
    void refresh();
  };
  const edit = (row: HarvestBatch) => {
    setMessage(null);
    setEditingId(row.id);
    setShowForm(true);
    setForm({ notes: row.notes || "", sensorDeviceId: row.sensorDeviceId ? String(row.sensorDeviceId) : "", species: row.species, fishpenName: row.fishpenName || "", targetWeightG: row.targetWeightG === null ? "" : String(row.targetWeightG), reminderSms: Boolean(row.reminderSms), stockingDate: String(row.stockingDate).slice(0, 10), stockedCount: String(row.stockedCount), targetHarvestDate: String(row.targetHarvestDate).slice(0, 10), actualHarvestDate: row.actualHarvestDate ? String(row.actualHarvestDate).slice(0, 10) : "", harvestedKg: row.harvestedKg === null ? "" : String(row.harvestedKg), sellingPrice: row.sellingPrice === null ? "" : String(row.sellingPrice) });
    setAction("batch");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const remove = async (id: number) => {
    if (!window.confirm(lang === "tl" ? "Burahin ang batch at lahat ng sample, mortality, obserbasyon at ani nito? Hindi ito maibabalik." : "Delete this batch and all its samples, mortality, observations and harvests? This cannot be undone.")) return;
    const result = await apiJson(`/api/harvests/${id}`, { method: "DELETE" });
    setMessage({ error: Boolean(result.error), text: result.error || (lang === "tl" ? "Nabura ang tala." : "Record deleted.") });
    if (!result.error) void refresh();
  };
  const completed = records.filter((row) => row.actualHarvestDate);
  const activeBatchCount = records.length - completed.length;
  const createBatch = () => {
    setAction('batch'); setEditingId(null); setForm(emptyForm); setShowForm(true); setMessage(null); setSavedHarvest(null);
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
    const result = await apiJson<{ id: number }>(`/api/harvests/${selected.id}/${endpoint}`, { method: "POST", body: JSON.stringify(payload) });
    setBusy(false);
    setMessage({ error: Boolean(result.error), text: result.error || (lang === "tl" ? "Nai-save ang tala." : "Record saved.") });
    if (!result.error) {
      if (action === 'harvest' && result.data?.id) {
        setSavedHarvest({ group: `${selected.species} #${selected.id}`, date: eventForm.harvestDate, kg: Number(eventForm.weightKg), complete: confirmComplete });
        setShowForm(false);
        setMessage(null);
      }
      setEventForm({ harvestType: "partial", harvestDate: today, fishCount: "", weightKg: "", pricePerKg: "", notes: "" });
      setSampleForm({ sampledAt: today, sampleSize: "", averageWeightG: "", notes: "" });
      setMortalityForm({ mortalityDate: today, deadCount: "", notes: "" });
      void refresh();
    }
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
    totalKg={totalKg} grossSales={grossSales} loading={loading} busy={busy} message={message} loadError={loadError}
    editingId={editingId} action={action} showForm={showForm} selectedId={selectedId} setSelectedId={setSelectedId}
    form={form} setForm={setForm} eventForm={eventForm} setEventForm={setEventForm}
    sampleForm={sampleForm} setSampleForm={setSampleForm} mortalityForm={mortalityForm} setMortalityForm={setMortalityForm}
    species={activeSpecies.map(f => f.name)} speciesImages={Object.fromEntries(fishDb.map(fish => [fish.name, fishImageSrc(fish.id)]))} savedHarvest={savedHarvest} onCreate={createBatch} onAction={(next, id) => { setAction(next); setSelectedId(id || null); setShowForm(true); setMessage(null); setSavedHarvest(null); }}
    onCancel={() => { setShowForm(false); setEditingId(null); setAction('batch'); setMessage(null); setSavedHarvest(null); }}
    onSave={() => void save()} onSubmit={() => void submitAction()} onEdit={edit} onRemove={id => void remove(id)}
    onExport={exportCsv} onRetry={() => { setLoading(true); void refresh(); }} penFilter={penFilter} setPenFilter={setPenFilter}
    speciesFilter={speciesFilter} setSpeciesFilter={setSpeciesFilter} dateFilter={dateFilter} setDateFilter={setDateFilter} />;
}

function AuthModal({ onClose, onLogin }: { text: typeof ui.en; onClose: () => void; onLogin: (user: AppUser, message: string) => void }) {
  return <OwnerLogin navigate={() => onClose()} onLogin={onLogin} />;
}

function AdminRouter({ path, navigate }: { path: string; navigate: (path: string) => void }) {
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const loginPage = path === '/admin/login';

  useEffect(() => {
    setError('');
    if (loginPage) { setAdmin(null); return; }
    let active = true;
    apiJson<{ admin: AdminUser | null }>("/api/admin/session").then((result) => {
      if (!active) return;
      if (result.status === 401 || result.status === 403 || (result.data && !result.data.admin)) {
        setAdmin(null);
        navigate("/admin/login");
        return;
      }
      if (result.data?.admin) {
        setAdmin(result.data.admin);
        if (!isAdminSection(path)) navigate('/admin/dashboard');
      }
      else setError(result.error || 'Could not verify the administrator session.');
    });
    return () => {
      active = false;
    };
  }, [path, loginPage, navigate, attempt]);

  if (path === "/admin/login") {
    return <AdminLoginPage navigate={navigate} />;
  }

  if (!admin) {
    return (
      <div className="admin-access-screen">
        <section className="admin-access-card admin-access-status" aria-live="polite">
          <p>{error || 'Checking admin session...'}</p>
          {error && <button className="soft-button" onClick={() => setAttempt(value => value + 1)}>Try again</button>}
        </section>
      </div>
    );
  }
  return <AdminWorkspace path={isAdminSection(path) ? path : '/admin/dashboard'} navigate={navigate} />;
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
    if (submitting) return;
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

  return <div className="admin-access-screen">
    <section className="admin-access-card">
      <header><img src={farmerBrand.logo} alt="" width="40" height="40" /><div><p>{farmerBrand.name}</p><h1>Admin Login</h1></div></header>
      <div className="admin-access-body">
        {!deviceFlow && <form onSubmit={event => { event.preventDefault(); void login(); }}>
          <label>Username or email<input required autoComplete="username" value={identifier} onChange={event => setIdentifier(event.target.value)} /></label>
          <label>Admin password<input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
          <label>Admin PIN<input required type="password" autoComplete="off" value={pin} onChange={event => setPin(event.target.value)} /></label>
          <button className="primary-button w-full" disabled={submitting}>{submitting ? 'Logging in...' : 'Login to Admin'}</button>
        </form>}
        {error && <p role="alert" className="admin-notice" data-tone="warning">{error}</p>}
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
          <button className="soft-button w-full" disabled={submitting} onClick={() => { setDeviceFlow(null); setEnrolling(false); setError(''); }}>Back to admin login</button>
        </div>}
        <div className="admin-actions">
          <button className="soft-button" onClick={() => navigate('/login')}>Farmer Login</button>
        </div>
        {!deviceFlow && <details className="admin-detail-section">
          <summary>Recover admin access</summary>
          <p className="admin-muted">Use another authorized device to approve a replacement. If none are available, contact the system operator for verified recovery.</p>
        </details>}
      </div>
    </section>
  </div>;
}
