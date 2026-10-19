/** Parses a whole number in [min, max]; null for anything else, so a half-typed value is never written. */
export const parseInteger = (min: number, max: number) => (text: string): number | null => {
  if (!/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
};
