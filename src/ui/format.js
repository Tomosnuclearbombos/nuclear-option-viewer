// Text formatting for readouts. Everything shown in the game's style: capitals, LABEL : value, clock digits.

const MAP_NAMES = {
  "NuclearOption.Terrain1": "HEARTLAND",
  "NuclearOption.Terrain_naval": "IGNUS ARCHIPELAGO",
};

export function mapName(mapId) { return MAP_NAMES[mapId] || (mapId ? String(mapId).toUpperCase() : "UNKNOWN MAP"); }

// 75 -> "1:15", 3725 -> "1:02:05"
export function duration(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(x).padStart(2, "0");
}

// Time of day in the mission: ReferenceTime holds the mission's start, frame times count seconds from it.
// The date part is made up by the game, so only the time is shown.
export function missionClock(referenceTime, t) {
  const ref = Date.parse(referenceTime);
  if (!Number.isFinite(ref)) return duration(t);
  const d = new Date(ref + t * 1000);
  return isNaN(d) ? "00:00:00" : d.toISOString().slice(11, 19);
}

// RecordingTime is the real moment the recording started (UTC). Shown in the viewer's own time zone.
export function recorded(recordingTime) {
  const d = new Date(recordingTime);
  if (isNaN(d)) return "UNKNOWN";
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return (day + " " + time).replace(/,/g, "").toUpperCase();
}

export function speedLabel(s) { return (s < 1 ? String(s) : String(Math.round(s))) + "X"; }
