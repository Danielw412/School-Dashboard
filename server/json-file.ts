import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Moves a finished temporary file over the saved one. `contents` lets a caller fall back to a
// direct write when the rename keeps failing.
export type ReplaceFile = (temporaryPath: string, destination: string, contents: string) => Promise<void>;

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

// Saves a value this process keeps in memory to its JSON file. Only this process writes the file,
// so it is never read back after loading. Writes are atomic (temporary file, then rename) and
// coalesced: however many changes arrive while a write is underway, the next write carries the
// latest value, so a burst of changes costs one or two writes rather than one each.
export class JsonFileWriter {
  private version = 0;
  private savedVersion = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly path: string,
    private readonly snapshot: () => unknown,
    private readonly replace: ReplaceFile = (temporaryPath, destination) => rename(temporaryPath, destination),
    private readonly onBackgroundError: (error: unknown) => void = () => undefined,
  ) {}

  // The value changed and must be on disk before the caller continues.
  save(): Promise<void> {
    this.version += 1;
    return this.flush();
  }

  // The value changed; write it within `delayMs`. A failure is reported to `onBackgroundError`, and
  // the next save writes the change again.
  saveSoon(delayMs = 1_000): void {
    this.version += 1;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(this.onBackgroundError);
    }, delayMs);
    this.timer.unref?.();
  }

  // Writes any change not yet on disk; resolves once it is.
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const target = this.version;
    const operation = this.chain.catch(() => undefined).then(async () => {
      if (this.savedVersion >= target) return;
      const version = this.version;
      await writeJsonAtomically(this.path, this.snapshot(), this.replace);
      this.savedVersion = version;
    });
    this.chain = operation;
    return operation;
  }
}

async function writeJsonAtomically(path: string, value: unknown, replace: ReplaceFile): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await replace(temporaryPath, path, contents);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// Removes temporary files an earlier process left behind when it stopped mid-write. Call it before
// this process starts writing `path`.
export async function removeStaleTemporaryFiles(path: string): Promise<void> {
  const prefix = `${basename(path)}.`;
  try {
    const names = await readdir(dirname(path));
    await Promise.all(names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
      .map((name) => rm(join(dirname(path), name), { force: true }).catch(() => undefined)));
  } catch {
    // No data directory yet.
  }
}
