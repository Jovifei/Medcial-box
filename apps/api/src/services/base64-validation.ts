/** Canonical Base64 validator with constant stack and linear work. */
export function isCanonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const end = value.length - padding;
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
          (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
  }
  for (let index = end; index < value.length; index++) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  if (padding > 0) {
    const last = value.charCodeAt(end - 1);
    const n = last >= 65 && last <= 90 ? last - 65
      : last >= 97 && last <= 122 ? last - 97 + 26
      : last >= 48 && last <= 57 ? last - 48 + 52
      : last === 43 ? 62 : last === 47 ? 63 : -1;
    if (n < 0 || (padding === 2 && (n & 15) !== 0) || (padding === 1 && (n & 3) !== 0)) return false;
  }
  return true;
}
