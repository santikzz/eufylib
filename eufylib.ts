import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
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
  type Schedule,
} from "eufy-security-client";

export class EufyError extends Error {}

// the command was sent but nothing confirmed it, so it may have worked
export class Unconfirmed extends EufyError {}

export type Credentials = { username: string; password: string; country: string };

export type LoginResult =
  | { status: "connected" }
  | { status: "code" }
  | { status: "captcha"; captchaId: string; image: string };

export type LoginAnswer = { code: string } | { captchaId: string; captcha: string };

export type User = {
  id: string;
  name: string;
  type: UserType;
  pins: number;
  fingerprints: number;
  access: string;
};

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
  | "addUser" | "deleteUser" | "updateUserPasscode" | "setDeviceProperty"
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
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export class EufyLib {
  private driver: Driver;
  private timeoutMs: number;

  constructor(driver: Driver, timeoutMs = 45_000) {
    this.driver = driver;
    this.timeoutMs = timeoutMs;
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
        pollingIntervalMinutes: 10,
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

  // wrong answers can lock the eufy account for a while, so this never retries
  async login(answer?: LoginAnswer): Promise<LoginResult> {
    let challenge: LoginResult | undefined;
    let failure: Error | undefined;
    const onCode = () => { challenge = { status: "code" }; };
    const onCaptcha = (captchaId: string, image: string) => { challenge = { status: "captcha", captchaId, image }; };
    const onError = (error: Error) => { failure = error; };
    this.driver.on("tfa request", onCode);
    this.driver.on("captcha request", onCaptcha);
    this.driver.on("connection error", onError);
    try {
      await this.driver.connect(answer && toLoginOptions(answer));
    } finally {
      this.driver.off("tfa request", onCode);
      this.driver.off("captcha request", onCaptcha);
      this.driver.off("connection error", onError);
    }
    if (challenge) return challenge;
    if (!this.driver.isConnected()) throw new EufyError(`Login failed: ${failure?.message ?? "unknown reason"}`);
    // the client can report a login on the new cloud only, but devices and users live in the old one
    if (!this.driver.getApi().isConnected()) {
      throw new EufyError("eufy accepts this account on the new cloud, but not on the old one that this library uses.");
    }
    return { status: "connected" };
  }

  async lock(serial?: string): Promise<Lock> {
    const devices = await Promise.race([
      this.driver.getDevices(),
      sleep(this.timeoutMs, undefined, { ref: false }),
    ]);
    if (!devices) throw new EufyError("The cloud did not send the device list in time.");
    const locks = devices.filter((device) => device.isLock());
    const found = serial ? locks.filter((device) => device.getSerial() === serial) : locks;
    if (found.length !== 1) {
      const known = locks.map((device) => `${device.getSerial()} (${device.getName()})`).join(", ");
      throw new EufyError(`Found ${found.length} locks. Choose one serial. Known: ${known || "none"}`);
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
    if (!users) throw new EufyError("The cloud did not return the user list.");
    return users.map((user) => {
      const credentials = user.password_list ?? [];
      const schedules = credentials.flatMap(({ schedule }) => (schedule ? [describeSchedule(schedule)] : []));
      return {
        id: String(user.short_user_id),
        name: String(user.user_name ?? ""),
        type: user.user_type,
        pins: credentials.filter((item) => item.password_type === UserPasswordType.PIN).length,
        fingerprints: credentials.filter((item) => item.password_type === UserPasswordType.FINGERPRINT).length,
        access: [...new Set(schedules)].join(", ") || "-",
      };
    });
  }

  // newest first. The client returns an empty list when the request fails, and logs the error
  async history(limit = 50, since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)): Promise<Access[]> {
    const records = await this.driver.getApi().getHistoryEvents(since, new Date(), { deviceSN: this.serial }, limit);
    return records.flatMap(({ extra }) => parseAccess(extra) ?? []).sort((a, b) => +b.time - +a.time);
  }

  // until is the last valid day, YYYY-MM-DD, enforced by the lock itself
  async addUser(rawName: string, pin: string, until?: string): Promise<void> {
    const name = validName(rawName);
    validPin(pin);
    const schedule = until === undefined ? undefined : scheduleUntil(until);
    if ((await this.users()).some((user) => user.name.trim() === name)) {
      throw new EufyError(`A user named "${name}" already exists.`);
    }
    // the cloud entry is made before the lock takes the PIN, so only the event is proof
    try {
      await this.userCommand("user added", name, () => this.driver.addUser(this.serial, name, pin, schedule));
    } catch (error) {
      if (error instanceof EufyError) error.message += " Check the list: an entry may be left behind.";
      throw error;
    }
  }

  async deleteUser(who: string): Promise<User> {
    const user = await this.findUser(who);
    if (user.type === UserType.ADMIN || user.type === UserType.SUPER_ADMIN) {
      throw new EufyError(`"${user.name}" is an admin. Delete it in the eufy app.`);
    }
    await this.userCommand("user deleted", user.name, () => this.driver.deleteUser(this.serial, user.name));
    return user;
  }

  async setPin(who: string, pin: string): Promise<User> {
    validPin(pin);
    const user = await this.findUser(who);
    // the client writes the same PIN to every PIN entry of the user
    if (user.pins !== 1) throw new EufyError(`"${user.name}" has ${user.pins} PINs. Only a single PIN can change.`);
    await this.userCommand("user passcode updated", user.name, () =>
      this.driver.updateUserPasscode(this.serial, user.name, pin),
    );
    return user;
  }

  // the client works by exact name, so the name must be unique
  async findUser(who: string): Promise<User> {
    const users = await this.users();
    const byId = users.filter((user) => user.id === who);
    const found = byId.length ? byId : users.filter((user) => user.name.trim() === who.trim());
    if (!found.length) throw new EufyError(`No user "${who}".`);
    if (found.length > 1 || users.filter((user) => user.name === found[0].name).length > 1) {
      throw new EufyError(`Several users are named "${found[0].name}". Rename one in the eufy app.`);
    }
    return found[0];
  }

  private async userCommand(
    success: "user added" | "user deleted" | "user passcode updated",
    name: string,
    send: () => Promise<void>,
  ): Promise<void> {
    const mine = (device: Device, username: string) => device.getSerial() === this.serial && username === name;
    await this.confirmed(send, (done) => ({
      [success]: (device: Device, username: string) => {
        if (mine(device, username)) done();
      },
      "user error": (device, username, error) => {
        if (mine(device, username)) done(new EufyError(describeError(error)));
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

// decode the hex schedule of the cloud, for example "mon tue 09:00-18:00"
export function describeSchedule(raw: unknown): string {
  let value: Record<string, unknown>;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return "unknown";
  }
  const [startDay, endDay, startTime, endTime, week] = ["startDay", "endDay", "startTime", "endTime", "week"].map(
    (key) => String(value?.[key] ?? "").toLowerCase(),
  );
  const valid = [[startDay, 8], [endDay, 8], [startTime, 4], [endTime, 4], [week, 2]] as const;
  if (!valid.every(([hex, length]) => hex.length === length && /^[0-9a-f]+$/.test(hex))) return "unknown";

  // the eufy app writes one continuous range as week ff with two dates
  if (week === "ff" && startDay !== "00000000" && endDay !== "ffffffff") {
    return `from ${date(startDay)} ${clock(startTime)} until ${date(endDay)} ${clock(endTime)}`;
  }
  const bits = parseInt(week, 16) & 0x7f;
  const days = DAYS.filter((_, bit) => (bits >> bit) & 1).join(" ");
  const parts = [bits === 0x7f ? "every day" : days || "no day"];
  if (startTime !== "0000" || endTime !== "ffff") parts.push(`${clock(startTime)}-${clock(endTime)}`);
  if (startDay !== "00000000") parts.push(`from ${date(startDay)}`);
  if (endDay !== "ffffffff") parts.push(`until ${date(endDay)}`);
  return parts.join(" ") === "every day" ? "always" : parts.join(" ");
}

function clock(hex: string): string {
  if (hex === "ffff") return "24:00";
  return [hex.slice(0, 2), hex.slice(2)].map((part) => pad(parseInt(part, 16))).join(":");
}

// the year is little-endian, then month and day
function date(hex: string): string {
  const year = parseInt(hex.slice(2, 4) + hex.slice(0, 2), 16);
  return `${year}-${pad(parseInt(hex.slice(4, 6), 16))}-${pad(parseInt(hex.slice(6, 8), 16))}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// whole days, so a continuous range and a daily window mean the same
export function scheduleUntil(until: string, now = new Date()): Schedule {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
  const [year, month, day] = (match ?? []).slice(1).map(Number);
  const endDateTime = new Date(year, month - 1, day, 23, 59);
  if (!match || endDateTime.getMonth() !== month - 1 || endDateTime.getDate() !== day) {
    throw new EufyError("The last day must be a real date, YYYY-MM-DD.");
  }
  if (endDateTime < now) throw new EufyError("The last day is in the past.");
  return { startDateTime: new Date(now.getFullYear(), now.getMonth(), now.getDate()), endDateTime };
}

function validName(raw: string): string {
  const name = raw.trim();
  // the lock payload stores the length in one byte
  if (!name || /\p{C}/u.test(name) || Buffer.byteLength(name) > 255) {
    throw new EufyError("The name must be printable text, 1 to 255 bytes.");
  }
  return name;
}

function validPin(pin: string): void {
  if (!/^[0-9]{4,8}$/.test(pin)) throw new EufyError("The PIN must be 4 to 8 digits.");
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
