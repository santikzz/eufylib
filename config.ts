import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { EufyError } from "./errors.ts";
import type { Credentials } from "./eufylib.ts";

export type Config = { credentials: Credentials; serial: string | undefined; dataDir: string };

// real environment variables win over .env, so Docker needs no file
export function loadConfig(): Config {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { EUFY_USERNAME: username, EUFY_PASSWORD: password, EUFY_COUNTRY: country } = process.env;
  if (!username || !password || !country || !/^[A-Z]{2}$/.test(country)) {
    throw new EufyError("Set EUFY_USERNAME, EUFY_PASSWORD and EUFY_COUNTRY (two capital letters).", "invalid");
  }
  return {
    credentials: { username, password, country },
    serial: process.env.EUFY_LOCK || undefined,
    dataDir: resolve(process.env.DATA_DIR || "data"),
  };
}
