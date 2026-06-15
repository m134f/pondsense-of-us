export type WaterParams = {
  ph: number;
  temperature: number;
  dissolvedOxygen: number;
  turbidity: number;
  ammonia: number;
};

export type FishSpecies = {
  id: string;
  name: string;
  scientificName: string;
  category: string;
  marketValue: "High" | "Medium";
  harvestTime: string;
  description: string;
  guide: string;
  ranges: {
    ph: [number, number];
    temperature: [number, number];
    dissolvedOxygen: [number, number];
    turbidity: [number, number];
    ammonia: [number, number];
  };
};

export type FishScore = {
  fish: FishSpecies;
  score: number;
  confidence: "High" | "Medium" | "Low";
  breakdown: Record<keyof WaterParams, number>;
};

export type AlertLevel = "safe" | "warning" | "critical";

export type AlertItem = {
  level: AlertLevel;
  title: string;
  message: string;
  actions: string[];
};

export type SessionRecord = WaterParams & {
  id: string;
  timestamp: string;
  bestFish: string;
  score: number;
};
