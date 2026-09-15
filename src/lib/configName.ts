/**
 * Config naming (approved Phase 7 rules):
 *
 *  - validateConfigName: the customer's display name — strictly ENGLISH:
 *    6–64 total chars, Latin-letter words (1–20 chars each) separated by
 *    single plain spaces. NO word-count minimum ("Silver" is valid).
 *    The name is DISPLAY
 *    ONLY: it is never sent to PasarGuard — the panel username remains the
 *    deterministic prefix+order-id derivation from Phases 5/6. panelSafeName
 *    therefore stays a SEPARATE, documented shape, not a display gate.
 *  - panelSafeName: the conservative username shape the codebase has always
 *    exchanged with the panel (client.ts by-username guard `^[A-Za-z0-9]{3,32}$`
 *    plus real-world observations: 'test'/'test1' rejected, 'test13'
 *    accepted). Encoded as an OBSERVATION (>=6 chars, lowercase alnum,
 *    letters + trailing digits) — NOT a proven panel doctrine; do not treat
 *    its false as a panel rule.
 *  - randomConfigName: exactly 3 curated real English words (adjective +
 *    nature noun + tech noun), Title Cased for readability — like
 *    "Silver Falcon Network". CRYPTO selection; no numeric suffix (the
 *    ~40×40×40 space makes display collisions harmless and rare). Every
 *    generated name is re-validated through validateConfigName.
 */
import { sanitizeConfigName } from './validate.ts';

/** Conservative panel-username shape from repo evidence (see header note):
 *  lowercase alnum only, 6–30, containing letters. Trailing digits are NOT
 *  required — proven `pg<lower-ulid>` usernames end in arbitrary characters. */
export function panelSafeName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z0-9]{6,30}$/.test(value) &&
    /[a-z]/.test(value)
  );
}

/** English display-name rule: 6–64 chars, 1–20-letter Latin words, single
 *  spaces; returns the name trimmed, or null. */
export function validateConfigName(raw: unknown): string | null {
  const name = sanitizeConfigName(raw); // 1–64 visible, no control chars, no leading '/'
  if (name === null) return null;
  if (name.length < 6) return null; // "at least 6 characters"
  const words = name.split(' ');
  for (const word of words) {
    if (!/^[A-Za-z]{1,20}$/.test(word)) return null; // letters only, natural length
  }
  return name;
}

const ADJECTIVES = [
  'silver', 'golden', 'crimson', 'azure', 'silent', 'midnight', 'royal',
  'amber', 'vivid', 'polar', 'solar', 'lunar', 'noble', 'rapid', 'brisk',
  'gentle', 'mystic', 'frozen', 'hidden', 'electric', 'northern', 'velvet',
  'cobalt', 'ivory', 'coral', 'autumn', 'winter', 'autumnal', 'musical',
  'primal', 'quiet', 'nimble', 'sturdy', 'luminous', 'radiant', 'breezy',
  'misty', 'starry', 'remote', 'unique',
] as const;

const NATURE_NOUNS = [
  'falcon', 'horizon', 'shadow', 'mountain', 'ocean', 'valley', 'canyon',
  'glacier', 'meadow', 'prairie', 'desert', 'harbor', 'forest', 'willow',
  'maple', 'cedar', 'juniper', 'laurel', 'orchid', 'clover', 'thunder',
  'river', 'creek', 'storm', 'sunrise', 'sunset', 'lagoon', 'summit',
  'otter', 'raven', 'sparrow', 'panther', 'leopard', 'buffalo', 'eagle',
  'tiger', 'wolf', 'cricket', 'breeze', 'comet',
] as const;

const TECH_NOUNS = [
  'network', 'server', 'cloud', 'system', 'signal', 'beacon', 'relay',
  'node', 'pixel', 'cipher', 'quantum', 'circuit', 'console', 'terminal',
  'satellite', 'rocket', 'engine', 'sensor', 'radar', 'laser', 'prism',
  'orbit', 'cosmos', 'nebula', 'aurora', 'galaxy', 'portal', 'forge',
  'depot', 'tower', 'bridge', 'anchor', 'compass', 'lantern', 'beacon',
  'matrix', 'vector', 'modem', 'router', 'socket',
] as const;

/** Reject-list applied as a belt-and-braces filter over the curated words. */
const BANNED_SUBSTRINGS = [
  'sex', 'ass', 'damn', 'hell', 'fuck', 'shit', 'piss', 'crap', 'dick',
  'tit', 'anus', 'boobs', 'penis', 'vulva', 'rape', 'nazi', 'drug',
  'kill', 'dead', 'corpse', 'weapon', 'bomb', 'terror', 'violence',
  'porn', 'nude', 'naked', 'wank', 'arse', 'bollocks', 'paki', 'crack',
  'demon', 'devil', 'satan', 'curse', 'suicide', 'blood', 'gore',
] as const;

function isClean(word: string): boolean {
  const lower = word.toLowerCase();
  return !BANNED_SUBSTRINGS.some((banned) => lower.includes(banned));
}

// Filtered at module load so any curation slip can never reach the picker.
const CLEAN_ADJECTIVES = ADJECTIVES.filter(isClean);
const CLEAN_NATURE = NATURE_NOUNS.filter(isClean);
const CLEAN_TECH = TECH_NOUNS.filter(isClean);

/** Uniform crypto-random integer in [0, max). */
function cryptoRandomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  for (let guard = 0; guard < 64; guard++) {
    crypto.getRandomValues(buffer);
    const roll = buffer[0] ?? 0;
    if (roll < limit) return roll % max;
  }
  return 0; // unreachable in practice; keeps the function total
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function pick<T>(list: readonly T[]): T {
  const value = list[cryptoRandomInt(list.length)];
  if (value === undefined) throw new Error('configName: empty word list');
  return value;
}

/** Exactly 3 real English words, e.g. "Silver Falcon Network". */
export function randomConfigName(): string {
  let candidate = '';
  for (let tries = 0; tries < 12; tries++) {
    candidate = [
      capitalize(pick(CLEAN_ADJECTIVES)),
      capitalize(pick(CLEAN_NATURE)),
      capitalize(pick(CLEAN_TECH)),
    ].join(' ');
    if (validateConfigName(candidate) !== null) return candidate;
  }
  return candidate; // lists make this unreachable; never return empty
}
