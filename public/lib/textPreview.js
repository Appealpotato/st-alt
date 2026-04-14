/**
 * stripFormatting — reduce message/markdown/HTML content to clean plain text
 * suitable for truncated previews (character rows, session previews, command
 * palette excerpts).
 *
 * Drops: <think> blocks, fenced/inline code (keeps content), markdown
 * emphasis/strike markers, HTML tags, HTML entities (decoded), collapses all
 * whitespace to single spaces.
 *
 * @param {string} text
 * @param {number} [maxLen=0] — truncate to this length with ellipsis; 0 = no truncation
 */
export function stripFormatting(text, maxLen = 0) {
  if (!text) return '';
  let s = String(text);

  // Drop <think>/<thinking> blocks entirely — they're internal reasoning, not
  // preview-worthy prose.
  s = s.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '');

  // Fenced code blocks: keep the code, drop the fence + lang marker.
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, '$1');

  // Inline code: keep the content, drop the backticks.
  s = s.replace(/`([^`\n]+)`/g, '$1');

  // Markdown emphasis / strike markers.
  s = s.replace(/\*\*\*(.+?)\*\*\*/gs, '$1');
  s = s.replace(/\*\*(.+?)\*\*/gs, '$1');
  s = s.replace(/\*(.+?)\*/gs, '$1');
  s = s.replace(/~~(.+?)~~/gs, '$1');

  // Strip HTML tags. Best-effort regex — good enough for previews. Anything
  // ambiguous (like "a<b") that isn't a real tag stays as-is.
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // Decode the handful of entities the renderer is likely to have emitted.
  s = s.replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'")
       .replace(/&nbsp;/g, ' ');

  // Collapse any whitespace run (including newlines) to a single space.
  s = s.replace(/\s+/g, ' ').trim();

  if (maxLen > 0 && s.length > maxLen) {
    s = s.slice(0, maxLen - 1).trimEnd() + '\u2026';
  }
  return s;
}
