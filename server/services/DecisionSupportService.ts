import type { WaterParams, AlertItem, FishSpecies } from "../../src/types";
import { analyzeWaterQuality, detectRisks } from "../../src/lib/decisionEngine";
export type WaterParameters = WaterParams;
export type AlertResult = AlertItem;
export type AlertLevel = AlertItem["level"];

export class DecisionSupportService {
  detectRisks = detectRisks;
  analyze(params: WaterParams, profiles: FishSpecies[]) {
    const fishScores = analyzeWaterQuality(params, profiles);
    const alerts = detectRisks(params);
    const best = fishScores[0];
    return { fishScores, alerts, status: alerts.some(a => a.level === "critical") ? "Critical" :
      alerts.some(a => a.level === "warning") ? "Warning" : "Safe",
      bestFish: best?.fish.name ?? null, bestScore: best?.score ?? null, confidence: best?.confidence ?? null };
  }
}
