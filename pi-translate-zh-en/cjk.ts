// CJK Unicode 范围检测：判断文本是否包含中文/日文/韩文字符。
// 如果用户输入纯英文（或代码），就不需要翻译，直接放行。
//
// 提取到独立模块方便单测和复用（index.ts 和 test/cjk.test.ts 都用）。

export const CJK_RANGES = [
  { start: 0x4e00, end: 0x9fff, name: "CJK Unified Ideographs" },
  { start: 0x3400, end: 0x4dbf, name: "CJK Extension A" },
  { start: 0xf900, end: 0xfaff, name: "CJK Compatibility Ideographs" },
  { start: 0x3040, end: 0x30ff, name: "Hiragana / Katakana" },
  { start: 0xac00, end: 0xd7af, name: "Hangul Syllables" },
] as const;

/** 文本中是否包含中文/日文/韩文字符。 */
export function containsCJK(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (!code) continue;
    for (const range of CJK_RANGES) {
      if (code >= range.start && code <= range.end) return true;
    }
  }
  return false;
}
