import { assertEquals } from "jsr:@std/assert";
import { LRUCache } from "../cache.ts";

Deno.test("LRUCache: basic set/get", () => {
  const cache = new LRUCache<string, string>(3);
  cache.set("a", "1");
  cache.set("b", "2");
  assertEquals(cache.get("a"), "1");
  assertEquals(cache.get("b"), "2");
});

Deno.test("LRUCache: evicts oldest when full", () => {
  const cache = new LRUCache<string, string>(2);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3"); // 应该淘汰 "a"
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), "2");
  assertEquals(cache.get("c"), "3");
});

Deno.test("LRUCache: get refreshes LRU order", () => {
  const cache = new LRUCache<string, string>(2);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.get("a"); // "a" 变成最近使用
  cache.set("c", "3"); // 应该淘汰 "b"（最老的），而不是 "a"
  assertEquals(cache.get("a"), "1");
  assertEquals(cache.get("b"), undefined);
  assertEquals(cache.get("c"), "3");
});

Deno.test("LRUCache: clear empties cache", () => {
  const cache = new LRUCache<string, string>(3);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.clear();
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), undefined);
  assertEquals(cache.size, 0);
});

Deno.test("LRUCache: update existing key preserves size", () => {
  const cache = new LRUCache<string, string>(3);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("a", "updated");
  assertEquals(cache.size, 2);
  assertEquals(cache.get("a"), "updated");
});
