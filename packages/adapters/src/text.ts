/** C0 controls (CR, LF, NUL, …) and DEL: the characters that split or truncate headers and file names. */
export function hasControlChars(s: string, o: { allowTab?: boolean } = {}): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && !(o.allowTab && c === 0x09)) || c === 0x7f) return true;
  }
  return false;
}
