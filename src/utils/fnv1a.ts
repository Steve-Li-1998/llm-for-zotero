/**
 * FNV-1a, 32-bit: a short, stable digest of a string. It is a fingerprint for
 * cache keys and change detection, never a security hash.
 *
 * Returns eight lowercase hex characters, so a key built from it stays bounded
 * no matter how long the input is.
 */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
