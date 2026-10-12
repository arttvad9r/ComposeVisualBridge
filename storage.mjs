import {writeFile, rename, link, rm, stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// A failed or partial write never truncates the destination. link provides
// atomic exclusive creation without replacing an existing helper file.
export async function writeTextAtomic(filename, text, {exclusive = false} = {}) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const mode = exclusive ? undefined : (await stat(filename).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }))?.mode;
  try {
    await writeFile(temporary, text, {flag: 'wx', ...(mode == null ? {} : {mode: mode & 0o777})});
    if (exclusive) await link(temporary, filename);
    else await rename(temporary, filename);
  } finally {
    await rm(temporary, {force: true}).catch(error => {
      console.error(`Не удалось удалить временный файл ${temporary}: ${error.message}`);
    });
  }
}
