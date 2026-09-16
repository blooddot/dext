/** Dext mounts one preset from the installed Harness catalog on every Harness
 * conversation, so the catalog is the only source of preset choices. A
 * conversation without a choice - a new one, or one persisted before presets
 * were mandatory - runs the Harness default. */
export const DEFAULT_HARNESS_PRESET = "standard";

/** An empty selection means "no choice yet" and never the raw ACP profile
 * composition: it reads back as the Harness default, both for menus and for the
 * preset Dext mounts. */
export function harnessPresetOrDefault(preset: string | undefined): string {
  return preset || DEFAULT_HARNESS_PRESET;
}
