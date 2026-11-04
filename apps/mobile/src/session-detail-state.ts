export function shouldFollowBottomAfterViewportResize(
  previousHeight: number,
  nextHeight: number,
  wasAtBottom: boolean,
): boolean {
  return wasAtBottom && previousHeight > 0 && nextHeight < previousHeight;
}

export interface SessionDetailHydrationInput {
  targetKey?: string;
  targetProjectionReady: boolean;
  hasTimelineSnapshot: boolean;
}

/**
 * A hydrated detail can keep rendering while connection/interaction state
 * briefly changes (for example while a composer overlay is dismissed).
 */
export function isSessionDetailHydrated({
  targetKey,
  targetProjectionReady,
  hasTimelineSnapshot,
}: SessionDetailHydrationInput): boolean {
  return Boolean(targetKey && targetProjectionReady && hasTimelineSnapshot);
}
