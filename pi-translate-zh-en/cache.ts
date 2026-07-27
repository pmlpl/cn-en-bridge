// 简单的 LRU 缓存：避免重复翻译相同短句（"好的"、"继续"等高频短文本）
// 用 Map 的插入顺序模拟 LRU：get 时重新插入到末尾，set 时淘汰最老的。
export class LRUCache<K, V> {
  private map = new Map<K, V>();

  constructor(private readonly maxSize: number = 256) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // 重新插入到末尾，标记为最近使用
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // 删除最老的（第一个）
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
