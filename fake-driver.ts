// a stand-in for eufy-security-client in the tests
import { EventEmitter } from "node:events";

export const SN = "T8520K8FAKE";
const ALWAYS = JSON.stringify({ startDay: "00000000", endDay: "ffffffff", startTime: "0000", endTime: "ffff", week: "ff" });

const entry = (name: string, id: string, type = 4) => ({
  user_name: name,
  short_user_id: id,
  user_type: type,
  password_list: [{ password_type: 1, password_id: `p${id}`, schedule: ALWAYS }],
});

export const access = (event_type: number, event_time: number, short_user_id = "", nick_name = "", battery?: number) => ({
  time: event_time,
  extra: Buffer.from(JSON.stringify({
    event_type,
    event_time,
    short_user_id,
    nick_name,
    params: battery === undefined ? [] : [{ param_type: 6001, param_value: String(battery) }],
  })).toString("base64"),
});

// answers like eufy-security-client: the call returns first, the proof comes later as an event
export class FakeDriver extends EventEmitter {
  users: ReturnType<typeof entry>[] | null = [entry("owner", "01", 2), entry("Ana ", "02"), entry("dup", "03"), entry("dup", "04")];
  history = [access(259, Date.now() - 60_000, "02", "Ana "), access(265, Date.now() - 120_000)];
  historyCalls = 0;
  sent: unknown[] = [];
  cloudFails = false;
  connected = true;
  legacy = true;
  device = {
    getSerial: () => SN,
    getStationSerial: () => SN,
    getName: () => "door",
    isLock: () => true,
    getProperties: () => ({ name: "door", model: "T8510P", locked: true, battery: 80 }),
  };

  isConnected() { return this.connected; }
  close() {}
  async getDevices() { return [this.device]; }

  getApi() {
    return {
      isConnected: () => this.legacy,
      getUsers: async () => structuredClone(this.users),
      // like the cloud: the newest records of the period first, at most num
      getHistoryEvents: async (since: Date, end: Date, _: unknown, num: number) => {
        this.historyCalls += 1;
        return this.history
          .filter(({ time }) => time >= +since && time <= +end)
          .sort((a, b) => b.time - a.time)
          .slice(0, num)
          .map(({ extra }) => ({ extra }));
      },
      request: async ({ data }: { data: { short_user_id: string; password_list: { password_id: string; schedule: string }[] } }) => {
        if (this.cloudFails) return { data: { code: 1 } };
        const user = this.users!.find((item) => item.short_user_id === data.short_user_id)!;
        for (const sent of data.password_list) {
          const credential = user.password_list.find((item) => item.password_id === sent.password_id);
          if (credential) credential.schedule = sent.schedule;
        }
        return { data: { code: 0 } };
      },
    };
  }

  async connect(options?: { verifyCode?: string }) {
    if (options?.verifyCode === "654321") this.connected = true;
    else this.emit("tfa request");
  }

  async setDeviceProperty(_: string, name: string, value: boolean) {
    const result = { return_code: value ? 0 : -133, customData: { property: { name, value } } };
    setImmediate(() => this.emit("station command result", { getSerial: () => SN }, result));
  }

  async addUser(_: string, name: string, pin: string, schedule: unknown) {
    this.sent.push(schedule);
    this.users!.push(entry(name, String(90 + this.users!.length)));
    if (name === "silent") return;
    if (pin === "0000") return void this.emit("user error", this.device, name, new Error("Passcode already used by another user"));
    setImmediate(() => this.emit("user added", this.device, name));
  }

  async deleteUser(_: string, name: string) {
    this.users = this.users!.filter((user) => user.user_name !== name);
    setImmediate(() => this.emit("user deleted", this.device, name));
  }

  async updateUserPasscode(_: string, name: string) {
    setImmediate(() => this.emit("user passcode updated", this.device, name));
  }

  async updateUserSchedule(_: string, name: string, schedule: unknown) {
    this.sent.push(schedule);
    setImmediate(() => this.emit("user schedule updated", this.device, name));
  }
}
