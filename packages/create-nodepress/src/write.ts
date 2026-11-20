import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { InstallError } from './options.js';

/** Files that hold secrets are readable by the owner only. */
const PRIVATE_FILES = new Set(['.env']);

/**
 * Write the files into `target`, which must not exist or must be an empty folder: an install
 * never overwrites anything. Paths that would leave the folder are refused.
 */
export async function writeProject(target: string, files: Map<string, string>): Promise<void> {
  const root = resolve(target);
  let existing: string[] = [];
  try {
    existing = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new InstallError('directory', `${root} is not a folder.`);
    }
  }
  if (existing.length > 0) {
    throw new InstallError('directory', `${root} is not empty. Choose a new folder name.`);
  }
  await mkdir(root, { recursive: true });
  for (const [path, content] of files) {
    const file = resolve(root, path);
    if (file !== root && !file.startsWith(root + sep)) {
      throw new InstallError('directory', `Refusing to write outside the site folder: ${path}`);
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, { mode: PRIVATE_FILES.has(path) ? 0o600 : 0o644 });
  }
}
