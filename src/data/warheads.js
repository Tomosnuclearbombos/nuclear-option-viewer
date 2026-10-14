// Warhead yields (kg of TNT), by the weapon Name NOBlackBox records. From the "Yield (TNT)" columns of
// nuclearoption.wiki.gg/wiki/Munitions (read 2026-10-14). The game's blast radius is 13 x cbrt(kg) with about 60 m as
// the smallest: the recorded shockwaves match it to within a few metres for the 1.5, 20 and 250 kt warheads.
// Eyeball Mk.II (0 kg) is left out: nothing to show. GBM-500LR carries 12 x 15 kg submunitions: one 15 kg counted.

export const YIELD_KG = {
  // air to air, surface to air
  "IRM-S1": 3, "IRM-S2": 7, "MMR-S3": 11, "AAM-29 Scythe": 19, "AAM-36 Scimitar": 25,
  "RAM-45": 20, "NL-98": 25, "StratoLance R9": 45,
  // air to ground, surface to surface
  "AGR-18 Lynchpin": 3, "AGR-24 Kingpin": 10, "AT-145": 8, "AGM-48": 9, "AGM-68": 130, "ATP-1": 8,
  "Tusko-B (HE)": 300, "ARAD-116": 70, "AGM-99": 250, "ALM-C450": 450, "ALND-4 (20kt)": 20e6, "AShM-300": 300,
  "Piledriver TBM (HE)": 1000, "Piledriver TBM (20kt)": 20e6, "MLRS rocket": 100,
  // bombs
  "PAB-80LR": 80, "PAB-125": 100, "PAB-250": 200, "PAB-250LR": 200, "GPO-500": 400, "GBM-500LR": 15,
  "GPO-2P Auger": 800, "Demolition Bomb": 11000, "GPO-N (1.5kt)": 1.5e6, "GPO-N (250kt)": 250e6,
  // shells and submunitions
  "76mm Guided Shell": 3, "127mm Guided Shell": 10, "155mm Guided Shell": 12, "GS25": 15,
};

// From about 45 kg up the game makes a shockwave, which the recording has. Under this, a warhead going off never
// makes one; above it, a weapon that ended with no shockwave was shot down before it could go off.
export const SHOCKWAVE_KG = 40;

// the game's blast radius for a yield, without its 60 m floor (used for the small warheads it makes no shockwave for)
export const blastRadius = (kg) => 13 * Math.cbrt(kg);
