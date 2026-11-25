export type ErrorKind = "invalid" | "not_found" | "conflict" | "refused" | "unavailable" | "unconfirmed";

export class EufyError extends Error {
  kind: ErrorKind;

  constructor(message: string, kind: ErrorKind = "refused") {
    super(message);
    this.kind = kind;
  }
}

// the command was sent but nothing confirmed it, so it may have worked
export class Unconfirmed extends EufyError {
  constructor(message: string) {
    super(message, "unconfirmed");
  }
}
