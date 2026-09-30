/**
 * Node announces TypeScript stripping with an `ExperimentalWarning` the first
 * time it runs. Dext calls that API on the user's behalf, so the warning is not
 * something the program did — left alone it lands in the first step of Output and
 * in every captured stderr step.
 *
 * Both the kernel and the loader thread call the stripping API, and each thread
 * has its own warning state, so both import and call this.
 */
export function silenceTypeStrippingWarnings() {
  const original = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...rest) => {
    const message = typeof warning === "string" ? warning : warning?.message ?? "";
    if (message.includes("stripTypeScriptTypes")) return;
    return original(warning, ...rest);
  };
}
