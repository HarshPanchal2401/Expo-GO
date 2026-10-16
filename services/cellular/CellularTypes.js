// ============================================================================
// CellularTypes.js — cell identifiers: normalising, validating, masking
//
// Part of the isolated Cellular Test experiment. Nothing outside
// services/cellular, components/v2/Cellular*.js and the Cellular tab uses it.
//
// A cell is only looked up when EVERY identifier is real and in range for its
// radio technology. A missing value is never turned into 0, and nothing is
// guessed. OpenCelliD radio names: GSM, UMTS (= WCDMA), LTE, NR.
// ============================================================================

export const RADIO_TYPES = ["LTE", "NR", "GSM", "UMTS"];

// Largest valid area code (LAC / TAC) and cell id per radio (inclusive).
// GSM cell id is 16 bits; UMTS and LTE are 28 bits (RNC / eNB included); NR NCI is 36 bits.
const LIMITS = {
  GSM: { area: 65535, cell: 65535 },
  UMTS: { area: 65535, cell: 268435455 },
  LTE: { area: 65535, cell: 268435455 },
  NR: { area: 16777215, cell: 68719476735 },
};

// A plausible signal range (dBm); anything else is shown as "unavailable".
const SIGNAL_MIN = -140;
const SIGNAL_MAX = -20;

/** Whole number from a number or a digit string; anything else -> null. */
export function toInt(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && !/^\d+$/.test(v.trim())) return null;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * What a cell is missing or has out of range, as readable reasons.
 * Empty list = safe to look up.
 */
export function cellProblems(c) {
  const out = [];
  const lim = LIMITS[c.radio];
  if (!lim) {
    out.push(`radio "${c.radio || "unknown"}" is not supported`);
    return out;
  }
  if (c.mcc === null || c.mcc < 100 || c.mcc > 999) out.push("MCC missing or invalid");
  if (c.mnc === null || c.mnc > 999) out.push("MNC missing or invalid");
  if (c.areaCode === null || c.areaCode === 0 || c.areaCode > lim.area) out.push("LAC/TAC missing or invalid");
  if (c.cellId === null || c.cellId === 0 || c.cellId > lim.cell) out.push("cell ID missing or invalid");
  return out;
}

/**
 * One raw record from the native module -> a cell:
 * { radio, serving, mcc, mnc, areaCode, cellId, pci, signalDbm, ageMs, observedAt,
 *   problems, lookupable }
 */
export function normalizeCell(raw, observedAt = Date.now()) {
  const radio = String(raw?.radio || "").toUpperCase();
  const sig = Number.isFinite(raw?.signalDbm) ? raw.signalDbm : null;
  const cell = {
    radio,
    serving: Boolean(raw?.registered),
    mcc: toInt(raw?.mcc),
    mnc: toInt(raw?.mnc),
    areaCode: toInt(raw?.areaCode),
    cellId: toInt(raw?.cellId),
    pci: toInt(raw?.pci),
    signalDbm: sig !== null && sig >= SIGNAL_MIN && sig <= SIGNAL_MAX ? sig : null,
    ageMs: Number.isFinite(raw?.ageMs) && raw.ageMs >= 0 ? raw.ageMs : null,
    observedAt,
  };
  cell.problems = raw?.supported === false ? [`radio "${radio}" is not supported`] : cellProblems(cell);
  cell.lookupable = cell.problems.length === 0;
  return cell;
}

/** Same cell = same key. Only for cells with real identifiers. */
export function cellKey(c) {
  return `${c.radio}:${c.mcc}:${c.mnc}:${c.areaCode}:${c.cellId}`;
}

/** Query parameters for the lookup, or the reasons it cannot be done. */
export function lookupParams(c) {
  const problems = cellProblems(c);
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    params: { radio: c.radio, mcc: c.mcc, mnc: c.mnc, lac: c.areaCode, cellid: c.cellId },
  };
}

/** "•••••123": hides all but the last 3 digits (identifiers in the UI and logs). */
export function maskId(v) {
  if (v === null || v === undefined) return "—";
  const s = String(v);
  return s.length <= 3 ? "•••" : "•".repeat(s.length - 3) + s.slice(-3);
}
