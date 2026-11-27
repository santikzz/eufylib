# eufylib REST API

Start it with `npm start`, `npx eufylib-api` or the Docker image. It listens on `HOST:PORT`, `127.0.0.1:8090` by
default.

## Authentication

Send `Authorization: Bearer <API_TOKEN>` with every request, except `GET /up`. A missing or wrong token gets `401`.

## Behavior

- Bodies and replies are JSON.
- The service runs one eufy task at a time. A change can take up to 45 seconds, because it waits for the lock.
- `GET /users` and `GET /history` read a cache. The service refreshes it every 5 minutes, after each change and on
  `POST /sync`.
- The cache keeps the history of the last 90 days. The first sync reads all of it from eufy, page by page. The next
  syncs read only the last day again.
- Times are the wall clock of the lock, without a time zone.

## Endpoints

| Method | Path | Body | Reply |
|---|---|---|---|
| `GET` | `/up` | | `{ "ok": true }`, no token needed |
| `GET` | `/status` | | [Status](#status) |
| `POST` | `/login` | `{ "answer": "123456" }` or nothing | `{ "login": LoginState }` |
| `GET` | `/users` | | `{ "users": [User], "syncedAt": "..." }` |
| `GET` | `/history?from=&until=` | | `{ "history": [Access], "keptFrom": "...", "syncedAt": "..." }`, newest first |
| `POST` | `/sync` | | same as `GET /users`, read from eufy now |
| `POST` | `/users` | `{ "name", "pin"?, "schedule"? }` | `201 { "user": User, "pin", "warning" }` |
| `PUT` | `/users/:id/pin` | `{ "pin"? }` | `{ "user": User, "pin" }` |
| `PUT` | `/users/:id/schedule` | [Schedule](#schedule) | `{ "user": User, "warning" }` |
| `PUT` | `/users/:id/name` | `{ "name" }` | `{ "user": User, "warning" }`, rename a person |
| `DELETE` | `/users/:id` | | `{ "user": User }` |
| `DELETE` | `/users-named/:name` | | `{ "deleted": <count> }`, removes every user with that exact name |
| `PUT` | `/settings/:name` | `{ "value" }` | `{ "ok": true, "setting" }`, value boolean, number or text |
| `POST` | `/lock` and `/unlock` | | `{ "ok": true, "locked" }` |

- `from`, `until`: ISO 8601 times, for example `2026-11-18T03:00:00.000Z`. `until` is now when it is not given, and
  `from` is 7 days before `until`. `keptFrom` is the start of the 90 days in the cache: an older `from` gets no more.
- `name`: 1 to 255 bytes of printable text, unique on the lock.
- `pin`: 4 to 8 digits. Without it the service makes a random 6-digit PIN. The reply is the only place it appears.
- `schedule`: `{ "type": "always" }` when it is not given.
- `warning`: not null when the lock has the new schedule but the copy for the eufy app did not change. Save the same
  schedule again. On a rename it is not null when the rename may have reset the person's schedule.
- `/users-named/:name`: deletes every user with that exact name. The client matches by name, so duplicates cannot be
  told apart and are removed as a group. The eufy app hides some entries (expired, orphaned), so a name can look
  unique there and be a duplicate here. URL-encode a name that has spaces.
- `/settings/:name`: writes a setting the lock reports as writable, for example `autoLockTimer` or
  `wrongTryProtection`. The CLI `caps` lists the writable names. The value is a boolean, a number or text.
- `/lock` and `/unlock`: whoever holds the token can open the door, so keep the API private.

## Types

### User

```json
{
  "id": "0007",
  "name": "Ana Paz",
  "type": 4,
  "isAdmin": false,
  "pins": 1,
  "fingerprints": 0,
  "schedules": [{ "type": "weekly", "days": ["mon", "fri"], "start": "09:00", "end": "18:00" }]
}
```

`type` is the eufy user type: `4` entry only, `1` admin, `2` owner. `schedules` has one entry per distinct schedule
of the PINs and fingerprints of the person.

### Access

```json
{ "time": "2026-11-25T21:00:00.000Z", "event": "pw unlock", "userId": "0007", "user": "Ana Paz", "battery": 80 }
```

`event` is the eufy event name in lowercase, for example `pw unlock`, `fingerprint unlock`, `manual unlock`,
`auto lock` or `mechanical anomaly`. `userId` and `user` are null when the event does not prove who did it, such as
auto lock or the inside knob. `battery` is the battery percent, or null.

### Schedule

```json
{ "type": "always" }
{ "type": "range", "from": "2026-12-01T18:00", "until": "2026-12-31T23:59" }
{ "type": "weekly", "days": ["mon", "tue", "wed", "thu", "fri"], "start": "09:00", "end": "18:00" }
```

- `range`: valid from `from` until `until`, as one continuous period.
- `weekly`: valid on the given days, from `start` to `end`. `days` uses `sun`, `mon`, `tue`, `wed`, `thu`, `fri`,
  `sat`. `end` is after `start` on the same day; `24:00` is the end of the day.
- A schedule made in the eufy app can come back as `{ "type": "unknown", "text": "..." }`, for example weekly
  hours between two dates.

### Status

```json
{
  "login": { "status": "connected" },
  "lock": { "serial": "T8520...", "name": "Front door", "model": "T8510P", "locked": true, "battery": 80 },
  "battery": { "perDay": 0.9, "daysLeft": 37, "emptyAt": "2027-01-01T08:00:00.000Z", "since": "...", "points": 6 },
  "syncedAt": "2026-11-25T21:00:00.000Z",
  "syncError": null
}
```

`battery` is an estimate of when the battery is empty, or null when the history does not show enough drain yet. The
service draws a straight line through the moments the battery reached a new low since the last battery change, and
extends it to 0 %. It needs 3 such moments over 3 days or more. `perDay` is the percent points lost each day, and
`points` is the number of moments on the line. The drain changes with use and temperature, and the lock reports
whole percents, so treat it as a guide.

### LoginState

| `status` | Meaning | What to do |
|---|---|---|
| `connected` | logged in | nothing |
| `code` | eufy sent a code to the account email | `POST /login` with `{ "answer": "<code>" }` |
| `captcha` | `image` holds the captcha as a data URL | `POST /login` with `{ "answer": "<text>" }` |
| `disconnected` | `error` says why | `POST /login` with no body starts a new login |

The service tries a login 3 times at most on its own, then it waits for `POST /login`. Wrong answers can lock the
eufy account for a while.

## Errors

```json
{ "error": "conflict", "message": "A user named \"Ana Paz\" already exists." }
```

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid` | the input is wrong |
| 401 | `unauthorized` | the token is missing or wrong |
| 404 | `not_found` | no such user or route |
| 409 | `conflict` | the name or the PIN is in use, the user is an admin, or two users share the name |
| 502 | `refused` | the lock or the cloud refused |
| 503 | `unavailable` | not logged in, or eufy does not answer |
| 504 | `unconfirmed` | sent, but not confirmed in time |

After `504`, read `GET /users` before you retry: the change may still take effect. After a failed create, the cloud
can keep an entry without a working PIN. Delete it.
