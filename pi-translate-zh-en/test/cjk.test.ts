import { assertEquals } from "jsr:@std/assert";
import { containsCJK } from "../cjk.ts";

const testCases: [string, boolean][] = [
  // 中文
  ["你好世界", true],
  ["帮我写一个排序算法", true],
  ["什么是递归？", true],
  // 日文
  ["こんにちは", true],
  ["さようなら", true],
  // 韩文
  ["안녕하세요", true],
  ["감사합니다", true],
  // 纯英文
  ["Hello, world!", false],
  ["Write a sorting algorithm", false],
  // 代码
  ["function hello() { return 1; }", false],
  ["const x = 42;", false],
  // 混合
  ["Hello 你好", true],
  ["递归 recursion 算法 algorithm", true],
  // 边界：空字符串
  ["", false],
  // 边界：数字和符号
  ["12345", false],
  ["!@#$%^", false],
  // CJK 扩展 A 区首字符
  ["\u{3400}", true],
  // 全角标点：属于 CJK Symbols 区（0x3000-0x303F）和 Halfwidth/Fullwidth Forms（0xFF00-0xFFEF），
  // 都不在 containsCJK 的检测范围内，所以不算 CJK 字符。
  ["。，、？！", false],
];

Deno.test("containsCJK: all cases", () => {
  for (const [input, expected] of testCases) {
    assertEquals(containsCJK(input), expected, `Failed for input: "${input}"`);
  }
});
