import { setTimeout as sleep } from "node:timers/promises";
import { EufyError } from "./errors.ts";
import type { EufyLib, Lock, LoginState, User } from "./eufylib.ts";

const SYNC_MS = 5 * 60_000;
// more attempts can lock the eufy account, so after these an admin must ask for a login
const MAX_LOGINS = 3;

export type DoorStatus = {
  login: LoginState;
  lock: Record<string, unknown> | null;
  syncedAt: Date | null;
  syncError: string | null;
};

// owns the eufy session: one task at a time, and a user list that is refreshed every 5 minutes
export class Door {
  private lib: EufyLib;
  private serial: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private cache: { users: User[]; syncedAt: Date } | null = null;
  private syncError: string | null = null;
  private logins = 0;

  constructor(lib: EufyLib, serial?: string) {
    this.lib = lib;
    this.serial = serial;
  }

  async start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await sleep(SYNC_MS, undefined, { signal }).catch(() => {});
    }
  }

  async tick(): Promise<void> {
    try {
      if (this.lib.loginState.status === "disconnected" && this.logins < MAX_LOGINS) {
        this.logins += 1;
        await this.enqueue(() => this.lib.login());
      }
      if (this.lib.loginState.status === "connected") await this.sync();
    } catch (error) {
      this.syncError = messageOf(error);
      console.error(`sync: ${this.syncError}`);
    }
  }

  // without an answer it starts a new login, with one it answers the code or the captcha
  async login(answer?: string): Promise<LoginState> {
    await this.enqueue(async () => {
      const state = this.lib.loginState;
      if (state.status === "connected") return;
      if (!answer) {
        await this.lib.login();
      } else if (state.status === "code") {
        await this.lib.login({ code: answer });
      } else if (state.status === "captcha") {
        await this.lib.login({ captchaId: state.captchaId, captcha: answer });
      } else {
        throw new EufyError("eufy asked for no code. Send no answer to start a login.", "invalid");
      }
    });
    const state = this.lib.loginState;
    if (state.status === "connected") {
      this.logins = 0;
      // a failed sync must not look like a failed login
      await this.sync().catch((error) => { this.syncError = messageOf(error); });
    }
    return state;
  }

  async status(): Promise<DoorStatus> {
    const login = this.lib.loginState;
    let lock: DoorStatus["lock"] = null;
    if (login.status === "connected") {
      const found = await this.lib.lock(this.serial);
      const { name, model, locked, battery, softwareVersion } = found.status();
      lock = { serial: found.serial, name, model, locked, battery, softwareVersion };
    }
    return { login, lock, syncedAt: this.cache?.syncedAt ?? null, syncError: this.syncError };
  }

  users(): { users: User[]; syncedAt: Date } {
    if (!this.cache) throw new EufyError(this.syncError ?? "The user list is not loaded yet.", "unavailable");
    return this.cache;
  }

  async sync(): Promise<void> {
    await this.enqueue(async () => this.refresh(await this.open()));
  }

  async change<T>(task: (lock: Lock) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const lock = await this.open();
      try {
        return await task(lock);
      } finally {
        // also after a failure, which can leave an entry behind
        await this.refresh(lock).catch((error) => { this.syncError = messageOf(error); });
      }
    });
  }

  async idle(): Promise<void> {
    await this.queue;
  }

  private async open(): Promise<Lock> {
    if (this.lib.loginState.status !== "connected") {
      throw new EufyError("The service is not logged in to eufy.", "unavailable");
    }
    return this.lib.lock(this.serial);
  }

  private async refresh(lock: Lock): Promise<void> {
    this.cache = { users: await lock.users(), syncedAt: new Date() };
    this.syncError = null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
