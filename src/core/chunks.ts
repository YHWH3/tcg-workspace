/** Chunk math shared by the client upload queue and unit tests. */
export const CHUNK_SIZE = 1024 * 1024; // 1 MiB
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

export const chunkCount = (size: number) => Math.max(1, Math.ceil(size / CHUNK_SIZE));
export const chunkSlice = (blob: Blob, idx: number) => blob.slice(idx * CHUNK_SIZE, Math.min((idx + 1) * CHUNK_SIZE, blob.size));
