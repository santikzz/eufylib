import type { Schedule as DriverSchedule } from "eufy-security-client";
import { EufyError } from "./errors.ts";

// the order is the bit order of the lock
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const NO_START = "00000000";
const NO_END = "ffffffff";

export type Day = (typeof DAYS)[number];

// times are the wall clock of the lock
export type Schedule =
  | { type: "always" }
  | { type: "range"; from: string; until: string }
  | { type: "weekly"; days: Day[]; start: string; end: string };

// the eufy app can also store weekly hours between two dates
export type StoredSchedule = Schedule | { type: "unknown"; text: string };

export type RawSchedule = { startDay: string; endDay: string; startTime: string; endTime: string; week: string };

export function parseSchedule(stored: unknown): StoredSchedule {
  const raw = readRaw(stored);
  if (!raw) return { type: "unknown", text: "unreadable" };
  const { startDay, endDay, startTime, endTime, week } = raw;
  const bits = parseInt(week, 16) & 0x7f;
  const days = DAYS.filter((_, bit) => (bits >> bit) & 1);
  const dated = startDay !== NO_START || endDay !== NO_END;

  // the eufy app writes one continuous range as week ff with two dates
  if (week === "ff" && startDay !== NO_START && endDay !== NO_END) {
    const last = endTime === "ffff" ? "23:59" : clock(endTime);
    return { type: "range", from: `${date(startDay)}T${clock(startTime)}`, until: `${date(endDay)}T${last}` };
  }
  if (!dated && bits === 0x7f && startTime === "0000" && endTime === "ffff") return { type: "always" };
  const [start, end] = [clock(startTime), clock(endTime)];
  if (!dated) return { type: "weekly", days, start, end };
  const limits = [startDay !== NO_START && `from ${date(startDay)}`, endDay !== NO_END && `until ${date(endDay)}`];
  return { type: "unknown", text: [days.join(" "), `${start}-${end}`, ...limits.filter(Boolean)].join(" ") };
}

export function describeSchedule(schedule: StoredSchedule): string {
  switch (schedule.type) {
    case "always":
      return "always";
    case "range":
      return `from ${schedule.from} until ${schedule.until}`;
    case "weekly":
      return `${schedule.days.join(" ")} ${schedule.start}-${schedule.end}`;
    case "unknown":
      return schedule.text;
  }
}

export function validSchedule(input: unknown): Schedule {
  const value = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if (value.type === "always") return { type: "always" };
  if (value.type === "range") {
    const [from, until] = [validDateTime(value.from, "from"), validDateTime(value.until, "until")];
    if (until <= from) throw new EufyError("until must be after from.", "invalid");
    return { type: "range", from, until };
  }
  if (value.type === "weekly") {
    const given = Array.isArray(value.days) ? value.days : [];
    const days = DAYS.filter((day) => given.includes(day));
    if (!days.length || days.length !== given.length) {
      throw new EufyError(`days must be a list without repeats of ${DAYS.join(", ")}.`, "invalid");
    }
    const [start, end] = [validTime(value.start, "start"), validTime(value.end, "end")];
    if (end <= start || start === "24:00") {
      throw new EufyError("end must be after start on the same day. Use 24:00 for the end of the day.", "invalid");
    }
    return { type: "weekly", days, start, end };
  }
  throw new EufyError("schedule.type must be always, range or weekly.", "invalid");
}

export function toRaw(schedule: Schedule): RawSchedule {
  const raw = { startDay: NO_START, endDay: NO_END, startTime: "0000", endTime: "ffff", week: "ff" };
  if (schedule.type === "range") {
    const [[startDay, startTime], [endDay, endTime]] = [schedule.from, schedule.until].map((moment) => {
      const [day, time] = moment.split("T");
      return [hexDate(day), hexTime(time)];
    });
    return { ...raw, startDay, endDay, startTime, endTime };
  }
  if (schedule.type === "weekly") {
    const bits = schedule.days.reduce((sum, day) => sum | (1 << DAYS.indexOf(day)), 0);
    return { ...raw, startTime: hexTime(schedule.start), endTime: hexTime(schedule.end), week: hex(bits, 2) };
  }
  return raw;
}

export function toDriver(schedule: Schedule): DriverSchedule {
  if (schedule.type === "always") return {};
  const { startDay, endDay, startTime, endTime, week } = toRaw(schedule);
  const bits = parseInt(week, 16);
  const flags = Object.fromEntries(DAY_NAMES.map((name, bit) => [name, Boolean((bits >> bit) & 1)]));
  return {
    startDateTime: wallClock(startDay, startTime),
    endDateTime: wallClock(endDay, endTime),
    // without week the client writes ff, which marks a continuous range
    ...(schedule.type === "weekly" && { week: flags as DriverSchedule["week"] }),
  };
}

// the client only calls these getters. A real Date cannot hold the open bounds of the lock,
// and it shifts the hours when the server and the lock are in different time zones
function wallClock(day: string, time: string): Date {
  const [yearLow, yearHigh, month, dayOfMonth] = bytes(day);
  const [hours, minutes] = bytes(time);
  return {
    getDate: () => dayOfMonth,
    getMonth: () => month - 1,
    getFullYear: () => (yearHigh << 8) | yearLow,
    getHours: () => hours,
    getMinutes: () => minutes,
  } as Date;
}

function readRaw(stored: unknown): RawSchedule | null {
  let value: Record<string, unknown> | null;
  try {
    value = typeof stored === "string" ? JSON.parse(stored) : (stored as Record<string, unknown>);
  } catch {
    return null;
  }
  const read = (key: string, length: number) => {
    const text = String(value?.[key] ?? "").toLowerCase();
    return text.length === length && /^[0-9a-f]+$/.test(text) ? text : null;
  };
  const [startDay, endDay, startTime, endTime, week] = [
    read("startDay", 8), read("endDay", 8), read("startTime", 4), read("endTime", 4), read("week", 2),
  ];
  return startDay && endDay && startTime && endTime && week ? { startDay, endDay, startTime, endTime, week } : null;
}

function validDateTime(value: unknown, field: string): string {
  const match = typeof value === "string" ? /^(20\d\d)-(\d\d)-(\d\d)T([01]\d|2[0-3]):[0-5]\d$/.exec(value) : null;
  if (match) {
    const [year, month, day] = match.slice(1, 4).map(Number);
    const real = new Date(Date.UTC(year, month - 1, day));
    if (real.getUTCMonth() === month - 1 && real.getUTCDate() === day) return match[0];
  }
  throw new EufyError(`${field} must be a real date and time, YYYY-MM-DDTHH:MM.`, "invalid");
}

function validTime(value: unknown, field: string): string {
  if (typeof value === "string" && /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(value)) return value;
  throw new EufyError(`${field} must be HH:MM.`, "invalid");
}

function clock(time: string): string {
  return time === "ffff" ? "24:00" : bytes(time).map(pad).join(":");
}

// the year is little-endian, then month and day
function date(day: string): string {
  const [yearLow, yearHigh, month, dayOfMonth] = bytes(day);
  return [(yearHigh << 8) | yearLow, pad(month), pad(dayOfMonth)].join("-");
}

function hexTime(time: string): string {
  if (time === "24:00") return "ffff";
  return time.split(":").map((part) => hex(Number(part), 2)).join("");
}

function hexDate(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  return [year & 0xff, year >> 8, month, dayOfMonth].map((part) => hex(part, 2)).join("");
}

function bytes(text: string): number[] {
  return [...Buffer.from(text, "hex")];
}

function hex(value: number, length: number): string {
  return value.toString(16).padStart(length, "0");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
