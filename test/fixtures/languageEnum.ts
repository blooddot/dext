/**
 * `enum` is valid TypeScript but it is not erasable: stripping it would have to
 * emit runtime code, which is exactly what Dext forbids. This fixture documents
 * the boundary shared by `tsc` (`erasableSyntaxOnly` in the generated
 * `.dext/tsconfig.json`) and the kernel (`module.stripTypeScriptTypes` in
 * "strip" mode). It is excluded from this repository's project and lint config
 * because it is user code, not extension code.
 *
 * `test/dextTypes.test.ts` feeds this file to `module.stripTypeScriptTypes` and
 * asserts the readable `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` error, and asserts
 * that `src/runner/dextLoader.mjs` passes that code and message through.
 */

/** The otherwise-valid part: a plain type alias and a constant. */
export type DextPhaseLabel = string;

export const DEFAULT_PHASE_LABEL: DextPhaseLabel = "plan";

/** The rejected part: an enum needs emitted runtime code. */
export enum DextPhase {
  Plan = "plan",
  Build = "build"
}

export const activePhase: DextPhase = DextPhase.Build;
