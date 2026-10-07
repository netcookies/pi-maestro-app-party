import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const DRAFT_PREFIX = "maestro-mobile.draft.v1";

export interface SessionDraftScope {
  hostUrl: string;
  sessionId: string;
  /** Exact target identity supplied by the host/session owner. */
  targetKey: string;
}

export interface DraftSubmission {
  text: string;
  revision: number;
}

export type DraftErrorHandler = (error: unknown) => void;

/**
 * Creates an opaque scope key. JSON keeps the three identity components
 * unambiguous even when a URL, session id, or target contains punctuation.
 */
export function draftScopeKey(hostUrl: string, sessionId: string, targetKey: string): string {
  return JSON.stringify([hostUrl, sessionId, targetKey]);
}

export function draftScope(scope: SessionDraftScope): string {
  return draftScopeKey(scope.hostUrl, scope.sessionId, scope.targetKey);
}

export function draftKey(scopeKey: string): string {
  return `${DRAFT_PREFIX}:${encodeURIComponent(scopeKey)}`;
}

interface PendingWrite {
  text: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface WriteQueue {
  pending: PendingWrite[];
  running: boolean;
  waiters: { resolve: () => void; reject: (error: unknown) => void }[];
}

const writeQueues = new Map<string, WriteQueue>();

async function writeDraft(scopeKey: string, text: string): Promise<void> {
  const key = draftKey(scopeKey);
  if (text.length === 0) await AsyncStorage.removeItem(key);
  else await AsyncStorage.setItem(key, text);
}

function drainQueue(scopeKey: string, queue: WriteQueue): void {
  if (queue.running) return;
  queue.running = true;
  void (async () => {
    try {
      while (queue.pending.length > 0) {
        // Coalesce all writes currently waiting behind the same in-flight write.
        const batch = queue.pending.splice(0);
        const latest = batch[batch.length - 1];
        try {
          await writeDraft(scopeKey, latest.text);
          for (const item of batch) item.resolve();
        } catch (error) {
          for (const item of batch) item.reject(error);
          for (const waiter of queue.waiters.splice(0)) waiter.reject(error);
          // Writes added while the failed operation was in flight are retained
          // and attempted once, preserving the latest in-memory value.
        }
      }
    } finally {
      queue.running = false;
      if (queue.pending.length === 0) {
        writeQueues.delete(scopeKey);
        for (const waiter of queue.waiters.splice(0)) waiter.resolve();
      } else drainQueue(scopeKey, queue);
    }
  })();
}

/** Persist the latest value in order, coalescing queued writes per scope. */
export function saveDraft(scopeKey: string, text: string): Promise<void> {
  let queue = writeQueues.get(scopeKey);
  if (!queue) {
    queue = { pending: [], running: false, waiters: [] };
    writeQueues.set(scopeKey, queue);
  }
  const result = new Promise<void>((resolve, reject) => {
    queue!.pending.push({ text, resolve, reject });
  });
  drainQueue(scopeKey, queue);
  return result;
}

export async function loadDraft(scopeKey: string): Promise<string> {
  return (await AsyncStorage.getItem(draftKey(scopeKey))) ?? "";
}

export function clearDraft(scopeKey: string): Promise<void> {
  return saveDraft(scopeKey, "");
}

/** Wait until all writes already queued for a scope have reached storage. */
export function flushDraft(scopeKey: string): Promise<void> {
  const queue = writeQueues.get(scopeKey);
  if (!queue || (!queue.running && queue.pending.length === 0)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => queue.waiters.push({ resolve, reject }));
}

export interface SessionDraftController {
  text: string;
  setText(text: string): void;
  ready: boolean;
  revision: number;
  captureSubmission(): DraftSubmission;
  completeSubmission(submission: DraftSubmission | number): boolean;
  flush(): Promise<void>;
}

/**
 * Owns one exact session draft scope. The caller should keep scopeKey stable
 * while reconnecting; if a target is temporarily unresolved, retain the last
 * resolved target key instead of switching scopes.
 */
export function useSessionDraft(scopeKey: string, onError?: DraftErrorHandler): SessionDraftController {
  const [text, setTextState] = useState("");
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const textRef = useRef("");
  const revisionRef = useRef(0);
  const typedRef = useRef(false);
  const scopeRef = useRef(scopeKey);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const reportError = useCallback((error: unknown) => {
    onErrorRef.current?.(error);
  }, []);

  const persist = useCallback((scope: string, value: string) => {
    void saveDraft(scope, value).catch(reportError);
  }, [reportError]);

  useEffect(() => {
    scopeRef.current = scopeKey;
    typedRef.current = false;
    textRef.current = "";
    revisionRef.current = 0;
    setTextState("");
    setRevision(0);
    setReady(false);
    let active = true;

    void loadDraft(scopeKey).then((saved) => {
      if (!active) return;
      // A keystroke wins over a slower restore read.
      if (!typedRef.current) {
        textRef.current = saved;
        setTextState(saved);
      }
      setReady(true);
    }).catch((error) => {
      if (!active) return;
      setReady(true);
      reportError(error);
    });

    return () => {
      active = false;
      // The latest value was queued by setText; this barrier ensures unmount
      // does not leave an in-flight write behind.
      void flushDraft(scopeKey).catch(reportError);
    };
  }, [scopeKey, reportError]);

  const setText = useCallback((next: string) => {
    typedRef.current = true;
    textRef.current = next;
    revisionRef.current += 1;
    setTextState(next);
    setRevision(revisionRef.current);
    persist(scopeRef.current, next);
  }, [persist]);

  const captureSubmission = useCallback((): DraftSubmission => ({
    text: textRef.current,
    revision: revisionRef.current,
  }), []);

  const completeSubmission = useCallback((submission: DraftSubmission | number): boolean => {
    const sentRevision = typeof submission === "number" ? submission : submission.revision;
    if (revisionRef.current !== sentRevision) return false;
    setTextState("");
    textRef.current = "";
    revisionRef.current += 1;
    setRevision(revisionRef.current);
    persist(scopeRef.current, "");
    return true;
  }, [persist]);

  const flush = useCallback(async () => {
    await flushDraft(scopeRef.current);
  }, []);

  return { text, setText, ready, revision, captureSubmission, completeSubmission, flush };
}
