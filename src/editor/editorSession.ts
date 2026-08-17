// Translate browser navigation state into the application-level session descriptor consumed by the provider.
// A generated session ID keeps scratch windows isolated; an explicit ID lets another window join a live session.

import type { SessionSource } from "../document-store/api";

export interface SessionDescriptor {
  readonly sessionId: string;
  readonly source: SessionSource;
}

export function sessionDescriptorFromUrl(): SessionDescriptor {
  // `id` describes durable initialization. `session` describes the live shared editing identity; after the
  // first connection the host ignores later initialization sources for that already-running session.
  const url = new URL(window.location.href);
  const designId = url.searchParams.get("id");
  const explicit = url.searchParams.get("session");
  const sessionId =
    explicit ??
    (designId ? `design:${designId}` : `scratch:${crypto.randomUUID()}`);
  if (!explicit) {
    url.searchParams.set("session", sessionId);
    history.replaceState(null, "", url);
  }
  return {
    sessionId,
    source: designId ? { type: "design", designId } : { type: "new" },
  };
}

// The session a DETACHED PANEL window joins. A panel never starts a session of its own: it is opened from an
// editor window with that window's live session in its URL, and the host ignores a joining window's source
// anyway. So a missing `session` is something to report, not a scratch session to invent — inventing one
// would silently give the panel an empty hull of its own and look like the sharing had failed.
export function joinedSessionFromUrl(): SessionDescriptor | null {
  const url = new URL(window.location.href);
  const sessionId = url.searchParams.get("session");
  if (!sessionId) return null;
  const designId = url.searchParams.get("id");
  return {
    sessionId,
    source: designId ? { type: "design", designId } : { type: "new" },
  };
}
