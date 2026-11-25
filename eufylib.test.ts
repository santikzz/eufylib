import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { describeSchedule, parseAccess, EufyError, EufyLib, scheduleUntil, Unconfirmed } from "./eufylib.ts";

const SN = "T8520K8FAKE";
const ALWAYS = { startDay: "00000000", endDay: "ffffffff", startTime: "0000", endTime: "ffff", week: "ff" };

const entry = (name: string, id: string, type = 4) => ({
  user_name: name,
  short_user_id: id,
  user_type: type,
  password_list: [{ password_type: 1, password_id: id, schedule: JSON.stringify(ALWAYS) }],
});

// answers like eufy-security-client: the call returns first, the proof comes later as an event
class FakeDriver extends EventEmitter {
  users: ReturnType<typeof entry>[] | null = [entry("owner", "01", 2), entry("Ana ", "02"), entry("dup", "03"), entry("dup", "04")];
  schedules: unknown[] = [];
  connected = false;
  legacy = true;
  device = { getSerial: () => SN, getStationSerial: () => SN, getName: () => "door", isLock: () => true };

  isConnected() { return this.connected; }
  close() {}
  getApi() { return { isConnected: () => this.legacy, getUsers: async () => this.users }; }
  async getDevices() { return [this.device]; }

  async connect(options?: { verifyCode?: string }) {
    if (options?.verifyCode === "654321") this.connected = true;
    else this.emit("tfa request");
  }

  async setDeviceProperty(_: string, name: string, value: boolean) {
    const result = { return_code: value ? 0 : -133, customData: { property: { name, value } } };
    setImmediate(() => this.emit("station command result", { getSerial: () => SN }, result));
  }

  async addUser(_: string, name: string, pin: string, schedule: unknown) {
    this.schedules.push(schedule);
    this.users!.push(entry(name, "99"));
    if (name === "silent") return;
    if (pin === "0000") return void this.emit("user error", this.device, name, new Error("Passcode already used"));
    setImmediate(() => this.emit("user added", this.device, name));
  }

  async deleteUser(_: string, name: string) {
    this.users = this.users!.filter((user) => user.user_name !== name);
    setImmediate(() => this.emit("user deleted", this.device, name));
  }

  async updateUserPasscode(_: string, name: string) {
    setImmediate(() => this.emit("user passcode updated", this.device, name));
  }
}

async function setup() {
  const driver = new FakeDriver();
  const lib = new EufyLib(driver as never, 50);
  return { driver, lib, lock: await lib.lock() };
}

test("describes schedules", () => {
  assert.equal(describeSchedule(ALWAYS), "always");
  assert.equal(describeSchedule(JSON.stringify({ ...ALWAYS, startTime: "1200", endTime: "1600", week: "3e" })), "mon tue wed thu fri 18:00-22:00");
  assert.equal(describeSchedule({ ...ALWAYS, startDay: "ea070b19", endDay: "ea070c1e", startTime: "1229", endTime: "1229" }), "from 2026-11-25 18:41 until 2026-12-30 18:41");
  assert.equal(describeSchedule({ ...ALWAYS, week: "fe", startDay: "ea070b19" }), "mon tue wed thu fri sat from 2026-11-25");
  for (const bad of ["{", {}, null, { ...ALWAYS, week: "zz" }]) assert.equal(describeSchedule(bad), "unknown");
});

test("reads who opened the door", () => {
  const record = (event_type: number) =>
    Buffer.from(JSON.stringify({ event_type, event_time: 1795640000000, short_user_id: "0002", nick_name: "Ana", params: [{ param_type: 6001, param_value: "34" }] })).toString("base64");
  const time = new Date(1795640000000);
  assert.deepEqual(parseAccess(record(259)), { time, event: "pw unlock", userId: "0002", user: "Ana", battery: 34 });
  assert.deepEqual(parseAccess(record(265)), { time, event: "auto lock", userId: null, user: null, battery: 34 });
  assert.equal(parseAccess(record(9999))?.event, "event 9999");
  for (const bad of ["", "####", "e30="]) assert.equal(parseAccess(bad), null);
});

test("builds whole-day expiry", () => {
  const now = new Date(2026, 10, 25, 18, 0);
  const schedule = scheduleUntil("2026-11-25", now);
  assert.deepEqual(schedule, { startDateTime: new Date(2026, 10, 25), endDateTime: new Date(2026, 10, 25, 23, 59) });
  for (const bad of ["2026-11-24", "2026-02-30", "2027-13-01", "25/11/2026", ""]) {
    assert.throws(() => scheduleUntil(bad, now), EufyError);
  }
});

test("logs in with a code and detects a closed old cloud", async () => {
  const { driver, lib } = await setup();
  assert.deepEqual(await lib.login(), { status: "code" });
  assert.deepEqual(await lib.login({ code: "654321" }), { status: "connected" });
  driver.legacy = false;
  await assert.rejects(lib.login({ code: "654321" }), /old one/);
});

test("locks only on proof", async () => {
  const { driver, lock } = await setup();
  await lock.setLocked(true);
  await assert.rejects(lock.setLocked(false), /-133/);
  driver.setDeviceProperty = async () => {};
  await assert.rejects(lock.setLocked(true), Unconfirmed);
  assert.deepEqual(driver.eventNames(), []);
});

test("adds users", async () => {
  const { driver, lock } = await setup();
  await lock.addUser("bob", "4321");
  await assert.rejects(lock.addUser("bob", "4322"), /already exists/);
  await assert.rejects(lock.addUser("eve", "0000"), /already used.*left behind/);
  await assert.rejects(lock.addUser("silent", "7777"), Unconfirmed);
  for (const pin of ["12", "123456789", "12a4", "١٢٣٤", "1234\n"]) await assert.rejects(lock.addUser("x", pin), /digits/);
  for (const name of [" ", "a\u001bb", "x".repeat(256)]) await assert.rejects(lock.addUser(name, "1234"), /printable/);
  const sent = driver.schedules.length;
  await assert.rejects(lock.addUser("late", "1234", "2020-01-01"), /past/);
  assert.equal(driver.schedules.length, sent);
  driver.users = null;
  await assert.rejects(lock.addUser("y", "1234"), /did not return/);
});

test("deletes users and changes PINs", async () => {
  const { driver, lock } = await setup();
  assert.equal((await lock.setPin("Ana", "9876")).name, "Ana ");
  assert.equal((await lock.deleteUser("02")).name, "Ana ");
  await assert.rejects(lock.deleteUser("owner"), /admin/);
  await assert.rejects(lock.deleteUser("03"), /Several/);
  await assert.rejects(lock.deleteUser("nobody"), /No user/);
  assert.deepEqual(driver.eventNames(), []);
});
