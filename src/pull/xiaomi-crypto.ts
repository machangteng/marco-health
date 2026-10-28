import { createHash, randomBytes } from "node:crypto";

/** clientSign for the stack X STS hop: Base64(SHA1("nonce=<nonce>&<ssecurity>")). */
export function clientSign(nonce: string, ssecurity: string): string {
  return createHash("sha1").update(`nonce=${nonce}&${ssecurity}`, "utf8").digest("base64");
}

export function signedNonce(ssecurity: string, nonce: string): string {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from(ssecurity, "base64"), Buffer.from(nonce, "base64")]))
    .digest("base64");
}

export function makeNonce(nowMs: number, entropy: Buffer = randomBytes(8)): string {
  const minutes = Buffer.alloc(4);
  minutes.writeUInt32BE(Math.floor(nowMs / 60_000), 0);
  return Buffer.concat([entropy.subarray(0, 8), minutes]).toString("base64");
}

/** RC4 with the first 1024 keystream bytes discarded, matching Xiaomi cloud signing. */
export function rc4Drop(key: Buffer, data: Buffer, skip = 1024): Buffer {
  if (key.length === 0) throw new Error("RC4 key is empty");
  const state = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) state[index] = index;
  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + (state[index] ?? 0) + (key[index % key.length] ?? 0)) & 255;
    const swap = state[index] ?? 0;
    state[index] = state[j] ?? 0;
    state[j] = swap;
  }
  let i = 0;
  j = 0;
  const next = (): number => {
    i = (i + 1) & 255;
    j = (j + (state[i] ?? 0)) & 255;
    const swap = state[i] ?? 0;
    state[i] = state[j] ?? 0;
    state[j] = swap;
    return state[((state[i] ?? 0) + (state[j] ?? 0)) & 255] ?? 0;
  };
  for (let count = 0; count < skip; count += 1) next();
  const output = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) output[index] = (data[index] ?? 0) ^ next();
  return output;
}

function signatureMessage(method: string, path: string, params: Record<string, string>, nonce: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const pairs = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key] ?? ""}`);
  return [method.toUpperCase(), normalized, ...pairs, nonce].join("&");
}

export type SealedParams = Record<string, string> & { _nonce: string };

/** Seal a GET/POST param object the way hlth.io.mi.com expects. */
export function sealParams(
  method: string,
  path: string,
  ssecurity: string,
  params: Record<string, unknown>,
  nowMs: number,
  entropy?: Buffer,
): SealedParams {
  const nonce = makeNonce(nowMs, entropy);
  const snonce = signedNonce(ssecurity, nonce);
  const raw: Record<string, string> = { data: JSON.stringify(params) };
  raw.rc4_hash__ = createHash("sha1").update(signatureMessage(method, path, raw, snonce), "utf8").digest("base64");
  const entries = Object.entries(raw).sort(([left], [right]) => left.localeCompare(right));
  const plaintext = Buffer.concat(entries.map(([, value]) => Buffer.from(value, "utf8")));
  const encrypted = rc4Drop(Buffer.from(snonce, "base64"), plaintext);
  const output: Record<string, string> = {};
  let position = 0;
  for (const [key, value] of entries) {
    const length = Buffer.byteLength(value, "utf8");
    output[key] = encrypted.subarray(position, position + length).toString("base64");
    position += length;
  }
  output.signature = createHash("sha1")
    .update(signatureMessage(method, path, output, snonce), "utf8")
    .digest("base64");
  output._nonce = nonce;
  return output as SealedParams;
}

/** Decrypt a sealed `data` field. It is the first keystream slice because `data` sorts first. */
export function unsealData(ssecurity: string, nonce: string, dataField: string): unknown {
  const plain = rc4Drop(Buffer.from(signedNonce(ssecurity, nonce), "base64"), Buffer.from(dataField, "base64")).toString(
    "utf8",
  );
  return JSON.parse(plain) as unknown;
}

export function sealJson(ssecurity: string, nonce: string, value: unknown): string {
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  return rc4Drop(Buffer.from(signedNonce(ssecurity, nonce), "base64"), plain).toString("base64");
}

export function openJson(ssecurity: string, nonce: string, body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed) as unknown;
  const plain = rc4Drop(Buffer.from(signedNonce(ssecurity, nonce), "base64"), Buffer.from(trimmed, "base64")).toString(
    "utf8",
  );
  return JSON.parse(plain) as unknown;
}
