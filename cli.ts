import { randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { inspect } from "node:util";
import { EufyError, EufyLib, type Lock, type User } from "./eufylib.ts";

const HELP = `
  status                        state of the lock
  caps                          commands, settings and readings of the lock
  users                         list people and access codes
  add NAME [PIN] [YYYY-MM-DD]   create a person, "-" or no PIN makes a random one, the date is the last valid day
  delete USER [-y]              USER is an id or a name, quote names with spaces
  pin USER [PIN]                change a PIN
  history [COUNT]               who opened the door, how and when
  lock | unlock
  watch                         print live events until Ctrl+C (the shell always prints them)
  help | exit
`;

const USER_TYPES: Record<number, string> = { 0: "normal", 1: "admin", 2: "owner", 4: "entry only" };
const COLUMNS = ["id", "name", "type", "pins", "fingerprints", "access"] as const;

const rl = createInterface({ input: process.stdin, output: process.stdout });
let inputEnded = false;
rl.on("close", () => { inputEnded = true; });
// the iterator keeps piped lines that arrive before the next question
const lines = rl[Symbol.asyncIterator]();

async function ask(question: string): Promise<string | undefined> {
  rl.setPrompt(question);
  if (!inputEnded) rl.prompt();
  const line = await lines.next();
  return line.done ? undefined : line.value.trim();
}

// names come from the cloud and must not control the terminal
function clean(value: unknown): string {
  return String(value).replace(/\p{C}/gu, "?");
}

function printUsers(users: User[]): void {
  const rows = users.map((user) => COLUMNS.map((key) => clean(key === "type" ? (USER_TYPES[user.type] ?? user.type) : user[key])));
  const widths = COLUMNS.map((key, i) => Math.max(key.length, ...rows.map((row) => row[i].length)));
  for (const row of [[...COLUMNS], ...rows]) console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  "));
}

function randomPin(): string {
  return String(randomInt(1_000_000)).padStart(6, "0");
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new EufyError(`Missing ${what}. Type help.`);
  return value;
}

async function run(lock: Lock, [command, ...args]: string[]): Promise<void> {
  switch (command) {
    case "status": {
      const { name, model, locked, lockStatus, battery, wifiRssi, softwareVersion } = lock.status();
      return console.log(inspect({ serial: lock.serial, name, model, locked, lockStatus, battery, wifiRssi, softwareVersion }));
    }
    case "caps":
      return console.log(inspect(lock.capabilities(), { depth: 4, maxArrayLength: null }));
    case "users":
      return printUsers(await lock.users());
    case "history": {
      const count = Number(args[0] ?? 30);
      if (!Number.isInteger(count) || count < 1) throw new EufyError("COUNT must be a whole number above 0.");
      for (const { time, event, user, userId } of await lock.history(count)) {
        console.log(`${time.toLocaleString()}  ${event.padEnd(24)} ${user === null ? "" : clean(`${user} (${userId})`)}`);
      }
      return;
    }
    case "add": {
      const name = need(args[0], "NAME");
      const pin = !args[1] || args[1] === "-" ? randomPin() : args[1];
      await lock.addUser(name, pin, args[2]);
      return console.log(`Added ${clean(name)}. PIN ${pin}. The lock never shows it again.`);
    }
    case "delete": {
      const user = await lock.findUser(need(args[0], "USER"));
      const answer = args[1] === "-y" ? "y" : await ask(`Delete ${clean(user.name)} (${clean(user.id)})? [y/n] `);
      if (answer?.toLowerCase() !== "y") return console.log("Nothing deleted.");
      await lock.deleteUser(user.id);
      return console.log(`Deleted ${clean(user.name)}.`);
    }
    case "pin": {
      const pin = args[1] ?? randomPin();
      const user = await lock.setPin(need(args[0], "USER"), pin);
      return console.log(`Changed the PIN of ${clean(user.name)} to ${pin}. The lock never shows it again.`);
    }
    case "lock":
    case "unlock":
      await lock.setLocked(command === "lock");
      return console.log(command === "lock" ? "Locked." : "Unlocked.");
    case "help":
      return console.log(HELP);
    default:
      throw new EufyError(`Unknown command ${clean(command)}. Type help.`);
  }
}

async function login(lib: EufyLib): Promise<void> {
  let result = await lib.login();
  while (result.status !== "connected") {
    if (result.status === "captcha") {
      const image = join(tmpdir(), "eufy-captcha.png");
      writeFileSync(image, Buffer.from(result.image.split(",").at(-1) ?? "", "base64"));
      console.log(`Open ${image}`);
    }
    const answer = await ask(result.status === "code" ? "Code from the eufy email: " : "Captcha: ");
    if (!answer) throw new EufyError("eufy asked for a code and none was given. Run this in a terminal.");
    result = await lib.login(result.status === "code" ? { code: answer } : { captchaId: result.captchaId, captcha: answer });
  }
}

function printEvents(lock: Lock): void {
  lock.onEvent(({ time, name, value }) => console.log(`\n${time.toLocaleTimeString()} ${name} = ${clean(value)}`));
}

async function shell(lock: Lock): Promise<void> {
  await run(lock, ["status"]);
  console.log(HELP);
  printEvents(lock);
  for (;;) {
    const line = await ask("eufy> ");
    if (line === undefined || line === "exit" || line === "quit") return;
    const words = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);
    if (!words.length) continue;
    await run(lock, words).catch(report);
  }
}

function report(error: unknown): void {
  if (!(error instanceof EufyError)) throw error;
  console.error(`Error: ${clean(error.message)}`);
}

async function main(words: string[]): Promise<number> {
  if (words[0] === "help") {
    console.log(HELP);
    return 0;
  }
  process.loadEnvFile(join(import.meta.dirname, ".env"));
  const { EUFY_USERNAME: username, EUFY_PASSWORD: password, EUFY_COUNTRY: country, EUFY_LOCK: serial } = process.env;
  if (!username || !password || !/^[A-Z]{2}$/.test(country ?? "")) {
    throw new EufyError("Set EUFY_USERNAME, EUFY_PASSWORD and EUFY_COUNTRY (two capital letters) in .env");
  }
  const lib = await EufyLib.open({ username, password, country: country! }, join(import.meta.dirname, "data"), (line) =>
    console.error(`eufy: ${clean(line)}`),
  );
  try {
    await login(lib);
    const lock = await lib.lock(serial);
    if (!words.length) await shell(lock);
    else if (words[0] === "watch") {
      printEvents(lock);
      console.log("Waiting for events. Press Ctrl+C to stop.");
      while ((await ask("")) !== undefined);
    } else await run(lock, words);
  } finally {
    lib.close();
  }
  return 0;
}

rl.on("SIGINT", () => process.exit(130));
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof EufyError ? `Error: ${clean(error.message)}` : error);
    process.exit(1);
  },
);
