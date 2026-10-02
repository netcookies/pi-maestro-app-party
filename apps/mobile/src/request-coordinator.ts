export function stableRequestKey(scope: string, value: unknown): string {
  return `${scope}:${stableSerialize(value)}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

export function singleFlight<T>(
  flights: Map<string, Promise<unknown>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const existing = flights.get(key);
  if (existing) return existing as Promise<T>;
  const promise = Promise.resolve().then(factory);
  flights.set(key, promise);
  const clear = () => {
    if (flights.get(key) === promise) flights.delete(key);
  };
  void promise.then(clear, clear);
  return promise;
}
