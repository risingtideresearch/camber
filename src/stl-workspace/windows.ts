import type { ProjectSession } from "./session";
export type AnalysisView = "Weights" | "Stability" | "Hull";
// Same-origin secondary windows execute their own UI modules (and therefore use
// their own document for drag/keyboard events), but share this one command store
// and worker service. No asset copies, polling snapshots or competing histories.
declare global {
  interface Window {
    camberAnalysisSessions?: Map<string, ProjectSession>;
  }
}
export function openAnalysisWindow(
  session: ProjectSession,
  view: AnalysisView,
): Window | null {
  const existing = session.viewWindows.get(view);
  if (existing && !existing.closed) {
    existing.focus();
    return existing;
  }
  const registry = (window.camberAnalysisSessions ??= new Map());
  registry.set(session.id, session);
  const url = new URL("analysis.html", window.location.href);
  url.searchParams.set("session", session.id);
  url.searchParams.set("view", view);
  const target = window.open(
    url,
    `stl-${session.id}-${view}`,
    "popup=1,width=1200,height=850",
  );
  if (target) {
    for (const old of session.windows)
      if (old.closed) session.windows.delete(old);
    session.windows.add(target);
    session.viewWindows.set(view, target);
    target.focus();
  }
  return target;
}
export function linkedProject(): {
  session: ProjectSession;
  view: AnalysisView;
} | null {
  const url = new URL(window.location.href),
    id = url.searchParams.get("session"),
    view = url.searchParams.get("view");
  if (!id || !["Weights", "Stability", "Hull"].includes(view ?? ""))
    return null;
  try {
    const session = (
      window.opener as Window | null
    )?.camberAnalysisSessions?.get(id);
    return session ? { session, view: view as AnalysisView } : null;
  } catch {
    return null;
  }
}
export function forgetAnalysisSession(id: string) {
  if (typeof window !== "undefined") window.camberAnalysisSessions?.delete(id);
}
