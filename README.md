# eufy-lock

Control a eufy smart lock from TypeScript or the terminal.

```
cli.ts -> eufylib.ts -> eufy-security-client -> eufy cloud and lock
```

It logs in as the eufy phone app does. There is no server and no bridge.

## Features

- Lock and unlock the door
- List people, with their PINs, fingerprints and hours (counts only, not the codes)
- Create a person with a PIN, with an optional last valid day
- Delete a person, change a PIN
- Access history: who, how and when
- Live events, battery, settings
- 2FA code and captcha login

Tested on a T8510P (S230): login, status, people, history.
Not tested on a real lock yet: lock, unlock, add, delete, PIN change, last valid day, live events.

## Setup

Create `.env`:

```
EUFY_USERNAME='email'
EUFY_PASSWORD='password'
EUFY_COUNTRY='AR'
```

Then run `npm install`. It also installs Node 24 for the scripts.

## Usage

```
npm run eufy                  open the shell, it prints live events
npm run eufy -- COMMAND       run one command
```

| Command | Action |
|---|---|
| `status` | state and battery |
| `caps` | all commands, settings and readings |
| `users` | list people |
| `add NAME [PIN] [YYYY-MM-DD]` | create, `-` makes a random PIN, the date is the last valid day |
| `delete USER [-y]` | USER is an id or a name |
| `pin USER [PIN]` | change a PIN, no PIN makes a random one |
| `history [COUNT]` | who opened the door |
| `lock`, `unlock` | move the bolt |
| `watch` | print live events |

Put names with spaces in quotes. If the account has several locks, set `EUFY_LOCK` to a serial.

## Library

```ts
import { EufyLib } from "./eufylib.ts";

const lib = await EufyLib.open({ username, password, country }, "data", console.error);
const login = await lib.login(); // status: connected, code or captcha
if (login.status !== "connected") throw new Error("Run npm run eufy to answer the code");

const lock = await lib.lock();
await lock.addUser("Ana", "482913", "2026-12-31");
console.log(await lock.users(), await lock.history(20));
lib.close();
```

Checks: `npm test` and `npm run typecheck`.

## Limits

- Save a PIN when you create it. The tool does not show it again.
- `Unconfirmed` means that the command may still take effect. Run `users` before you try again.
- There is no rename, because the client can widen the access of the person.
- The history names a person only for PIN, fingerprint and app events.
- The library uses the old eufy cloud. eufy is closing it, so it can stop without notice.
- Keep `.env` and `data/` private. They hold the password and the session.
