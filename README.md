# eufylib

Manage the people, PINs and schedules of a eufy smart lock. Use it as a TypeScript library, a REST API or a CLI.

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D24-339933)

```
your code / backoffice / terminal
        |
     eufylib  (library, REST API, CLI)
        |
eufy-security-client  ->  eufy cloud  ->  lock (P2P)
```

eufylib logs in to your eufy account as the eufy phone app does. It needs no hub, no bridge and no database.

## Features

- List the people of the lock, with their PIN and fingerprint counts and their schedules
- Create a person with a PIN, change a PIN, rename a person, delete a person
- Delete every person that shares a name at once (the client matches by name)
- Schedules: always, a date range, or weekly hours. The lock enforces them, also when it is offline
- Lock and unlock, live events, battery, and write any setting the lock reports as writable
- Access history: who opened the door, how and when, with a battery estimate from it
- 2FA code and captcha login
- Each change waits for the confirmation of the lock, not only for the cloud
- REST API with a bearer token, one change at a time, and a user and history cache that refreshes every 5 minutes

## Requirements

- Node.js 24 or later
- A eufy account that can manage the lock

Tested on the Smart Lock S230 (T8510P). Other eufy Wi-Fi locks use the same commands in
[eufy-security-client](https://github.com/bropat/eufy-security-client), but they are not tested.

## Install

```sh
git clone <this repository> eufylib
cd eufylib
npm install
cp .env.example .env    # then fill in your account
```

## CLI

```sh
npm run cli                                       # interactive shell, prints live events
npm run cli -- users
npm run cli -- add "Ana Paz" - 2026-12-31         # random PIN, valid until the end of that day
npm run cli -- pin "Ana Paz"
npm run cli -- rename "Ana Paz" "Ana P"
npm run cli -- schedule "Ana Paz" mon,fri 09:00 18:00
npm run cli -- set autoLockTimer 60               # any writable setting from `caps`
npm run cli -- delete "Ana Paz"                   # a duplicated name deletes all who share it (asks first)
npm run cli -- history 7
npm run cli -- help
```

The first run asks for the code or the captcha if eufy wants one.

## REST API

```sh
npm start             # http://127.0.0.1:8090
```

```sh
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8090/users

curl -X POST -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8090/users \
  -d '{ "name": "Ana Paz", "schedule": { "type": "weekly", "days": ["mon", "fri"], "start": "09:00", "end": "18:00" } }'

curl -X PUT -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8090/users/<id>/name -d '{ "name": "Ana P" }'
curl -X PUT -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8090/settings/autoLockTimer -d '{ "value": 60 }'
curl -X DELETE -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8090/users-named/Nobel   # deletes all named Nobel
curl -X POST -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8090/unlock
```

See [API.md](API.md) for every endpoint, the schedule format and the error codes.

## Library

```ts
import { EufyLib } from "eufylib";

const eufy = await EufyLib.open({ username, password, country: "US" }, "./data", console.error);
const login = await eufy.login();
if (login.status !== "connected") throw new Error(`eufy wants: ${login.status}`); // answer with eufy.login({ code })

const lock = await eufy.lock();
const { user } = await lock.addUser("Ana Paz", "482913", {
  type: "range",
  from: "2026-12-01T00:00",
  until: "2026-12-31T23:59",
});
await lock.rename(user.id, "Ana P");
await lock.setSetting("autoLockTimer", 60);
console.log(user, await lock.history(new Date(Date.now() - 7 * 86_400_000)));
eufy.close();
```

Errors are `EufyError` with a `kind`: `invalid`, `not_found`, `conflict`, `refused`, `unavailable` or `unconfirmed`.

## Configuration

Real environment variables override `.env`.

| Variable | Default | Use |
|---|---|---|
| `EUFY_USERNAME` | | eufy account email |
| `EUFY_PASSWORD` | | eufy account password |
| `EUFY_COUNTRY` | | ISO 3166-1 alpha-2 code of the account, for example `US` |
| `EUFY_LOCK` | | lock serial, only when the account has several locks |
| `DATA_DIR` | `./data` | folder for the eufy session |
| `API_TOKEN` | | API only: bearer token, 32 characters or more |
| `HOST` | `127.0.0.1` | API only: listen address |
| `PORT` | `8090` | API only: listen port |

The session in `DATA_DIR` lets a restart skip the login. Run one process per account and `DATA_DIR`: a second login
can end the first session, and repeated logins can make eufy ask for a captcha.

## Docker

```sh
docker compose up -d --build
docker compose logs -f
```

The API listens on `127.0.0.1:8090` of the host. The eufy session stays in the `eufylib-data` volume. If eufy asks
for a captcha or a code, read it from `GET /status` and send the answer to `POST /login`. Do not run the CLI against
the same volume while the container runs.

## Security

- Whoever has the API token can add a PIN or unlock the door, so the token is a key to the door. Keep the API on a
  private network or on loopback.
- PINs leave the API once, in the reply that creates or changes them. eufylib does not store or log them.
- `.env` holds your eufy password and `DATA_DIR` holds your session. Keep both private.

## Known limits

- The user list comes from the eufy cloud, which usually hides PINs. Save each PIN when you create it.
- `unconfirmed` means that the command was sent but not confirmed in time. It may still take effect, so read the
  users before you retry.
- Rename can reset the schedule of a person: the lock rewrites them as entry only and rebuilds the hours from the
  cloud copy. The reply carries a `warning` when the person had a schedule; set it again after a rename.
- Duplicate names: the client deletes and renames by exact name, so two people with the same name cannot be told
  apart. `delete` (and `DELETE /users-named/:name`) removes all of them at once; split a single one only in the
  eufy app. The eufy app hides some cloud entries (expired, orphaned), so a name can look unique there and be a
  duplicate in this list.
- Fingerprints: the lock enrolls one only at the sensor, so this cannot add a fingerprint remotely, and cannot
  delete a single fingerprint without the person. Delete the whole person instead.
- No separate "force" or "hard" delete: `delete` is the normal delete. A refused delete can leave a cloud entry
  behind; read the list and retry.
- The lock does not report a time or time zone, so a drifted lock clock shifts when a schedule starts and ends.
  Re-open the lock in the eufy app to resync its clock.
- Admin users are read only. Change them in the eufy app.
- eufy is moving to a new cloud, and eufy-security-client depends on the old one. eufylib can stop working without
  notice when eufy closes it. The cloud schedule copy uses the current `v3` endpoint, with the old `v1` as a fallback.
- eufylib fixes an encoding bug in eufy-security-client 4.1.0 that drops the days of weekly schedules that use only
  Sunday to Wednesday.

## Development

```sh
npm test              # unit and API tests, no lock needed
npm run typecheck
npm run build         # compiles to dist/ for the npm package
```

## Disclaimer

eufylib is not affiliated with, endorsed by or sponsored by Anker Innovations or eufy. "eufy" and "Anker" are
trademarks of their owners and appear only to name the hardware. Use eufylib only with locks that you own or manage.
A bug can let the wrong person in or lock the right person out, so test each change on your own door first.

## Credits

Built on [eufy-security-client](https://github.com/bropat/eufy-security-client) by bropat and its contributors (MIT).

## License

[MIT](LICENSE)
