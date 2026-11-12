import type { FishSpecies } from "../types";

export const fishDatabase: FishSpecies[] = [
  {
    id: "tilapia",
    name: "Tilapia",
    scientificName: "Oreochromis niloticus",
    category: "Freshwater",
    marketValue: "High",
    harvestTime: "6-8 months",
    description: "Hardy, fast-growing freshwater fish ideal for warm pond conditions.",
    guide: "Feed 3-5% of body weight daily. Monitor water quality during sudden weather changes.",
    ranges: { ph: [6.5, 8.5], temperature: [25, 32], dissolvedOxygen: [5, 8], turbidity: [25, 100], ammonia: [0, 0.05] }
  },
  {
    id: "bangus",
    name: "Bangus (Milkfish)",
    scientificName: "Chanos chanos",
    category: "Brackish/Freshwater",
    marketValue: "High",
    harvestTime: "5-8 months",
    description: "Popular Philippine aquaculture species with strong market demand.",
    guide: "Maintain stable water quality and avoid feeding during poor oxygen conditions.",
    ranges: { ph: [7, 8.5], temperature: [26, 32], dissolvedOxygen: [5, 8], turbidity: [20, 100], ammonia: [0, 0.04] }
  },
];

export const activeSpecies = [
  { id: "tilapia", name: "Tilapia" },
  { id: "mamali", name: "Mamali" },
  { id: "bangus", name: "Bangus (Milkfish)" }
] as const;

export function speciesId(name: string) {
  if (["Milkfish (Bangus)", "Bangus", "Milkfish"].includes(name)) return "bangus";
  return activeSpecies.find(s => s.name === name)?.id;
}
