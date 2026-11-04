import type {BlobRow, EncodedBlobRow} from './db';
// Keep the wire buffer available for a later quarantine move without awaiting
// Blob.arrayBuffer() inside its atomic IndexedDB transaction. Weak keys release
// the buffer when the decoded Blob is no longer used; nothing is account-indexed.
const fallbackBytes = new WeakMap<Blob, ArrayBuffer>();
export function decodeBlobRow(row:BlobRow | EncodedBlobRow | undefined):BlobRow | undefined {
 if (!row || !('blobEncoding' in row)) return row;
 if (row.blobEncoding !== 'array-buffer-v1' || !(row.blobBytes instanceof ArrayBuffer)) throw new Error('invalid_local_attachment_encoding');
 const {blobEncoding: _encoding, blobBytes, ...metadata} = row;
 const blob = new Blob([blobBytes], {type:row.mime ?? ''});
 fallbackBytes.set(blob,blobBytes);
 return {...metadata,blob};
}
/** Preserve fallback bytes when retaining a decoded row in held-work storage. */
export function storedBlobRow(row:BlobRow):BlobRow | EncodedBlobRow {
 const bytes = fallbackBytes.get(row.blob);
 if (!bytes) return row;
 const {blob: _blob, ...metadata} = row;
 return {...metadata,blobEncoding:'array-buffer-v1',blobBytes:bytes};
}
