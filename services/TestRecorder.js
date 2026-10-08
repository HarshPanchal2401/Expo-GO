// ============================================================================
// TestRecorder.js — records a test walk for measuring accuracy
//
// While recording, the Fusion Map adds one row per event:
//   start  x, y                where navigation started (ft)
//   step   len_ft, heading, x, y (position after the step)
//   ble    d1_ft, d2_ft, x, y   (ranges used, position after the update)
//   truth  x, y                the user tapped where they really are
//   note   text
// Exported as CSV through the phone's share sheet (email it, save to Drive).
// Comparing "truth" rows with the position at the same time gives the real
// error on this phone, in this office - which is what tuning needs.
// ============================================================================

const MAX_ROWS = 20000;

class TestRecorder {
  constructor() {
    this.active = false;
    this.rows = [];
    this.startedAt = null;
    this.listeners = new Set();
  }

  start(note = "") {
    this.active = true;
    this.rows = [];
    this.startedAt = Date.now();
    if (note) this.add("note", { text: note });
    this._emit();
  }

  stop() {
    this.active = false;
    this._emit();
  }

  /** kind + fields; ignored when not recording. */
  add(kind, f = {}) {
    if (!this.active || this.rows.length >= MAX_ROWS) return;
    this.rows.push({ t: Date.now(), kind, ...f });
    if (kind === "truth" || this.rows.length % 25 === 0) this._emit();
  }

  get truthCount() {
    return this.rows.filter((r) => r.kind === "truth").length;
  }

  toCSV() {
    const cols = ["t_ms", "kind", "x_ft", "y_ft", "len_ft", "heading_deg", "d1_ft", "d2_ft", "text"];
    const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "");
    const lines = [cols.join(",")];
    for (const r of this.rows) {
      lines.push([
        r.t - (this.startedAt || 0), r.kind,
        num(r.x), num(r.y), num(r.len), num(r.heading, 1), num(r.d1), num(r.d2),
        r.text ? `"${String(r.text).replace(/"/g, "'")}"` : "",
      ].join(","));
    }
    return lines.join("\n");
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this);
  }
}

export const testRecorder = new TestRecorder();
