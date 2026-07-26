// 语言检测：用 Unicode range 判断文本是否主要是中文
// CJK 统一表意文字 + 扩展A + 兼容表意文字
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;

/**
 * 判断文本是否主要是中文。
 * 阈值 15%：允许夹杂英文术语、代码、命令，但只要中文字符占比超过 15% 就走翻译路径。
 */
export function isMostlyChinese(text: string): boolean {
  if (!text) return false;
  const matches = text.match(CJK_REGEX);
  const cjkCount = matches ? matches.length : 0;
  return cjkCount / text.length > 0.15;
}

/**
 * 判断文本是否主要是英文（非中文）。
 */
export function isMostlyEnglish(text: string): boolean {
  if (!text) return false;
  return !isMostlyChinese(text);
}
