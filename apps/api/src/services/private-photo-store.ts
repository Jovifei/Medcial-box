import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type PrivatePhotoType = "image/jpeg" | "image/png";

export interface PrivatePhotoIdentity {
  familyId: string;
  medicineId: string;
  photoId: string;
  contentType: PrivatePhotoType;
}

export function privatePhotoStorageKey(input: PrivatePhotoIdentity): string {
  for (const id of [input.familyId, input.medicineId, input.photoId]) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error("invalid private photo identity");
  }
  const extension = input.contentType === "image/jpeg" ? "jpg" : "png";
  return `leaflets/${input.familyId}/${input.medicineId}/${input.photoId}.${extension}`;
}

export class PrivatePhotoStore {
  private readonly root: string;

  constructor(rootDirectory = process.env.PRIVATE_UPLOAD_DIR ?? "./var/private-uploads") {
    this.root = resolve(rootDirectory);
  }

  async save(input: {
    familyId: string;
    medicineId: string;
    photoId: string;
    contentType: PrivatePhotoType;
    bytes: Buffer;
  }): Promise<string> {
    const key = privatePhotoStorageKey(input);
    const path = this.resolveKey(key);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return key;
  }

  read(storageKey: string): Promise<Buffer> {
    return readFile(this.resolveKey(storageKey));
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.resolveKey(storageKey), { force: true });
  }

  private resolveKey(storageKey: string): string {
    if (storageKey.includes("\\") || isAbsolute(storageKey) || storageKey.split("/").some((part) => part === ".." || part === "")) {
      throw new Error("invalid storage key");
    }
    const path = resolve(this.root, storageKey);
    const relativePath = relative(this.root, path);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("invalid storage key");
    }
    return path;
  }
}
