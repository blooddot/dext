import { createHash } from "node:crypto";

/** The preview/apply and assertion checks must agree byte for byte. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
