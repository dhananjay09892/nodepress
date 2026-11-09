import type { MediaRecord, MediaStore, StorageAdapter } from '../media.js';

/** In-memory StorageAdapter for tests. */
export function memoryStorage(): StorageAdapter & {
  files: Map<string, { data: Buffer; contentType: string }>;
} {
  const files = new Map<string, { data: Buffer; contentType: string }>();
  return {
    files,
    async put(key, data, contentType) {
      if (files.has(key)) throw new Error(`exists: ${key}`);
      files.set(key, { data: Buffer.from(data), contentType });
    },
    async get(key) {
      return files.get(key)?.data;
    },
    async delete(key) {
      files.delete(key);
    },
  };
}

/** In-memory MediaStore for tests. */
export function memoryMediaStore(): MediaStore & { rows: Map<number, MediaRecord> } {
  const rows = new Map<number, MediaRecord>();
  let nextId = 1;
  return {
    rows,
    async insert(row) {
      const rec: MediaRecord = { id: nextId++, ...row, createdAt: new Date() };
      rows.set(rec.id, rec);
      return { ...rec };
    },
    async findById(id) {
      const r = rows.get(id);
      return r && { ...r };
    },
    async list({ limit, offset, uploadedBy }) {
      return [...rows.values()]
        .filter((r) => uploadedBy === undefined || r.uploadedBy === uploadedBy)
        .sort((a, b) => b.id - a.id)
        .slice(offset, offset + limit)
        .map((r) => ({ ...r }));
    },
    async updateAlt(id, alt) {
      const r = rows.get(id);
      if (!r) return undefined;
      r.alt = alt;
      return { ...r };
    },
    async delete(id) {
      return rows.delete(id);
    },
  };
}
