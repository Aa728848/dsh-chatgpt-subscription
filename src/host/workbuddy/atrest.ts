/**
 * `$wbEncrypted` at-rest credential envelope.
 *
 * The CodeBuddy/WorkBuddy desktop client stopped writing plaintext tokens on
 * 2026-09-24: `auth.accessToken` / `auth.refreshToken` became
 * `{"$wbEncrypted": 1, "envelope": base64}` (the domestic build also seals
 * `nickname` / `phoneNumber`). Reading such a file the way this plugin used to
 * yields the envelope TEXT as the bearer token, so every request answers 401 —
 * the adoption path has to decrypt before it can use the credential.
 *
 * The scheme below is transcribed from the client's `packages/at-rest-crypto`
 * as reimplemented by workbuddy2api-hub (`wb_atrest.py`, MIT); the framing
 * constants are the part that must match byte for byte:
 *
 *     key      = sha256(atRestSecretKey as an ASCII string)   # the protector key
 *     keyId    = sha256(key).hex[0..16]                       # `protectorKeyId`
 *     AAD      = "WB-AAD\0" | 0x01 | LP(fileMagic) | LP("sym-v1")
 *                | u32(suite) | LP(keyId) | framingCode | 0x00 | 0x00
 *     envelope = base64(JSON{suite, keyId, nonce, authTag, ciphertext})  # AES-256-GCM
 *     framing  : the keyblob's wrapped master key is `WBEF1`/1, a sealed `.info`
 *                field is `WBEV1`/2 — the SAME protector key opens both.
 *
 * Key material never leaves the process and is never logged: the user pastes it
 * once, it is stored through the platform credential store (DPAPI / Keychain /
 * Secret Service), and every read re-validates it against the client's own
 * keyblob when that file exists.
 */

import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Field name the client uses to mark a sealed value. */
export const ENVELOPE_KEY = '$wbEncrypted';

/** Framing kinds and the code each carries in the AAD. */
const FRAMING = {
  file: { magic: 'WBEF1', code: 1 },
  field: { magic: 'WBEV1', code: 2 },
} as const;

type Framing = keyof typeof FRAMING;

/** Suite number this build speaks; the envelope may override it. */
const DEFAULT_SUITE = 1;

/** Hash scheme marker inside the AAD. */
const SCHEME = 'sym-v1';

/** Every failure the at-rest path can report to a user. */
export class AtRestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AtRestError';
  }
}

function lengthPrefixed(text: string): Buffer {
  const raw = Buffer.from(text, 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(raw.length, 0);
  return Buffer.concat([prefix, raw]);
}

function uint32(value: number): Buffer {
  const raw = Buffer.alloc(4);
  raw.writeUInt32BE(value, 0);
  return raw;
}

/** The GCM associated data, byte-identical to the client's. */
export function associatedData(keyId: string, suite: number, framing: Framing): Buffer {
  const spec = FRAMING[framing];
  return Buffer.concat([
    Buffer.from('WB-AAD\u0000', 'utf8'),
    Buffer.from([0x01]),
    lengthPrefixed(spec.magic),
    lengthPrefixed(SCHEME),
    uint32(suite),
    lengthPrefixed(keyId),
    Buffer.from([spec.code, 0x00, 0x00]),
  ]);
}

/** `protectorKeyId` / `envelope.keyId`: the first 16 hex characters of sha256(key). */
export function deriveKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Whether a value is a sealed envelope rather than plaintext.
 *
 * Older clients sometimes stored the whole envelope as a JSON STRING in the
 * field, so that shape is recognised too.
 */
export function isSealedValue(value: unknown): boolean {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return typeof record.envelope === 'string' && ENVELOPE_KEY in record;
  }
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    return trimmed.startsWith('{') && trimmed.slice(0, 64).includes(ENVELOPE_KEY);
  }
  return false;
}

interface SealedEnvelope {
  suite: number;
  keyId: string;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

function base64(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || value === '') throw new AtRestError(`sealed envelope is missing ${label}`);
  return Buffer.from(value, 'base64');
}

/** Split one envelope into its GCM parts. */
export function parseEnvelope(value: unknown): SealedEnvelope {
  const encoded = typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>).envelope
    : value;
  if (typeof encoded !== 'string') throw new AtRestError('sealed envelope is not a string');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    throw new AtRestError(`sealed envelope is not base64 JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new AtRestError('sealed envelope is not an object');
  const record = parsed as Record<string, unknown>;
  const suite = typeof record.suite === 'number' && Number.isFinite(record.suite) ? record.suite : DEFAULT_SUITE;
  const keyId = typeof record.keyId === 'string' ? record.keyId : '';
  return {
    suite,
    keyId,
    nonce: base64(record.nonce, 'nonce'),
    authTag: base64(record.authTag, 'authTag'),
    ciphertext: base64(record.ciphertext, 'ciphertext'),
  };
}

/** Open one envelope with the protector key, returning the plaintext bytes. */
export function openEnvelope(key: Buffer, value: unknown, framing: Framing): Buffer {
  const envelope = parseEnvelope(value);
  const expected = deriveKeyId(key);
  if (envelope.keyId !== '' && envelope.keyId !== expected) {
    throw new AtRestError(
      `sealed value was written by a different key (envelope ${envelope.keyId}, this key ${expected})`,
    );
  }
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce);
  decipher.setAAD(associatedData(envelope.keyId || expected, envelope.suite, framing));
  decipher.setAuthTag(envelope.authTag);
  try {
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
  } catch {
    // A GCM authentication failure is the same user-visible event as a wrong
    // key: the pasted secret does not open this file.
    throw new AtRestError('sealed value could not be authenticated — the pasted key does not match this file');
  }
}

/** Decrypt a field that may be sealed, leaving plaintext values untouched. */
export function openSealedField(key: Buffer, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && !isSealedValue(value)) return value;
  if (typeof value !== 'string' && !isSealedValue(value)) return '';
  return openEnvelope(key, value, 'field').toString('utf8');
}

const HEX_KEY = /^[0-9a-f]{64}$/i;
const BASE64_SECRET = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Normalise a pasted secret into the 32-byte protector key.
 *
 * Two spellings are accepted, neither requiring the user to compute anything:
 * a 64-character hex protector key (used as-is), or the 44-character base64
 * `atRestSecretKey` the client carries in its payload — that one is hashed as
 * the STRING, which is what produces the protector key.
 */
export function parseKeyText(text: string): Buffer {
  let raw = text.trim();
  if (raw.slice(0, 2).toLowerCase() === '0x') raw = raw.slice(2).trim();
  if (HEX_KEY.test(raw)) return Buffer.from(raw, 'hex');
  if (BASE64_SECRET.test(raw)) return createHash('sha256').update(raw, 'ascii').digest();
  throw new AtRestError(
    'unrecognised key format: paste the 64-character hex protector key or the 44-character base64 atRestSecretKey',
  );
}

/** Directories the desktop client may keep its `keyblob` in. */
function configDirCandidates(): string[] {
  const override = process.env['WORKBUDDY_CONFIG_DIR'] ?? process.env['CODEBUDDY_CONFIG_DIR'];
  if (override !== undefined && override.trim() !== '') return [path.resolve(override.trim())];
  const home = os.homedir();
  return ['CodeBuddy', 'WorkBuddy', '.workbuddy-ai', '.codebuddy'].map((name) => path.join(home, name));
}

/** Path of the client's keyblob, or null when the client is not installed here. */
export function keyBlobPath(): string | null {
  for (const dir of configDirCandidates()) {
    const candidate = path.join(dir, 'keyblob');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface KeyBlobSlot {
  type?: unknown;
  protectorKeyId?: unknown;
  wrapped?: unknown;
}

interface KeyBlob {
  keyId?: unknown;
  slots?: unknown;
}

async function loadKeyBlob(): Promise<KeyBlob | null> {
  const file = keyBlobPath();
  if (file === null) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as KeyBlob : null;
  } catch {
    return null;
  }
}

/**
 * Validate a protector key against the client's own keyblob.
 *
 * This is the check that turns a typo into an error instead of a mystery: the
 * key must match the `static-v1` slot's `protectorKeyId` and must unwrap a
 * 32-byte master whose derived id matches the blob's own `keyId`. Returns
 * `false` when there is no keyblob to check against (the desktop client is not
 * installed on this machine) — absence of evidence, not evidence of a bad key.
 */
export async function verifyKeyAgainstKeyBlob(key: Buffer): Promise<boolean> {
  const blob = await loadKeyBlob();
  if (blob === null) return false;
  const slots = Array.isArray(blob.slots) ? blob.slots as KeyBlobSlot[] : [];
  const expected = deriveKeyId(key);
  for (const slot of slots) {
    if (slot.type !== 'static-v1' || slot.wrapped === undefined) continue;
    const declared = typeof slot.protectorKeyId === 'string' ? slot.protectorKeyId.toLowerCase() : '';
    if (declared !== expected) {
      throw new AtRestError('this key does not match the desktop client keyblob (protectorKeyId differs)');
    }
    const master = openEnvelope(key, slot.wrapped, 'file');
    if (master.length !== 32 || deriveKeyId(master) !== String(blob.keyId ?? '')) {
      throw new AtRestError('the keyblob did not unwrap to a valid master key');
    }
    return true;
  }
  throw new AtRestError('the desktop client keyblob has no usable static-v1 slot');
}

let activeKey: Buffer | null = null;

/** Install the protector key for this process (already persisted by the caller). */
export function setActiveAtRestKey(key: Buffer | null): void {
  activeKey = key;
}

/** The protector key this process holds, if any. */
export function activeAtRestKey(): Buffer | null {
  return activeKey;
}

/** Whether sealed credentials can be opened right now. */
export function hasAtRestKey(): boolean {
  return activeKey !== null;
}
