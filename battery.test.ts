import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateBattery } from "./battery.ts";
import type { Access } from "./eufylib.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 12);
const reading = (daysAgo: number, battery: number | null): Access =>
  ({ time: new Date(NOW - daysAgo * DAY), event: "auto lock", userId: null, user: null, battery });

// a reading every 6 hours, 1 point lost each day from `start`
const drain = (days: number, start: number) =>
  Array.from({ length: days * 4 + 1 }, (_, i) => reading(days - i / 4, Math.ceil(start - i / 4)));

test("extends the drain to 0 %", () => {
  const estimate = estimateBattery(drain(20, 60), new Date(NOW));
  assert.ok(estimate);
  assert.equal(estimate.perDay, 1);
  assert.ok(Math.abs(estimate.daysLeft - 40) <= 1, `days left ${estimate.daysLeft}`);
});

test("starts again after a battery change and ignores small rises", () => {
  const old = drain(20, 30).map((item) => ({ ...item, time: new Date(+item.time - 30 * DAY) }));
  const now = drain(10, 100);
  now[12] = { ...now[12], battery: 99 };
  const estimate = estimateBattery([...now, reading(5, null), ...old], new Date(NOW));
  assert.ok(estimate);
  assert.equal(+estimate.since, NOW - 10 * DAY);
  assert.equal(estimate.perDay, 1);
});

test("needs a few days of drain", () => {
  assert.equal(estimateBattery(drain(2, 60), new Date(NOW)), null);
  assert.equal(estimateBattery(Array.from({ length: 40 }, (_, i) => reading(i, 80)), new Date(NOW)), null);
  assert.equal(estimateBattery([], new Date(NOW)), null);
});
