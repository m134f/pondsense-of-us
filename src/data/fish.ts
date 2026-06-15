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
    id: "catfish",
    name: "Catfish",
    scientificName: "Clarias batrachus",
    category: "Freshwater",
    marketValue: "High",
    harvestTime: "4-6 months",
    description: "Resilient fish that tolerates lower oxygen better than many species.",
    guide: "Keep ammonia controlled and avoid overfeeding. Maintain pond cleanliness.",
    ranges: { ph: [6, 8.5], temperature: [24, 34], dissolvedOxygen: [3, 7], turbidity: [20, 150], ammonia: [0, 0.08] }
  },
  {
    id: "common-carp",
    name: "Common Carp",
    scientificName: "Cyprinus carpio",
    category: "Freshwater",
    marketValue: "Medium",
    harvestTime: "8-12 months",
    description: "Adaptable freshwater species suitable for semi-intensive ponds.",
    guide: "Works well in polyculture. Watch turbidity and organic waste buildup.",
    ranges: { ph: [6.5, 9], temperature: [20, 30], dissolvedOxygen: [4, 8], turbidity: [25, 120], ammonia: [0, 0.06] }
  },
  {
    id: "bangus",
    name: "Milkfish (Bangus)",
    scientificName: "Chanos chanos",
    category: "Brackish/Freshwater",
    marketValue: "High",
    harvestTime: "5-8 months",
    description: "Popular Philippine aquaculture species with strong market demand.",
    guide: "Maintain stable water quality and avoid feeding during poor oxygen conditions.",
    ranges: { ph: [7, 8.5], temperature: [26, 32], dissolvedOxygen: [5, 8], turbidity: [20, 100], ammonia: [0, 0.04] }
  },
  {
    id: "grass-carp",
    name: "Grass Carp",
    scientificName: "Ctenopharyngodon idella",
    category: "Freshwater",
    marketValue: "High",
    harvestTime: "8-10 months",
    description: "Herbivorous freshwater fish useful in pond vegetation control.",
    guide: "Provide plant-based feed and keep dissolved oxygen stable.",
    ranges: { ph: [6.5, 8.5], temperature: [22, 30], dissolvedOxygen: [5, 8], turbidity: [20, 100], ammonia: [0, 0.05] }
  },
  {
    id: "rainbow-trout",
    name: "Rainbow Trout",
    scientificName: "Oncorhynchus mykiss",
    category: "Cold Freshwater",
    marketValue: "High",
    harvestTime: "10-14 months",
    description: "Cold-water fish with strict oxygen and temperature requirements.",
    guide: "Not ideal for warm Laguna Lake ponds. Requires cool, oxygen-rich water.",
    ranges: { ph: [6.5, 8], temperature: [10, 18], dissolvedOxygen: [7, 12], turbidity: [0, 40], ammonia: [0, 0.02] }
  },
  {
    id: "snakehead",
    name: "Snakehead",
    scientificName: "Channa striata",
    category: "Freshwater",
    marketValue: "Medium",
    harvestTime: "7-10 months",
    description: "Air-breathing freshwater fish that can tolerate difficult conditions.",
    guide: "Still manage ammonia and avoid heavy organic waste accumulation.",
    ranges: { ph: [6, 8], temperature: [24, 32], dissolvedOxygen: [3, 8], turbidity: [20, 130], ammonia: [0, 0.08] }
  },
  {
    id: "red-tilapia",
    name: "Red Tilapia",
    scientificName: "Oreochromis sp. hybrid",
    category: "Freshwater",
    marketValue: "High",
    harvestTime: "6-8 months",
    description: "Marketable tilapia hybrid with similar needs to Nile tilapia.",
    guide: "Maintain warm water and consistent feeding, but pause feeding when ammonia rises.",
    ranges: { ph: [6.5, 8.5], temperature: [25, 32], dissolvedOxygen: [5, 8], turbidity: [25, 100], ammonia: [0, 0.05] }
  }
];
