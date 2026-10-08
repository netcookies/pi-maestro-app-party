import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";

export const MAX_ENTRIES = 100;
export const MAX_MESSAGE_LENGTH = 512;
export const MAX_SOURCE_LENGTH = 64;
export const DIAGNOSTICS_STORAGE_KEY = "maestro-mobile.diagnostics";

export type DiagnosticKind = "connection_error" | "notification" | "ask" | "plan" | "local";

export interface DiagnosticEntry {
  id: string;
  timestamp: string;
  kind: DiagnosticKind;
  source: string;
  message: string;
}

export type DiagnosticInput = {
  kind: DiagnosticKind;
  source: string;
  message: string;
};

function boundedText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maxLength);
}

/** Small newest-first ring buffer. It never retains more than maxEntries values. */
export class DiagnosticRingBuffer {
  private entries: DiagnosticEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = MAX_ENTRIES) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  add(entry: DiagnosticEntry): void {
    const normalized: DiagnosticEntry = {
      id: boundedText(entry.id, 128),
      timestamp: boundedText(entry.timestamp, 64),
      kind: entry.kind,
      source: boundedText(entry.source, MAX_SOURCE_LENGTH),
      message: boundedText(entry.message, MAX_MESSAGE_LENGTH),
    };
    this.entries = [normalized, ...this.entries.filter((item) => item.id !== normalized.id)].slice(0, this.maxEntries);
  }

  replace(entries: DiagnosticEntry[]): void {
    this.entries = [];
    for (const entry of [...entries].reverse()) this.add(entry);
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }

  snapshot(): DiagnosticEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

const buffer = new DiagnosticRingBuffer();
let snapshot = buffer.snapshot();
const listeners = new Set<() => void>();
let hydrationPromise: Promise<void> | null = null;
let hydrationGeneration = 0;
let pendingPersist = false;
let persistPromise: Promise<void> | null = null;
let sequence = 0;

function publish(): void {
  snapshot = buffer.snapshot();
  for (const listener of listeners) {
    try { listener(); } catch { /* an observer must not break diagnostics */ }
  }
}

function persistSoon(): void {
  pendingPersist = true;
  if (persistPromise) return;
  persistPromise = Promise.resolve().then(async () => {
    while (pendingPersist) {
      pendingPersist = false;
      await AsyncStorage.setItem(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(buffer.snapshot())).catch(() => {});
    }
  }).finally(() => {
    persistPromise = null;
  });
}

export function recordDiagnostic(input: DiagnosticInput): DiagnosticEntry {
  const entry: DiagnosticEntry = {
    id: `${Date.now()}-${sequence++}`,
    timestamp: new Date().toISOString(),
    kind: input.kind,
    source: input.source,
    message: input.message,
  };
  buffer.add(entry);
  publish();
  persistSoon();
  return entry;
}

export function getDiagnostics(): DiagnosticEntry[] {
  return snapshot;
}

export function clearDiagnostics(): void {
  hydrationGeneration += 1;
  buffer.clear();
  publish();
  persistSoon();
}

export function subscribeDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDiagnostics(): DiagnosticEntry[] {
  return useSyncExternalStore(subscribeDiagnostics, getDiagnostics, getDiagnostics);
}

export async function loadDiagnostics(): Promise<void> {
  if (!hydrationPromise) {
    const generationAtStart = hydrationGeneration;
    hydrationPromise = AsyncStorage.getItem(DIAGNOSTICS_STORAGE_KEY).then((raw) => {
      if (!raw) {
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          return;
        }
        const persisted = parsed.filter((item): item is DiagnosticEntry => {
          if (!item || typeof item !== "object") return false;
          const value = item as Partial<DiagnosticEntry>;
          return typeof value.id === "string" && typeof value.timestamp === "string"
            && (value.kind === "connection_error" || value.kind === "notification" || value.kind === "ask" || value.kind === "plan" || value.kind === "local")
            && typeof value.source === "string" && typeof value.message === "string";
        });
        if (generationAtStart === hydrationGeneration) {
          const merged = [...buffer.snapshot(), ...persisted]
            .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
          buffer.replace(merged);
          publish();
          persistSoon();
        }
      } catch {
        /* malformed persisted diagnostics are discarded */
      }
    }).catch(() => {
    }).then(() => undefined);
  }
  await hydrationPromise;
}

// Hydration is intentionally best-effort; records can be made before it completes.
void loadDiagnostics();
