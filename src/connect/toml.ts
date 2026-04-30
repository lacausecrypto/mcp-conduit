export function toTomlString(value: string): string {
  return JSON.stringify(value);
}

export function toTomlArray(values: string[]): string {
  return `[${values.map((value) => toTomlString(value)).join(', ')}]`;
}

export function toTomlInlineStringTable(values: Record<string, string>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return '{}';
  }

  return `{ ${entries.map(([key, value]) => `${toTomlKey(key)} = ${toTomlString(value)}`).join(', ')} }`;
}

export function toTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key)
    ? key
    : JSON.stringify(key);
}
