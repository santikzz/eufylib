import type { Access } from "./eufylib.ts";

export type BatteryEstimate = {
  // percent points lost each day
  perDay: number;
  daysLeft: number;
  emptyAt: Date;
  // the first reading the estimate uses
  since: Date;
  // the readings on the line: the moments the battery reached a new low
  points: number;
};

const DAY = 86_400_000;
// a rise this big is a battery change. A smaller rise is the cold or a rounding of the lock
const CHANGE = 10;
const MIN_POINTS = 3;
const MIN_DAYS = 3;

// a straight line through the moments the battery reached each new low since the last battery change, extended to
// 0 %. It is an estimate: the drain changes with use and temperature, and the lock reports whole percents
export function estimateBattery(history: Access[], now = new Date()): BatteryEstimate | null {
  const readings = history.flatMap(({ time, battery }) => (battery === null ? [] : [{ time: +time, level: battery }]));
  readings.sort((a, b) => a.time - b.time);

  let lows: { time: number; level: number }[] = [];
  // the first reading of the history is not the moment the battery reached that level, a battery change is
  let exact = false;
  for (const reading of readings) {
    const low = lows.at(-1)?.level;
    if (low === undefined || reading.level >= low + CHANGE) {
      exact = low !== undefined;
      lows = [reading];
    } else if (reading.level < low) {
      lows.push(reading);
    }
  }
  if (!exact) lows = lows.slice(1);
  if (lows.length < MIN_POINTS || lows.at(-1)!.time - lows[0].time < MIN_DAYS * DAY) return null;

  // least squares, with the time in days
  const xs = lows.map((point) => (point.time - lows[0].time) / DAY);
  const ys = lows.map((point) => point.level);
  const mx = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const my = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  const slope =
    xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  if (!(slope < 0)) return null;

  const emptyAt = new Date(lows[0].time + (mx - my / slope) * DAY);
  return {
    perDay: Math.round(-slope * 100) / 100,
    daysLeft: Math.max(0, Math.floor((+emptyAt - +now) / DAY)),
    emptyAt,
    since: new Date(lows[0].time),
    points: lows.length,
  };
}
