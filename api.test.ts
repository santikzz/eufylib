import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApi } from "./api.ts";
import { Door } from "./door.ts";
import { EufyLib } from "./eufylib.ts";
import { FakeDriver } from "./fake-driver.ts";

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

test("serves the cached users after a sync", async () => {
  assert.equal((await call("GET", "/users")).status, 503);
  await door.tick();
  const { status, body } = await call("GET", "/users");
  assert.equal(status, 200);
  assert.equal(body.users.length, 4);
  assert.equal((await call("GET", "/status")).body.lock.serial, "T8520K8FAKE");
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
