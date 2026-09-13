/**
 * Phase 8C: the ONE Telegram HTML helper set. Opt-in per message — every
 * other send in the bot stays plain text. A message that shows a copyable
 * value (card number, IBAN, subscription URL) is composed end-to-end with
 * parse_mode='HTML', which forces escaping of every dynamic string inside
 * THAT message: static Persian copy contains no HTML specials, but
 * settings-authored and panel-sourced values are treated as hostile.
 */

/** Escape the three characters Telegram HTML reserves. */
export function tgEscapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Inline-code segment: tap-to-copy in Telegram, monospace display. */
export function tgCode(value: string): string {
  return `<code>${tgEscapeHtml(value)}</code>`;
}
