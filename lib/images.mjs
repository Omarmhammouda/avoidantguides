// Shared image handling for both entry points (worker.mjs, server.mjs).
// The browser already downscales and re-encodes to JPEG; this is the trust
// boundary — nothing here believes what the client claims.

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 3_500_000; // per image, decoded

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Keep only well-formed, in-budget base64 images. Bad entries are dropped, not fatal. */
export function sanitizeImages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_IMAGES)) {
    const mediaType = typeof item?.media_type === "string" ? item.media_type.trim().toLowerCase() : "";
    const data = typeof item?.data === "string" ? item.data.replace(/\s+/g, "") : "";
    if (!ALLOWED_TYPES.has(mediaType)) continue;
    if (data.length < 32 || !BASE64.test(data)) continue;
    if (data.length * 0.75 > MAX_IMAGE_BYTES) continue;
    out.push({ media_type: mediaType, data });
  }
  return out;
}

/** Images first, then the text — the ordering Claude's vision guidance recommends. */
export function userContent(text, images) {
  if (images.length === 0) return text;
  return [
    ...images.map((im) => ({
      type: "image",
      source: { type: "base64", media_type: im.media_type, data: im.data },
    })),
    { type: "text", text },
  ];
}

/** Line appended to the question so the model knows screenshots are attached. */
export function imageNote(count) {
  if (count === 0) return "";
  return count === 1
    ? "\n\n(The user attached 1 screenshot above — read it and work from what it actually says.)"
    : `\n\n(The user attached ${count} screenshots above — read them and work from what they actually say.)`;
}
