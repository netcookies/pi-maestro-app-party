import type { RecoveryUpdate } from "@maestro-mobile/mobile-sdk";
import { isSessionTargetIdentity, sessionTargetKey, type HostEvent, type SessionTargetIdentity } from "@maestro-mobile/mobile-sdk/protocol";
import type { AppAction } from "./app-state";
import { filterSessionsByVisibility } from "./host-session-pagination";

export interface RecoveryProjectionAdapter {
  dispatch(action: AppAction): void;
  flushPendingEvents(): void;
  clearPendingEvents(): void;
  dispatchBuffered(event: HostEvent): void;
  sessionTargets: Map<string, SessionTargetIdentity>;
}

export function projectRecoveryUpdate(update: RecoveryUpdate, adapter: RecoveryProjectionAdapter): void {
  if (update.type === "reset") {
    adapter.clearPendingEvents();
    adapter.dispatch({ type: "__connection_reset", connectionGeneration: update.generation });
  } else if (update.type === "event") {
    adapter.dispatchBuffered(update.event);
  } else if (update.type === "snapshot") {
    adapter.flushPendingEvents();
    adapter.dispatch({
      type: "__snapshot_transaction",
      snapshot: { type: "__snapshot_load", session: update.snapshot.session, items: update.snapshot.timeline, target: update.target },
      events: update.replayedEvents,
    });
  } else if (update.type === "bootstrap") {
    adapter.flushPendingEvents();
    if (update.query === "execution_projections") {
      adapter.dispatch({ type: "__execution_projections_load", projections: update.result.projections, revision: update.result.revision, connectionGeneration: update.generation });
    } else if (update.query === "maestro_state") {
      adapter.dispatch({ type: "__maestro_load", state: update.result });
    } else {
      for (const session of update.result.sessions) {
        if (!session.target || !isSessionTargetIdentity(session.target)
          || session.target.sessionId !== session.sessionId || session.target.endpointId !== session.endpointId
          || (session.targetKey !== undefined && session.targetKey !== sessionTargetKey(session.target))) continue;
        adapter.sessionTargets.set(sessionTargetKey(session.target), session.target);
      }
      adapter.dispatch({ type: "__host_session_list_load", list: { ...update.result, sessions: filterSessionsByVisibility(update.result.sessions, "session_list") }, connectionGeneration: update.generation });
    }
  } else {
    adapter.dispatch({ type: "__local_error", message: update.error.message });
  }
}
