import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

export class ProjectCredentialStore implements CredentialStore {
  #chain = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly legacyFile?: string,
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.#all())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.#all()).map(
      ([providerId, credential]) => ({ providerId, type: credential.type })
    );
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    let result: Credential | undefined;
    await this.#serialized(async () => {
      const all = await this.#all();
      const current = all[providerId];
      const next = await fn(current);
      // The pi-ai contract: undefined leaves the entry unchanged.
      result = next ?? current;
      if (next === undefined) return;
      all[providerId] = next;
      await this.#write(all);
    });
    return result;
  }

  async delete(providerId: string): Promise<void> {
    await this.#serialized(async () => {
      const all = await this.#all();
      if (!(providerId in all)) return;
      delete all[providerId];
      await this.#write(all);
    });
  }

  async #serialized(operation: () => Promise<void>): Promise<void> {
    const work = this.#chain.then(() => this.#locked(operation));
    this.#chain = work.catch(() => undefined);
    await work;
  }

  async #write(all: Record<string, Credential>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp";
    await writeFile(temporary, JSON.stringify(all, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temporary, this.file);
  }

  async #all(): Promise<Record<string, Credential>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Record<
        string,
        Credential
      >;
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      ) {
        if (this.legacyFile)
          return new ProjectCredentialStore(this.legacyFile).#all();
        return {};
      }
      throw error;
    }
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true });
    const lock = this.file + ".lock";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (attempt === 99)
        throw new Error("Timed out waiting for the credential store.");
    }
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}
