export const JSON_RESOURCE_LIMITS = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
  stringBytes: 8 * 1024 * 1024,
  depth: 128,
  nodes: 100_000,
  canonicalNumberBytes: 16 * 1024 * 1024,
});

export class JsonEncodingBudget {
  private consumedBytes = 0;
  private readonly strings = new Map<string, number>();

  get bytes(): number {
    return this.consumedBytes;
  }

  reserve(bytes: number): void {
    this.consumedBytes += bytes;
    if (this.consumedBytes > JSON_RESOURCE_LIMITS.inputBytes) this.fail();
  }

  reserveString(value: string): void {
    const cached = this.strings.get(value);
    if (cached !== undefined) return this.reserve(cached);
    let bytes = 2;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
        || code === 0x0a || code === 0x0c || code === 0x0d) {
        bytes += 2;
      } else if (code < 0x20) {
        bytes += 6;
      } else if (code < 0x80) {
        bytes++;
      } else if (code < 0x800) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index++;
        } else {
          bytes += 6;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        bytes += 6;
      } else {
        bytes += 3;
      }
      if (this.consumedBytes + bytes > JSON_RESOURCE_LIMITS.inputBytes) this.fail();
    }
    this.strings.set(value, bytes);
    this.reserve(bytes);
  }

  private fail(): never {
    throw new Error(
      `sqlx-js: Extended JSON document exceeds ${JSON_RESOURCE_LIMITS.inputBytes} UTF-8 bytes`,
    );
  }
}
