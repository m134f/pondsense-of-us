import type { AlertLevel } from '../types';
import { measurementMaxAge } from './recommendations';
import { sensorConnectionState } from './sensorDisplay';

export type WaterAssessment = {
  source: 'manual' | 'sensor';
  status: AlertLevel;
  assessedAt: string;
  sampledAt: string | null;
  receivedAt: string;
  previousAssignment: boolean;
};

export type FarmerWaterRecord = {
  id: number;
  name: string;
  fishpenName: string | null;
  latest: WaterAssessment | null;
  counts: Record<AlertLevel, number>;
};

export type FarmerWaterReport = {
  farmers: FarmerWaterRecord[];
  totals: Record<AlertLevel | 'noData', number>;
  updatedAt: string;
};

export function assessmentIsOutdated(assessment: WaterAssessment, now: number) {
  if (assessment.source === 'manual') return now - Date.parse(assessment.assessedAt) > measurementMaxAge.manual;
  return assessment.previousAssignment || sensorConnectionState({
    recordedAt: assessment.assessedAt, sampledAt: assessment.sampledAt, receivedAt: assessment.receivedAt
  }, now) !== 'live';
}
