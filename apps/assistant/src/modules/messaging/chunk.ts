/**
 * Provider-safe outbound text limits, in ONE place (audit F17). Telegram rejects messages over 4096 characters; we split well below
 * that so a "(i/N)" header always fits. Splitting prefers line boundaries (numbered list items stay whole and in order), then spaces,
 * and only as a last resort cuts an unbroken run, always by code point so a surrogate pair is never torn.
 */
export const TELEGRAM_TEXT_LIMIT = 4096;
export const SAFE_CHUNK = 3900;

export function chunkText(text: string, max = SAFE_CHUNK): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  const pushPiece = (piece: string) => {
    // `cur` holds whole lines joined by '\n'; add the next line if it fits.
    const joined = cur ? `${cur}\n${piece}` : piece;
    if (joined.length <= max) cur = joined;
    else {
      flush();
      cur = piece;
    }
  };
  for (const line of text.split('\n')) {
    if (line.length <= max) {
      pushPiece(line);
      continue;
    }
    flush();
    // One line longer than a message: break at spaces, then by code point.
    let rest = line;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max);
      if (cut <= 0) {
        const cps = Array.from(rest);
        let n = 0;
        let len = 0;
        while (n < cps.length && len + cps[n]!.length <= max) len += cps[n++]!.length;
        cut = len;
      }
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ /, '');
    }
    cur = rest;
  }
  flush();
  return out;
}
