import assert from "node:assert/strict";
import { test } from "node:test";
import { Unconfirmed } from "./errors.ts";
import { EufyLib, parseAccess } from "./eufylib.ts";
import { FakeDriver } from "./fake-driver.ts";
import type { Schedule } from "./schedule.ts";

async function setup() {
  const driver = new FakeDriver();
  const lib = new EufyLib(driver as never, 60);
  const listening = driver.eventNames().length;
  return { driver, lib, lock: await lib.lock(), listening };
}

test("reads who opened the door", () => {
  const record = (event_type: number) =>
    Buffer.from(JSON.stringify({ event_type, event_time: 1795640000000, short_user_id: "0002", nick_name: "Ana", params: [{ param_type: 6001, param_value: "34" }] })).toString("base64");
  const time = new Date(1795640000000);
  assert.deepEqual(parseAccess(record(259)), { time, event: "pw unlock", userId: "0002", user: "Ana", battery: 34 });
  assert.deepEqual(parseAccess(record(265)), { time, event: "auto lock", userId: null, user: null, battery: 34 });
  assert.equal(parseAccess(record(9999))?.event, "event 9999");
  for (const bad of ["", "####", "e30="]) assert.equal(parseAccess(bad), null);
});

test("tracks the login, also when eufy asks later", async () => {
  const { driver, lib } = await setup();
  driver.connected = false;
  assert.deepEqual(await lib.login(), { status: "code" });
  assert.deepEqual(await lib.login({ code: "654321" }), { status: "connected" });
  driver.legacy = false;
  assert.match(String((lib.loginState as { error: string }).error), /old cloud/);
  driver.emit("captcha request", "id1", "data:image/png;base64,AA");
  assert.deepEqual(lib.loginState, { status: "captcha", captchaId: "id1", image: "data:image/png;base64,AA" });
});

test("locks only on proof", async () => {
  const { driver, lock, listening } = await setup();
  await lock.setLocked(true);
  await assert.rejects(lock.setLocked(false), /-133/);
  driver.setDeviceProperty = async () => {};
  await assert.rejects(lock.setLocked(true), Unconfirmed);
  assert.equal(driver.eventNames().length, listening);
});

test("adds users and copies the schedule to the cloud", async () => {
  const { driver, lock } = await setup();
  const range = { type: "range", from: "2026-11-25T18:00", until: "2026-12-31T23:59" } as const;
  const added = await lock.addUser("bob", "4321", range);
  assert.deepEqual(added.user.schedules, [range]);
  assert.equal(added.warning, null);
  await assert.rejects(lock.addUser("bob", "4322"), { kind: "conflict" });
  await assert.rejects(lock.addUser("eve", "0000"), { kind: "conflict", message: /already used.*left behind/ });
  await assert.rejects(lock.addUser("silent", "7777"), Unconfirmed);
  for (const pin of ["12", "123456789", "12a4", "١٢٣٤", "1234\n"]) await assert.rejects(lock.addUser("x", pin), { kind: "invalid" });
  for (const name of [" ", "a\u001bb", "x".repeat(256)]) await assert.rejects(lock.addUser(name, "1234"), { kind: "invalid" });
  driver.cloudFails = true;
  assert.match(String((await lock.addUser("carl", "5555", range)).warning), /old one/);
  driver.users = null;
  await assert.rejects(lock.addUser("y", "1234"), { kind: "unavailable" });
});

test("changes, schedules and deletes users by id", async () => {
  const { driver, lock, listening } = await setup();
  assert.equal((await lock.setPin("02", "9876")).name, "Ana ");
  const weekly: Schedule = { type: "weekly", days: ["mon"], start: "09:00", end: "18:00" };
  assert.deepEqual((await lock.setSchedule("02", weekly)).user.schedules, [weekly]);
  assert.equal(driver.sent.length, 1);
  assert.equal((await lock.deleteUser("02")).name, "Ana ");
  await assert.rejects(lock.deleteUser("01"), { kind: "conflict", message: /admin/ });
  await assert.rejects(lock.setPin("01", "1234"), { kind: "conflict" });
  await assert.rejects(lock.setSchedule("01", weekly), { kind: "conflict" });
  await assert.rejects(lock.deleteUser("03"), { kind: "conflict", message: /Several/ });
  await assert.rejects(lock.deleteUser("Ana"), { kind: "not_found" });
  assert.equal(driver.eventNames().length, listening);
});
