/**
 * Folders a harness mounts in a sandbox (protocol 15): our engine's skill folders,
 * `/skills/<name>@<hash>/` (`skillFolderOf`, track R2 M4, D66), each one version's files,
 * read-only, so the model can read them and run their scripts with bash. Our engine decides which
 * folders and when (before each sandbox call); the SandboxManager writes them once per open
 * handle (`mountFolder`). A version's folder is written once and never replaced: sessions whose
 * agents carry different versions of one skill share an Environment, and run turns at once,
 * without changing each other's files. Folders live outside the persisted disk, so a stop clears
 * them and the next call mounts them again.
 */
import { posix } from "node:path";
import { helperCommandTimeoutMs, quote } from "./tools.js";
import type { SandboxFileBytes, SandboxHandle } from "./types.js";
import { hostTuning } from "../tuning.js";

/** A folder's files, by path in it, as `sha256:<hex>`. */
export type FolderFiles = Readonly<Record<string, string>>;

/**
 * Writes one folder's files to `root`, replacing a partial copy a failed mount left, and makes
 * them read-only. `read` gives a file's bytes by `sha256:<hex>`, whole or as chunks, which are
 * written as they come.
 */
export async function mountFolderFiles(
  handle: SandboxHandle,
  root: string,
  files: FolderFiles,
  read: (sha256: string) => Promise<SandboxFileBytes>,
  signal: AbortSignal
): Promise<void> {
  const exec = async (command: string) => {
    const result = await handle.exec({ command, cwd: "/", timeoutMs: helperCommandTimeoutMs() }, signal);
    if (result.exitCode !== 0)
      throw new Error(`${command.slice(0, hostTuning().harness.helperCommandExcerptChars)} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  };
  const directories = new Set<string>([root]);
  for (const path of Object.keys(files)) directories.add(posix.dirname(posix.join(root, path)));
  await exec(
    `if [ -e ${quote(root)} ]; then chmod -R u+w ${quote(root)} && rm -rf ${quote(root)}; fi && mkdir -p ${[...directories].map(quote).join(" ")}`
  );
  for (const [path, sha256] of Object.entries(files))
    await handle.writeFile(posix.join(root, path), await read(sha256));
  await exec(`chmod -R a-w ${quote(root)}`);
}
