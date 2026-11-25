import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  EufySecurity,
  LockPushEvent,
  LogLevel,
  P2PConnectionType,
  PropertyName,
  UserPasswordType,
  UserType,
  type Device,
  type EufySecurityEvents,
  type LoginOptions,
  type PropertyValue,
} from "eufy-security-client";
import { EufyError, Unconfirmed } from "./errors.ts";
import { parseSchedule, toDriver, toRaw, type Schedule, type StoredSchedule } from "./schedule.ts";

// eufy-security-client 4.1.0 writes a week below 0x10 as one hex digit, and its encoder then drops it:
// a "monday only" schedule would reach the lock without days. Pad it until the client fixes it
const require = createRequire(import.meta.url);
const clientUtils = require(join(dirname(require.resolve("eufy-security-client")), "http", "utils.js"));
const hexWeek = clientUtils.hexWeek;
clientUtils.hexWeek = (schedule: unknown) => String(hexWeek(schedule)).padStart(2, "0");

export { EufyError, Unconfirmed, type ErrorKind } from "./errors.ts";
export {
  describeSchedule,
  parseSchedule,
  validSchedule,
  type Day,
  type Schedule,
  type StoredSchedule,
} from "./schedule.ts";

export type Credentials = { username: string; password: string; country: string };

type Challenge = { status: "code" } | { status: "captcha"; captchaId: string; image: string };

export type LoginState = { status: "connected" } | { status: "disconnected"; error: string | null } | Challenge;

export type LoginAnswer = { code: string } | { captchaId: string; captcha: string };

export type User = {
  id: string;
  name: string;
  type: UserType;
  isAdmin: boolean;
  pins: number;
  fingerprints: number;
  schedules: StoredSchedule[];
};

// warning is set when the lock obeys but the copy for the eufy app did not change
export type Written = { user: User; warning: string | null };

export type LockEvent = { time: Date; name: string; value: unknown };

// user is null when the event does not prove who did it, such as auto lock or the inside knob
export type Access = { time: Date; event: string; userId: string | null; user: string | null; battery: number | null };

export type Capabilities = {
  commands: string[];
  settings: Record<string, PropertyValue>;
  readings: Record<string, PropertyValue>;
};

type Driver = Pick<
  EufySecurity,
  | "on" | "off" | "close" | "connect" | "isConnected" | "getApi" | "getDevices"
  | "addUser" | "deleteUser" | "updateUserPasscode" | "updateUserSchedule" | "setDeviceProperty"
>;

const PERSONAL_EVENTS = new Set<number>([
  LockPushEvent.PW_UNLOCK,
  LockPushEvent.FINGERPRINT_UNLOCK,
  LockPushEvent.APP_UNLOCK,
  LockPushEvent.APP_LOCK,
  LockPushEvent.PW_LOCK,
  LockPushEvent.FINGER_LOCK,
  LockPushEvent.TEMPORARY_PW_LOCK,
  LockPushEvent.TEMPORARY_PW_UNLOCK,
]);
const BATTERY_PARAM = 6001;
const ALWAYS: Schedule = { type: "always" };

export class EufyLib {
  private driver: Driver;
  private timeoutMs: number;
  private challenge: Challenge | null = null;
  private failure: string | null = null;

  // eufy can ask for a code at any time, not only during a login
  constructor(driver: Driver, timeoutMs = 45_000) {
    this.driver = driver;
    this.timeoutMs = timeoutMs;
    driver.on("tfa request", () => { this.challenge = { status: "code" }; });
    driver.on("captcha request", (captchaId, image) => { this.challenge = { status: "captcha", captchaId, image }; });
    driver.on("connection error", (error) => { this.failure = error.message; });
  }

  // dataDir keeps the cloud session, so a restart does not log in again
  static async open(credentials: Credentials, dataDir: string, log: (line: string) => void): Promise<EufyLib> {
    mkdirSync(dataDir, { recursive: true });
    const write = (message: unknown, ...details: unknown[]) => log(summarize(message, details));
    const quiet = () => {};
    const driver = await EufySecurity.initialize(
      {
        ...credentials,
        persistentDir: dataDir,
        p2pConnectionSetup: P2PConnectionType.QUICKEST,
        pollingIntervalMinutes: 5,
        eventDurationSeconds: 10,
        enableEmbeddedPKCS1Support: true,
        logging: { level: LogLevel.Warn },
      },
      { trace: quiet, debug: quiet, info: quiet, warn: write, error: write },
    );
    return new EufyLib(driver);
  }

  close(): void {
    this.driver.close();
  }

  get loginState(): LoginState {
    if (this.driver.isConnected() && this.driver.getApi().isConnected()) return { status: "connected" };
    if (this.challenge) return this.challenge;
    // the client can report a login on the new cloud only, but devices and users live in the old one
    const halfway = this.driver.isConnected() ? "eufy refused the login on the old cloud that this library uses." : null;
    return { status: "disconnected", error: this.failure ?? halfway };
  }

  // wrong answers can lock the eufy account for a while, so this never retries
  async login(answer?: LoginAnswer): Promise<LoginState> {
    this.challenge = null;
    this.failure = null;
    await this.driver.connect(answer && toLoginOptions(answer));
    return this.loginState;
  }

  async lock(serial?: string): Promise<Lock> {
    const devices = await Promise.race([
      this.driver.getDevices(),
      sleep(this.timeoutMs, undefined, { ref: false }),
    ]);
    if (!devices) throw new EufyError("The cloud did not send the device list in time.", "unavailable");
    const locks = devices.filter((device) => device.isLock());
    const found = serial ? locks.filter((device) => device.getSerial() === serial) : locks;
    if (found.length !== 1) {
      const known = locks.map((device) => `${device.getSerial()} (${device.getName()})`).join(", ");
      throw new EufyError(`Found ${found.length} locks. Choose one serial. Known: ${known || "none"}`, "unavailable");
    }
    return new Lock(this.driver, found[0], this.timeoutMs);
  }
}

export class Lock {
  private driver: Driver;
  private device: Device;
  private timeoutMs: number;

  constructor(driver: Driver, device: Device, timeoutMs: number) {
    this.driver = driver;
    this.device = device;
    this.timeoutMs = timeoutMs;
  }

  get serial(): string {
    return this.device.getSerial();
  }

  status(): Record<string, PropertyValue> {
    return this.device.getProperties();
  }

  capabilities(): Capabilities {
    const settings: Capabilities["settings"] = {};
    const readings: Capabilities["readings"] = {};
    for (const [name, metadata] of Object.entries(this.device.getPropertiesMetadata())) {
      (metadata.writeable ? settings : readings)[name] = this.device.getPropertyValue(name as PropertyName);
    }
    return { commands: this.device.getCommands(), settings, readings };
  }

  // returns a function that stops the listener
  onEvent(listener: (event: LockEvent) => void): () => void {
    const emit = (name: string, value: unknown) => listener({ time: new Date(), name, value });
    const mine = (device: Device) => device.getSerial() === this.serial;
    const onProperty = (device: Device, name: string, value: PropertyValue) => { if (mine(device)) emit(name, value); };
    const onPin = (device: Device, ok: boolean) => { if (mine(device)) emit("pin verified", ok); };
    this.driver.on("device property changed", onProperty);
    this.driver.on("device pin verified", onPin);
    return () => {
      this.driver.off("device property changed", onProperty);
      this.driver.off("device pin verified", onPin);
    };
  }

  async setLocked(locked: boolean): Promise<void> {
    await this.confirmed(
      () => this.driver.setDeviceProperty(this.serial, PropertyName.DeviceLocked, locked),
      (done) => ({
        "device locked": (device, state) => {
          if (device.getSerial() === this.serial && state === locked) done();
        },
        "station command result": (station, result) => {
          const changed = result.customData?.property;
          if (station.getSerial() !== this.device.getStationSerial()) return;
          if (changed?.name !== PropertyName.DeviceLocked || changed.value !== locked) return;
          done(result.return_code === 0 ? undefined : new EufyError(`The lock refused (code ${result.return_code}).`));
        },
      }),
    );
  }

  async users(): Promise<User[]> {
    const users = await this.driver.getApi().getUsers(this.serial, this.device.getStationSerial());
    // null is a failed request, not an empty list
    if (!users) throw new EufyError("The cloud did not return the user list.", "unavailable");
    return users.map((user) => {
      const credentials = user.password_list ?? [];
      const schedules = credentials.flatMap(({ schedule }) => (schedule ? [parseSchedule(schedule)] : []));
      return {
        id: String(user.short_user_id),
        name: String(user.user_name ?? ""),
        type: user.user_type,
        isAdmin: user.user_type === UserType.ADMIN || user.user_type === UserType.SUPER_ADMIN,
        pins: credentials.filter((item) => item.password_type === UserPasswordType.PIN).length,
        fingerprints: credentials.filter((item) => item.password_type === UserPasswordType.FINGERPRINT).length,
        schedules: schedules.filter((item, i) => schedules.findIndex((other) => isDeepStrictEqual(other, item)) === i),
      };
    });
  }

  // newest first. The client returns an empty list when the request fails, and logs the error
  async history(limit = 50, since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)): Promise<Access[]> {
    const records = await this.driver.getApi().getHistoryEvents(since, new Date(), { deviceSN: this.serial }, limit);
    return records.flatMap(({ extra }) => parseAccess(extra) ?? []).sort((a, b) => +b.time - +a.time);
  }

  async addUser(rawName: string, pin: string, schedule: Schedule = ALWAYS): Promise<Written> {
    const name = validName(rawName);
    validPin(pin);
    const before = await this.users();
    if (before.some((user) => user.name.trim() === name)) {
      throw new EufyError(`A user named "${name}" already exists.`, "conflict");
    }
    // the cloud entry is made before the lock takes the PIN, so only the event is proof
    try {
      await this.userCommand("user added", name, () => this.driver.addUser(this.serial, name, pin, toDriver(schedule)));
    } catch (error) {
      if (error instanceof EufyError) error.message += " Check the list: an entry may be left behind.";
      throw error;
    }
    const known = new Set(before.map((user) => user.id));
    const user = await this.waitForUser((item) => item.name.trim() === name && !known.has(item.id) && item.pins > 0);
    if (!user) throw new Unconfirmed("The lock took the PIN, but the cloud does not list it yet. Check the list later.");
    return this.copyToCloud(user, schedule);
  }

  async setSchedule(id: string, schedule: Schedule): Promise<Written> {
    const user = await this.userById(id);
    // the client also writes the permission, always as entry only
    if (user.type !== UserType.ENTRY_ONLY) {
      throw new EufyError(`"${user.name}" is not an entry only user. Change it in the eufy app.`, "conflict");
    }
    await this.userCommand("user schedule updated", user.name, () =>
      this.driver.updateUserSchedule(this.serial, user.name, toDriver(schedule)),
    );
    return this.copyToCloud(user, schedule);
  }

  async deleteUser(id: string): Promise<User> {
    const user = await this.userById(id);
    if (user.isAdmin) throw new EufyError(`"${user.name}" is an admin. Delete it in the eufy app.`, "conflict");
    await this.userCommand("user deleted", user.name, () => this.driver.deleteUser(this.serial, user.name));
    return user;
  }

  async setPin(id: string, pin: string): Promise<User> {
    validPin(pin);
    const user = await this.userById(id);
    if (user.isAdmin) throw new EufyError(`"${user.name}" is an admin. Change its PIN in the eufy app.`, "conflict");
    // the client writes the same PIN to every PIN entry of the user
    if (user.pins !== 1) {
      throw new EufyError(`"${user.name}" has ${user.pins} PINs. Only a single PIN can change.`, "conflict");
    }
    await this.userCommand("user passcode updated", user.name, () =>
      this.driver.updateUserPasscode(this.serial, user.name, pin),
    );
    return user;
  }

  // for people at a terminal: an id, or else a name
  async findUser(who: string): Promise<User> {
    const users = await this.users();
    const found = users.find((user) => user.id === who) ?? users.find((user) => user.name.trim() === who.trim());
    if (!found) throw new EufyError(`No user "${who}".`, "not_found");
    return found;
  }

  // the client works by exact name, so the name must be unique
  private async userById(id: string): Promise<User> {
    const users = await this.users();
    const found = users.find((user) => user.id === id);
    if (!found) throw new EufyError(`No user with id "${id}".`, "not_found");
    if (users.filter((user) => user.name === found.name).length > 1) {
      throw new EufyError(`Several users are named "${found.name}". Rename one in the eufy app.`, "conflict");
    }
    return found;
  }

  private async waitForUser(matches: (user: User) => boolean): Promise<User | undefined> {
    const deadline = Date.now() + this.timeoutMs / 3;
    for (;;) {
      const found = (await this.users()).find(matches);
      if (found || Date.now() > deadline) return found;
      await sleep(this.timeoutMs / 30);
    }
  }

  // the eufy app and the user list read this copy, the keypad obeys the lock
  private async copyToCloud(user: User, schedule: Schedule): Promise<Written> {
    const wanted = parseSchedule(toRaw(schedule));
    const done = (item: User) => item.id === user.id && item.schedules.every((one) => isDeepStrictEqual(one, wanted));
    if (done(user)) return { user, warning: null };
    let saved = false;
    try {
      const api = this.driver.getApi();
      const raw = await api.getUsers(this.serial, this.device.getStationSerial());
      const credentials = raw?.find((item) => String(item.short_user_id) === user.id)?.password_list ?? [];
      const response = await api.request({
        method: "post",
        endpoint: "v1/app/device/password/save_or_update",
        data: {
          device_sn: this.serial,
          short_user_id: user.id,
          station_sn: "",
          transaction: String(Date.now()),
          password_list: credentials.map(({ password_id, password_type }) => ({
            password_id,
            password_type,
            schedule: JSON.stringify(toRaw(schedule)),
          })),
        },
      });
      saved = credentials.length > 0 && (response.data as { code?: number } | undefined)?.code === 0;
    } catch {
      // the lock already obeys, so a failure here is only a warning
    }
    const updated = saved ? await this.waitForUser(done).catch(() => undefined) : undefined;
    if (updated) return { user: updated, warning: null };
    return { user, warning: "The lock has the new schedule, but the eufy app may show the old one. Save it again." };
  }

  private async userCommand(
    success: "user added" | "user deleted" | "user passcode updated" | "user schedule updated",
    name: string,
    send: () => Promise<void>,
  ): Promise<void> {
    const mine = (device: Device, username: string) => device.getSerial() === this.serial && username === name;
    await this.confirmed(send, (done) => ({
      [success]: (device: Device, username: string) => {
        if (mine(device, username)) done();
      },
      "user error": (device, username, error) => {
        if (!mine(device, username)) return;
        const message = describeError(error);
        done(new EufyError(message, /already used/i.test(message) ? "conflict" : "refused"));
      },
    }));
  }

  private async confirmed(
    send: () => Promise<void>,
    listen: (done: (error?: Error) => void) => Partial<EufySecurityEvents>,
  ): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const listeners = Object.entries(listen((error) => (error ? reject(error) : resolve())));
    const timer = setTimeout(
      () => reject(new Unconfirmed("The lock did not confirm in time. The command may still take effect.")),
      this.timeoutMs,
    );
    listeners.forEach(([event, listener]) => this.driver.on(event as "user error", listener as never));
    try {
      await Promise.all([send(), promise]);
    } catch (error) {
      throw error instanceof EufyError ? error : new EufyError(describeError(error));
    } finally {
      clearTimeout(timer);
      listeners.forEach(([event, listener]) => this.driver.off(event as "user error", listener as never));
    }
  }
}

// the access record is JSON in base64
export function parseAccess(extra: string): Access | null {
  try {
    const record = JSON.parse(Buffer.from(extra, "base64").toString("utf8"));
    const type = Number(record.event_type);
    const personal = PERSONAL_EVENTS.has(type);
    const battery = record.params?.find((param: { param_type: number }) => param.param_type === BATTERY_PARAM);
    const time = new Date(Number(record.event_time));
    if (Number.isNaN(+time)) return null;
    return {
      time,
      event: LockPushEvent[type]?.toLowerCase().replaceAll("_", " ") ?? `event ${type}`,
      userId: personal ? String(record.short_user_id ?? "") : null,
      user: personal ? String(record.nick_name ?? "") : null,
      battery: battery ? Number(battery.param_value) : null,
    };
  } catch {
    return null;
  }
}

function validName(raw: string): string {
  const name = raw.trim();
  // the lock payload stores the length in one byte
  if (!name || /\p{C}/u.test(name) || Buffer.byteLength(name) > 255) {
    throw new EufyError("The name must be printable text, 1 to 255 bytes.", "invalid");
  }
  return name;
}

function validPin(pin: string): void {
  if (!/^[0-9]{4,8}$/.test(pin)) throw new EufyError("The PIN must be 4 to 8 digits.", "invalid");
}

function toLoginOptions(answer: LoginAnswer): LoginOptions {
  if ("code" in answer) return { verifyCode: answer.code, force: false };
  return { captcha: { captchaId: answer.captchaId, captchaCode: answer.captcha }, force: false };
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const context = (error as { context?: Record<string, unknown> }).context;
  // "returnode" is a typo in eufy-security-client
  const code = context?.returnCode ?? context?.returnode;
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.message}${code === undefined ? "" : ` (code ${code})`}${cause}.`;
}

// the details of the client can hold tokens, so only the code and the message go out
function summarize(message: unknown, details: unknown[]): string {
  const extra = details.flatMap((detail) => {
    const { code, msg, error } = (detail ?? {}) as { code?: unknown; msg?: unknown; error?: { message?: unknown } };
    return [code, msg, error?.message].filter((part) => typeof part === "string" || typeof part === "number");
  });
  return [message, ...extra].join(" | ");
}
