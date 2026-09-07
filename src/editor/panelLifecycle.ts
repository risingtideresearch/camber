// How detached panels die, and how their layout comes back.
//
// Closing a document is nothing but a navigation: the editor returns to library.html and the session it was
// on stays hosted in the worker. Left alone, a detached panel outlives the close and keeps showing — and, for
// Weights, keeps EDITING — a document the user believes is gone, with no window left that could save it. So
// the editor's Close orders the session's panels shut, and remembers what was open so the next document can
// offer the same layout back with one click.
//
// The editor cannot do the closing itself: openPanelWindow keeps no handles (a WindowProxy would not survive
// a reload of the editor anyway), and the editor's own page is about to be torn down by the navigation. So
// the panels close THEMSELVES, on a signal, and announce themselves so the signal's sender knows what was
// open. Three pieces of shared browser state, each keyed by session so two documents open at once never touch
// each other's panels:
//
//  - A presence registry in localStorage: each panel window sets a key for its (session, kind) on load and
//    clears it on pagehide. One key per kind, not one list per session, so two panels booting at once never
//    lose each other's write.
//  - A BroadcastChannel on which a closing editor names the session being closed. Each panel of that session
//    closes itself — allowed without a handle, because every panel window was script-opened. Delivery is
//    queued in the receivers, so the sender navigating away immediately after does not revoke it.
//  - A reopen note in localStorage: the kinds open at the moment of the LAST close, written by the closing
//    editor and consumed by the next editor page load (see ReopenPanelsButton).
//
// Known limit: with two editor windows on the SAME session, Close in either one closes the panels for both —
// a panel cannot tell "the last editor left" from "an editor left". And an editor tab that is closed outright
// rather than through Close orders nothing shut: pagehide cannot tell leaving from reloading, and killing the
// panels on every F5 of the editor would be worse than the orphans.

import { PANEL_KINDS, type PanelKind } from "./externalPanels";

const openKey = (sessionId: string, kind: PanelKind) =>
  `camber-panel-open:${sessionId}:${kind}`;

const REOPEN_KEY = "camber-panels-to-reopen";

const CHANNEL_NAME = "camber-panel-lifecycle";

interface SessionClosed {
  readonly type: "session-closed";
  readonly sessionId: string;
}

/**
 * Called once, at page load, by a panel window: announce this panel while it lives, and close it when its
 * session's document is closed.
 */
export function attachPanelLifecycle(sessionId: string, kind: PanelKind): void {
  localStorage.setItem(openKey(sessionId, kind), "1");
  window.addEventListener("pagehide", () =>
    localStorage.removeItem(openKey(sessionId, kind)),
  );
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (e: MessageEvent<SessionClosed>) => {
    if (e.data.type === "session-closed" && e.data.sessionId === sessionId)
      window.close();
  };
}

/**
 * Called by the editor's Close, after the discard confirm and before the navigation: record which panels the
 * session has open as the layout to offer the next document, then order them all shut.
 *
 * The registry keys are removed here rather than left to the panels' pagehide, so a panel that crashed
 * without firing it cannot haunt the registry — at worst it is offered for reopening once.
 */
export function closeSessionPanels(sessionId: string): void {
  const open = PANEL_KINDS.filter(
    (kind) => localStorage.getItem(openKey(sessionId, kind)) !== null,
  );
  for (const kind of open) localStorage.removeItem(openKey(sessionId, kind));
  // A close with nothing open clears the note: the offer always reflects the latest close, never an older
  // one that happened to have panels.
  if (open.length > 0) localStorage.setItem(REOPEN_KEY, JSON.stringify(open));
  else localStorage.removeItem(REOPEN_KEY);
  const message: SessionClosed = { type: "session-closed", sessionId };
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage(message);
  channel.close();
}

/**
 * The layout recorded by the last Close, consumed: reading it clears it, so the offer is made by exactly one
 * editor page load and an ignored one dies with the page instead of lingering for weeks.
 */
export function takePanelsToReopen(): PanelKind[] {
  const raw = localStorage.getItem(REOPEN_KEY);
  if (raw === null) return [];
  localStorage.removeItem(REOPEN_KEY);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filtering PANEL_KINDS against the note (rather than the note against PANEL_KINDS) validates, dedupes,
    // and puts the reopened windows in the declaration order in one move.
    return PANEL_KINDS.filter((kind) => parsed.includes(kind));
  } catch {
    return [];
  }
}
