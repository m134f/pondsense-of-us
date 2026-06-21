export type WaterParameters = {
  ph: number;
  temperature: number;
  dissolvedOxygen: number;
  turbidity: number;
  ammonia: number;
};

export type AlertLevel = "safe" | "warning" | "critical";

export type AlertResult = {
  level: AlertLevel;
  title: string;
  message: string;
  actions: string[];
};

type FishProfile = {
  name: string;
  scientificName: string;
  ranges: {
    ph: [number, number];
    temperature: [number, number];
    dissolvedOxygen: [number, number];
    turbidity: [number, number];
    ammonia: [number, number];
  };
};

const weights: Record<keyof WaterParameters, number> = {
  ph: 0.25,
  temperature: 0.2,
  dissolvedOxygen: 0.25,
  turbidity: 0.15,
  ammonia: 0.15
};

const fishProfiles: FishProfile[] = [
  { name: "Tilapia", scientificName: "Oreochromis niloticus", ranges: { ph: [6.5, 8.5], temperature: [25, 32], dissolvedOxygen: [5, 8], turbidity: [25, 100], ammonia: [0, 0.05] } },
  { name: "Catfish", scientificName: "Clarias batrachus", ranges: { ph: [6, 8.5], temperature: [24, 34], dissolvedOxygen: [3, 7], turbidity: [20, 150], ammonia: [0, 0.08] } },
  { name: "Common Carp", scientificName: "Cyprinus carpio", ranges: { ph: [6.5, 9], temperature: [20, 30], dissolvedOxygen: [4, 8], turbidity: [25, 120], ammonia: [0, 0.06] } },
  { name: "Milkfish (Bangus)", scientificName: "Chanos chanos", ranges: { ph: [7, 8.5], temperature: [26, 32], dissolvedOxygen: [5, 8], turbidity: [20, 100], ammonia: [0, 0.04] } },
  { name: "Grass Carp", scientificName: "Ctenopharyngodon idella", ranges: { ph: [6.5, 8.5], temperature: [22, 30], dissolvedOxygen: [5, 8], turbidity: [20, 100], ammonia: [0, 0.05] } },
  { name: "Mamali", scientificName: "Hypophthalmichthys nobilis", ranges: { ph: [6.5, 8.5], temperature: [22, 30], dissolvedOxygen: [4, 8], turbidity: [20, 120], ammonia: [0, 0.05] } },
  { name: "Snakehead", scientificName: "Channa striata", ranges: { ph: [6, 8], temperature: [24, 32], dissolvedOxygen: [3, 8], turbidity: [20, 130], ammonia: [0, 0.08] } },
  { name: "Red Tilapia", scientificName: "Oreochromis sp. hybrid", ranges: { ph: [6.5, 8.5], temperature: [25, 32], dissolvedOxygen: [5, 8], turbidity: [25, 100], ammonia: [0, 0.05] } }
];

function scoreParameter(value: number, [min, max]: [number, number]) {
  if (value >= min && value <= max) {
    const center = (min + max) / 2;
    const halfRange = Math.max((max - min) / 2, 0.001);
    const distanceFromCenter = Math.abs(value - center) / halfRange;
    return Math.round(100 - distanceFromCenter * 15);
  }

  const range = max - min;
  const distance = value < min ? min - value : value - max;
  return Math.max(0, Math.round(70 - (distance / range) * 100));
}

export class DecisionSupportService {
  analyze(params: WaterParameters) {
    const fishScores = fishProfiles
      .map((fish) => {
        const breakdown = {
          ph: scoreParameter(params.ph, fish.ranges.ph),
          temperature: scoreParameter(params.temperature, fish.ranges.temperature),
          dissolvedOxygen: scoreParameter(params.dissolvedOxygen, fish.ranges.dissolvedOxygen),
          turbidity: scoreParameter(params.turbidity, fish.ranges.turbidity),
          ammonia: scoreParameter(params.ammonia, fish.ranges.ammonia)
        };
        const score = Math.round(
          Object.entries(breakdown).reduce((sum, [key, value]) => sum + value * weights[key as keyof WaterParameters], 0)
        );
        const confidence = score >= 85 ? "High" : score >= 65 ? "Medium" : "Low";
        return { fish, score, confidence, breakdown };
      })
      .sort((a, b) => b.score - a.score);

    const alerts = this.detectRisks(params);
    const status = alerts.some((alert) => alert.level === "critical")
      ? "Critical"
      : alerts.some((alert) => alert.level === "warning")
        ? "Warning"
        : "Safe";

    return {
      status,
      alerts,
      bestFish: fishScores[0]?.fish.name || "No recommendation",
      bestScore: fishScores[0]?.score || 0,
      confidence: fishScores[0]?.confidence || "Low",
      fishScores
    };
  }

  detectRisks(params: WaterParameters): AlertResult[] {
    const alerts: AlertResult[] = [];
    if (params.dissolvedOxygen < 3) {
      alerts.push({
        level: "critical",
        title: "Critical DO / Hypoxia Risk",
        message: "Dissolved oxygen is dangerously low. Fish may gasp at the surface.",
        actions: ["Maximize aeration immediately", "Stop feeding", "Remove dead fish and organic waste", "Contact BFAR/LGU if fish stress continues"]
      });
    } else if (params.dissolvedOxygen < 5) {
      alerts.push({
        level: "warning",
        title: "Low Dissolved Oxygen",
        message: "Oxygen is below the safe range for most pond fish.",
        actions: ["Increase aeration", "Reduce feeding", "Clean nets or cage area", "Observe fish behavior closely"]
      });
    }

    if (params.ammonia > 0.1) {
      alerts.push({
        level: "critical",
        title: "Critical Ammonia",
        message: "Ammonia is high enough to stress or kill fish.",
        actions: ["Stop feeding for 24-48 hours", "Remove organic waste", "Improve aeration", "Consult BFAR/LGU before treatment"]
      });
    } else if (params.ammonia > 0.05) {
      alerts.push({
        level: "warning",
        title: "Ammonia Warning",
        message: "Ammonia is above the preferred safe range.",
        actions: ["Reduce feeding", "Remove leftover feeds and organic waste", "Improve aeration", "Monitor again after several hours"]
      });
    }

    if (params.turbidity > 150) {
      alerts.push({
        level: "warning",
        title: "High Turbidity",
        message: "Water is too cloudy and may affect fish health.",
        actions: ["Stop feeding temporarily if fish are stressed", "Clean net or cage area", "Avoid disturbing the lake bottom", "Do not use chemicals without expert guidance"]
      });
    }

    if (params.ph < 6 || params.ph > 9) {
      alerts.push({
        level: "critical",
        title: "Extreme pH",
        message: "pH is outside the safe range for most fish.",
        actions: ["Recheck using a test kit", "Monitor fish behavior", "Avoid sudden treatment", "Consult BFAR/LGU before applying lime or any treatment"]
      });
    }

    if (params.temperature > 34 || params.temperature < 20) {
      alerts.push({
        level: "warning",
        title: "Temperature Stress",
        message: "Temperature may reduce feeding response and oxygen availability.",
        actions: ["Reduce feeding", "Avoid fish handling", "Improve water circulation"]
      });
    }

    if (params.dissolvedOxygen < 5 && params.ammonia > 0.05) {
      alerts.push({
        level: "critical",
        title: "Combined DO + Ammonia Risk",
        message: "Low oxygen combined with ammonia creates a serious stress condition.",
        actions: ["Stop feeding immediately", "Maximize aeration", "Remove organic waste", "Contact BFAR/LGU for emergency guidance"]
      });
    }

    return alerts.length
      ? alerts
      : [{ level: "safe", title: "All Parameters Safe", message: "Water quality is within acceptable ranges.", actions: ["Continue daily monitoring"] }];
  }
}
