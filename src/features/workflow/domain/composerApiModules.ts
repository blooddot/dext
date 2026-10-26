/**
 * The API modules the composer receives from a root the generated project cannot name.
 *
 * `.dext/tsconfig.json` maps `dext/api/*` only at project-relative directories: a
 * committed file must not carry a machine-local path such as Dext's global storage.
 * The composer has no such constraint. Its extra libraries are registered in memory,
 * so a global API module can be typed without ever entering the generated project.
 *
 * Project modules keep their ids. A global module is only offered when no project
 * module answers to the same id, because the kernel searches `.dext/api` first and a
 * completed import has to resolve to the source its symbol came from.
 */

/** Virtual directory under the composer's `file:///dext` root that holds global API
 * modules. The name only has to stay clear of the virtual paths project modules get. */
export const COMPOSER_GLOBAL_API_DIRECTORY = "__dext-global-api__";

/** `dext/api/*` candidates for the virtual directory, appended after the generated
 * project's own candidates. The order is what makes a project API shadow a global one. */
export const COMPOSER_GLOBAL_API_PATHS: readonly string[] = [
  `./${COMPOSER_GLOBAL_API_DIRECTORY}/*.ts`,
  `./${COMPOSER_GLOBAL_API_DIRECTORY}/*.mts`,
  `./${COMPOSER_GLOBAL_API_DIRECTORY}/*/index.ts`
];

export interface ComposerApiModule {
  /** Path below the composer's virtual workspace root. */
  path: string;
  /** The `dext/api/<id>` specifier the kernel resolves. */
  specifier: string;
  content: string;
}

export interface ComposerApiSource {
  /** Path below its API root, with the source extension. */
  relative: string;
  content: string;
}

const API_SPECIFIER_PREFIX = "dext/api/";

/** The id a module below an API root is imported by. An `index` module answers to
 * its directory, matching the generated project's directory-index candidate. */
export function composerApiId(relative: string): string {
  return relative
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\.(ts|mts)$/i, "")
    .replace(/\/index$/i, "");
}

/** Every id a project module already answers to, including the directory id of an
 * `index` module, so a global module cannot silently take over its completion. */
function projectApiIds(modules: readonly ComposerApiModule[]): Set<string> {
  const ids = new Set<string>();
  for (const module of modules) {
    if (!module.specifier.startsWith(API_SPECIFIER_PREFIX)) continue;
    const id = module.specifier.slice(API_SPECIFIER_PREFIX.length);
    ids.add(id);
    if (id.endsWith("/index")) ids.add(id.slice(0, -"/index".length));
  }
  return ids;
}

/** The kernel tries `.ts` before `.mts`, then a directory index. Sorting by that same
 * order keeps the symbol source and the virtual file its import resolves to in step. */
function sourceOrder(source: ComposerApiSource): number {
  const relative = source.relative.replaceAll("\\", "/");
  if (/\.ts$/i.test(relative) && !/\/index\.ts$/i.test(relative)) return 0;
  if (/\.mts$/i.test(relative) && !/\/index\.mts$/i.test(relative)) return 1;
  if (/\/index\.ts$/i.test(relative)) return 2;
  return 3;
}

/**
 * The global modules to register, in the kernel's resolution order, after every
 * project module.
 *
 * A global `git/commit.ts` is registered at
 * `__dext-global-api__/git/commit.ts` and offered as `dext/api/git/commit`; the
 * appended `paths` candidates resolve that specifier to the same virtual file the
 * type service knows. The id is claimed as soon as it is offered, so two global roots
 * cannot both supply one id either.
 */
export function composerGlobalApiModules(
  projectModules: readonly ComposerApiModule[],
  globalSources: readonly ComposerApiSource[]
): ComposerApiModule[] {
  const claimed = projectApiIds(projectModules);
  const modules: ComposerApiModule[] = [];
  const ordered = [...globalSources].sort((left, right) =>
    sourceOrder(left) - sourceOrder(right) || left.relative.localeCompare(right.relative));
  for (const source of ordered) {
    const relative = source.relative.replaceAll("\\", "/").replace(/^\.\//, "");
    const id = composerApiId(relative);
    if (!relative || !id || claimed.has(id)) continue;
    claimed.add(id);
    modules.push({
      path: `${COMPOSER_GLOBAL_API_DIRECTORY}/${relative}`,
      specifier: `${API_SPECIFIER_PREFIX}${id}`,
      content: source.content
    });
  }
  return modules;
}
