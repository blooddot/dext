import { createHash } from "node:crypto";
import type { CodeRef } from "../../shared/contracts/types.js";
import type { TextSnapshot } from "../../shared/contracts/context.js";

/** Turns a resolved text snapshot into the auditable code reference the runtime
 * passes to a provider. */
export function toCodeRef(snapshot: TextSnapshot): CodeRef {
  return {
    kind: "codeRef",
    uri: snapshot.uri,
    ...(snapshot.range ? { range: snapshot.range } : {}),
    ...(snapshot.symbol ? { symbol: snapshot.symbol } : {}),
    documentVersion: snapshot.version,
    contentHash: createHash("sha256").update(snapshot.content).digest("hex"),
    content: snapshot.content
  };
}
