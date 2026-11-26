import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApi } from "./api.ts";
import { Door } from "./door.ts";
import { EufyLib } from "./eufylib.ts";
import { access, FakeDriver } from "./fake-driver.ts";

const TOKEN = "t".repeat(40);
const driver = new FakeDriver();
const door = new Door(new EufyLib(driver as never, 60));
const server = createApi(door, TOKEN);
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(method: string, path: string, body?: unknown, token = TOKEN) {
  const response = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

test("asks for the token everywhere except /up", async () => {
  assert.equal((await call("GET", "/up", undefined, "")).status, 200);
  for (const token of ["", "wrong", TOKEN.slice(1)]) assert.equal((await call("GET", "/status", undefined, token)).status, 401);
  assert.equal((await call("GET", "/nothing")).status, 404);
});

test("serves the cached users and history after a sync", async () => {
  assert.equal((await call("GET", "/users")).status, 503);
  assert.equal((await call("GET", "/history")).status, 503);
  await door.tick();
  const { status, body } = await call("GET", "/users");
  assert.equal(status, 200);
  assert.equal(body.users.length, 4);
  const { history } = (await call("GET", "/history")).body;
  assert.deepEqual(history.map((item: { event: string; user: string | null }) => [item.event, item.user]), [["pw unlock", "Ana "], ["auto lock", null]]);
  assert.equal((await call("GET", "/status")).body.lock.serial, "T8520K8FAKE");
});

test("filters the history by time and estimates the battery", async () => {
  const now = Date.now();
  const hour = 3_600_000;
  // the first sync of a door reads the whole history, so this one starts fresh
  const fresh = new FakeDriver();
  // 1 point lost every 12 hours, from 60 % ten days ago
  fresh.history = Array.from({ length: 241 }, (_, i) => access(265, now - (240 - i) * hour, "", "", 60 - Math.floor(i / 12)));
  const freshDoor = new Door(new EufyLib(fresh as never, 60));
  await freshDoor.sync();
  const freshServer = createApi(freshDoor, TOKEN);
  await new Promise<void>((resolve) => freshServer.listen(0, "127.0.0.1", resolve));
  const freshBase = `http://127.0.0.1:${(freshServer.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const response = await fetch(freshBase + path, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: response.status, body: (await response.json()) as any };
  };
  after(() => freshServer.close());
  const range = (query: string) => get(`/history${query}`);
  assert.equal((await range("")).body.history.length, 7 * 24);
  const from = new Date(now - 30 * hour).toISOString();
  const until = new Date(now - 20 * hour).toISOString();
  assert.equal((await range(`?from=${from}&until=${until}`)).body.history.length, 11);
  assert.ok((await range("")).body.keptFrom < from);
  for (const bad of ["?from=yesterday", "?until=2026-13-45T00:00", `?from=${until}&until=${from}`]) {
    assert.equal((await range(bad)).status, 400, bad);
  }
  const { battery } = (await get("/status")).body;
  assert.equal(battery.perDay, 2);
  assert.ok(battery.daysLeft >= 19 && battery.daysLeft <= 21, `days left ${battery.daysLeft}`);
});

test("adds, changes and deletes a user", async () => {
  const created = await call("POST", "/users", { name: "Bob", schedule: { type: "weekly", days: ["fri"], start: "18:00", end: "22:00" } });
  assert.equal(created.status, 201);
  assert.match(created.body.pin, /^\d{6}$/);
  const id = created.body.user.id;
  assert.ok((await call("GET", "/users")).body.users.some((user: { id: string }) => user.id === id));

  assert.equal((await call("PUT", `/users/${id}/pin`, { pin: "4455" })).body.pin, "4455");
  const always = await call("PUT", `/users/${id}/schedule`, { type: "always" });
  assert.deepEqual(always.body.user.schedules, [{ type: "always" }]);
  assert.equal((await call("DELETE", `/users/${id}`)).status, 200);
  assert.equal((await call("DELETE", `/users/${id}`)).status, 404);
});

test("rejects bad input", async () => {
  const cases: [string, string, unknown, number][] = [
    ["POST", "/users", "{", 400],
    ["POST", "/users", "[]", 400],
    ["POST", "/users", { name: 5 }, 400],
    ["POST", "/users", { name: "Eve", pin: "12" }, 400],
    ["POST", "/users", { name: "Eve", schedule: { type: "weekly" } }, 400],
    ["POST", "/users", { name: "x".repeat(20_000) }, 400],
    ["POST", "/users", { name: "Ana" }, 409],
    ["PUT", "/users/01/pin", {}, 409],
    ["PUT", "/users/../pin", {}, 404],
  ];
  for (const [method, path, body, status] of cases) {
    assert.equal((await call(method, path, body)).status, status, `${method} ${path} ${JSON.stringify(body).slice(0, 40)}`);
  }
});

test("needs a login before it changes anything", async () => {
  driver.connected = false;
  assert.equal((await call("POST", "/users", { name: "Zoe" })).status, 503);
  assert.equal((await call("POST", "/login", { answer: "123" })).status, 400);
  assert.deepEqual((await call("POST", "/login")).body.login, { status: "code" });
  assert.deepEqual((await call("GET", "/status")).body.lock, null);
  assert.deepEqual((await call("POST", "/login", { answer: "654321" })).body.login, { status: "connected" });
});
