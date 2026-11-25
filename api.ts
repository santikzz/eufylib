#!/usr/bin/env node
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { loadConfig } from "./config.ts";
import { Door } from "./door.ts";
import { EufyError, type ErrorKind } from "./errors.ts";
import { EufyLib } from "./eufylib.ts";
import { validSchedule } from "./schedule.ts";

const MAX_BODY = 16 * 1024;
const MIN_TOKEN = 32;
const STATUS: Record<ErrorKind, number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  refused: 502,
  unavailable: 503,
  unconfirmed: 504,
};

type Body = Record<string, unknown>;
type Reply = { status?: number; body: unknown };
type Route = [method: string, path: RegExp, handle: (body: Body, id: string) => Promise<Reply>];

export function createApi(door: Door, token: string): Server {
  const routes: Route[] = [
    ["GET", /^\/status$/, async () => ({ body: await door.status() })],
    ["POST", /^\/login$/, async (body) => ({ body: { login: await door.login(optionalText(body, "answer")) } })],
    ["POST", /^\/sync$/, async () => {
      await door.sync();
      return { body: door.users() };
    }],
    ["GET", /^\/users$/, async () => ({ body: door.users() })],
    ["POST", /^\/users$/, async (body) => {
      const name = text(body, "name");
      const pin = optionalText(body, "pin") ?? randomPin();
      const schedule = validSchedule(body.schedule ?? { type: "always" });
      const written = await door.change((lock) => lock.addUser(name, pin, schedule));
      return { status: 201, body: { ...written, pin } };
    }],
    ["PUT", /^\/users\/(\w{1,32})\/pin$/, async (body, id) => {
      const pin = optionalText(body, "pin") ?? randomPin();
      return { body: { user: await door.change((lock) => lock.setPin(id, pin)), pin } };
    }],
    ["PUT", /^\/users\/(\w{1,32})\/schedule$/, async (body, id) => {
      const schedule = validSchedule(body);
      return { body: await door.change((lock) => lock.setSchedule(id, schedule)) };
    }],
    ["DELETE", /^\/users\/(\w{1,32})$/, async (_, id) => ({
      body: { user: await door.change((lock) => lock.deleteUser(id)) },
    })],
  ];

  return createServer(async (request, response) => {
    const started = Date.now();
    const path = (request.url ?? "/").split("?")[0];
    const { status = 200, body } = await answer(request, path).catch(toReply);
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
    if (path !== "/up") console.log(`${request.method} ${JSON.stringify(path)} ${status} ${Date.now() - started}ms`);
  });

  async function answer(request: IncomingMessage, path: string): Promise<Reply> {
    if (path === "/up") return { body: { ok: true } };
    if (!sameToken(request.headers.authorization, token)) return { status: 401, body: { error: "unauthorized" } };
    const route = routes.find(([method, pattern]) => method === request.method && pattern.test(path));
    if (!route) return { status: 404, body: { error: "not_found", message: "No such route." } };
    const [, pattern, handle] = route;
    return handle(await readBody(request), pattern.exec(path)?.[1] ?? "");
  }
}

function toReply(error: unknown): Reply {
  if (error instanceof EufyError) {
    return { status: STATUS[error.kind], body: { error: error.kind, message: error.message } };
  }
  console.error(error);
  return { status: 500, body: { error: "internal", message: "Unexpected error." } };
}

// equal hash lengths, so the comparison time tells nothing about the token
function sameToken(header: string | undefined, token: string): boolean {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(header ?? ""), hash(`Bearer ${token}`));
}

async function readBody(request: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new EufyError("The body is too large.", "invalid");
    chunks.push(chunk);
  }
  if (!size) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new EufyError("The body is not JSON.", "invalid");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EufyError("The body must be a JSON object.", "invalid");
  }
  return body as Body;
}

function text(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw new EufyError(`${field} must be text.`, "invalid");
  return value;
}

function optionalText(body: Body, field: string): string | undefined {
  return body[field] === undefined || body[field] === null ? undefined : text(body, field);
}

function randomPin(): string {
  return String(randomInt(1_000_000)).padStart(6, "0");
}

async function main(): Promise<void> {
  const { credentials, serial, dataDir } = loadConfig();
  const { API_TOKEN: token = "", HOST: host = "127.0.0.1", PORT: rawPort = "8090" } = process.env;
  if (token.length < MIN_TOKEN) throw new EufyError(`Set API_TOKEN to ${MIN_TOKEN} characters or more.`, "invalid");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EufyError("Set PORT to a number from 1 to 65535.", "invalid");

  // a stray rejection in the eufy client must not restart the service: each restart can log in again
  process.on("unhandledRejection", (reason) => console.error("unhandled rejection:", reason));
  const lib = await EufyLib.open(credentials, dataDir, (line) => console.error(`eufy: ${line}`));
  const door = new Door(lib, serial);
  const server = createApi(door, token);
  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      stop.abort();
      server.close();
      await door.idle();
      lib.close();
      process.exit(0);
    });
  }
  server.listen(port, host, () => console.log(`eufylib api on ${host}:${port}`));
  await door.start(stop.signal);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof EufyError ? error.message : error);
    process.exit(1);
  });
}
