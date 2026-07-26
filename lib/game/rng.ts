export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  pick<T>(values: readonly T[]): T | undefined {
    if (!values.length) return undefined;
    return values[Math.floor(this.next() * values.length)];
  }

  angle(): number {
    return this.next() * Math.PI * 2;
  }
}
