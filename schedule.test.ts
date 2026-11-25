import assert from "node:assert/strict";
import { test } from "node:test";
import { Lock as ClientLock } from "eufy-security-client";
import "./eufylib.ts";
import { describeSchedule, parseSchedule, toDriver, toRaw, validSchedule, type Schedule } from "./schedule.ts";

const ALWAYS = { startDay: "00000000", endDay: "ffffffff", startTime: "0000", endTime: "ffff", week: "ff" };

// the payload is a list of [marker, length, bytes]; fields 3 to 7 are the schedule
function sentByClient(schedule: Schedule): string[] {
  const payload = ClientLock.encodeCmdSmartLockUpdateSchedule("admin", "0002", "Ana", toDriver(schedule));
  const fields: string[] = [];
  for (let at = 0; at < payload.length; at += 2 + payload[at + 1]) {
    fields.push(payload.subarray(at + 2, at + 2 + payload[at + 1]).toString("hex"));
  }
  return fields.slice(3, 8);
}

test("reads the schedules found on the real lock", () => {
  assert.deepEqual(parseSchedule(JSON.stringify(ALWAYS)), { type: "always" });
  assert.deepEqual(parseSchedule({ ...ALWAYS, week: "7F" }), { type: "always" });
  assert.deepEqual(parseSchedule({ ...ALWAYS, week: "04", startTime: "0700", endTime: "0f00" }), {
    type: "weekly", days: ["tue"], start: "07:00", end: "15:00",
  });
  assert.deepEqual(parseSchedule({ ...ALWAYS, startDay: "ea070b19", endDay: "ea070c1e", startTime: "1229", endTime: "1229" }), {
    type: "range", from: "2026-11-25T18:41", until: "2026-12-30T18:41",
  });
  const dated = parseSchedule({ ...ALWAYS, week: "FE", startDay: "e9070c18", endDay: "ea070118", startTime: "0900", endTime: "1200" });
  assert.equal(describeSchedule(dated), "mon tue wed thu fri sat 09:00-18:00 from 2025-12-24 until 2026-01-24");
  for (const bad of ["{", {}, null, { ...ALWAYS, week: "zz" }]) assert.equal(parseSchedule(bad).type, "unknown");
});

test("the lock gets the same bytes that the list shows", () => {
  const schedules: Schedule[] = [
    { type: "always" },
    { type: "range", from: "2026-11-25T18:00", until: "2026-12-31T23:59" },
    { type: "weekly", days: ["mon"], start: "09:00", end: "18:00" },
    { type: "weekly", days: ["sun", "sat"], start: "00:00", end: "24:00" },
  ];
  for (const schedule of schedules) {
    const raw = toRaw(schedule);
    assert.deepEqual(sentByClient(schedule), [raw.startDay, raw.endDay, raw.week, raw.startTime, raw.endTime]);
    assert.deepEqual(parseSchedule(raw), schedule);
  }
  assert.equal(toRaw(schedules[2]).week, "02");
});

test("rejects bad schedules", () => {
  const bad = [
    undefined, {}, { type: "never" },
    { type: "range", from: "2026-11-25T18:00", until: "2026-11-25T18:00" },
    { type: "range", from: "2026-02-30T10:00", until: "2026-03-01T10:00" },
    { type: "range", from: "2026-11-25 18:00", until: "2026-11-26T10:00" },
    { type: "range", from: "2026-11-25T24:00", until: "2026-11-26T10:00" },
    { type: "weekly", days: [], start: "09:00", end: "18:00" },
    { type: "weekly", days: ["mon", "mon"], start: "09:00", end: "18:00" },
    { type: "weekly", days: ["monday"], start: "09:00", end: "18:00" },
    { type: "weekly", days: ["mon"], start: "18:00", end: "09:00" },
    { type: "weekly", days: ["mon"], start: "24:00", end: "24:00" },
    { type: "weekly", days: ["mon"], start: "9:00", end: "18:00" },
  ];
  for (const input of bad) assert.throws(() => validSchedule(input), { kind: "invalid" });
  assert.deepEqual(validSchedule({ type: "weekly", days: ["sat", "mon"], start: "09:00", end: "24:00" }), {
    type: "weekly", days: ["mon", "sat"], start: "09:00", end: "24:00",
  });
});
