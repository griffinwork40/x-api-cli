import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Process-entry detection — "is THIS module the script node was asked to run?"
 *
 * ─── Why this is its own module ───────────────────────────────────────────────────
 * The answer gates `applyEnvFiles(process.env)` in cli.ts, which MUTATES the ambient
 * environment. A false positive therefore does not merely run the CLI when it should
 * not — it silently rewrites the env of whatever host imported us. That makes the
 * check load-bearing enough to test in isolation, without importing cli.ts (whose
 * module body runs the guard as a side effect of import).
 */

/**
 * True only when `moduleUrl` is the process entry named by `argvPath`.
 *
 * Both sides are realpath'd because the installed `x` bin is a SYMLINK — package.json
 * `bin` maps `x` → `dist/cli.js`, and npm/pnpm links that into a bin dir. Node then
 * reports the SYMLINK in `process.argv[1]` but the RESOLVED target in `import.meta.url`,
 * so a plain string compare fails for every global install. Resolving both is what lets
 * this be one exact check instead of the loose fallbacks it replaces:
 *
 *   before: import.meta.url === `file://${argv[1]}`   // breaks on spaces/unicode —
 *                                                     // `file://` skips URL encoding
 *        || import.meta.url.endsWith(argv[1])         // suffix match, not identity
 *        || argv[1].endsWith('cli.js')                // ANY host whose argv[1] ends
 *        || argv[1].endsWith('cli.ts')                // in cli.js matched
 *
 * The last two were the dangerous ones: an unrelated tool invoked as `.../cli.js` that
 * imported this package would satisfy the guard and have its `process.env` rewritten.
 */
export function isEntryPoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (argvPath === undefined || argvPath === '') return false;

  const modulePath = fileURLToPath(moduleUrl);
  // Fast path: no symlink in play (direct `node dist/cli.js`, `tsx src/cli.ts`).
  if (modulePath === argvPath) return true;

  try {
    return realpathSync(modulePath) === realpathSync(argvPath);
  } catch {
    // argv[1] does not resolve to a real file (bundler stub, deleted script, a bare
    // word). It cannot be this module, so fail CLOSED — never mutate a host's env on
    // an unresolvable path.
    return false;
  }
}
