// The detached panels: what they are, and how an editor window opens one.
//
// A detached panel is a second BROWSER WINDOW on the same editing session, not a copy of the document. It
// carries the editor's `session` (and `id`, if the design has one) in its URL, joins the SharedWorker-hosted
// session the editor is already on, and from then on edits through the same authoritative store — so a point
// dragged in either window moves in both, and one history covers the pair.
//
// Opening one never closes or empties the panel it duplicates: the editor keeps its own 3D view and its own
// station editor. The point is a second look at the same hull — a big 3D view on another monitor, or every
// station laid out side by side instead of behind tabs.
//
// Hull views are opened from the pane being duplicated (DetachPanelButton). The two window-only analytical
// panels are labelled in an app bar instead: History travels with the session's undo controls, while Stability
// is opened from the main editor because it is a reading of the complete design rather than of one pane.
export type PanelKind = "view3d" | "stations" | "history" | "stability";

export interface PanelSpec {
  /** Caption in the panel window's own bar, and in its document title. */
  readonly title: string;
  /** Tooltip on the ⧉ button the source panel carries. */
  readonly hint: string;
  /** Opening size. The 3D view wants depth; the station grid wants width — it lays K sections in a row. */
  readonly width: number;
  readonly height: number;
}

export const PANELS: Record<PanelKind, PanelSpec> = {
  view3d: {
    title: "3D view",
    hint: "Open the 3D view in a window of its own, on the same hull — the editor keeps its own 3D pane. Both windows edit the same session.",
    width: 1000,
    height: 760,
  },
  stations: {
    title: "Stations",
    hint: "Open every station side by side in a window of its own, instead of one at a time behind tabs. The editor keeps its own tabbed section editor; both windows edit the same session.",
    width: 1280,
    height: 720,
  },
  history: {
    title: "History",
    hint: "Open this session's edit history in a window of its own — every moment as a tree, including the branches going back and editing again left behind. Click one to jump to it and watch the hull follow here.",
    // A tree of moments: tall and narrow, and meant to sit alongside the editor rather than over it.
    width: 560,
    height: 820,
  },
  stability: {
    title: "Stability",
    hint: "Open the limiting KG envelope and inspect the GZ curve for any displacement and VCG.",
    width: 1280,
    height: 760,
  },
};

const KINDS = Object.keys(PANELS) as PanelKind[];

const isPanelKind = (v: string | null): v is PanelKind =>
  v !== null && (KINDS as string[]).includes(v);

/** Which panel THIS window was opened as, or null if the URL doesn't name one we know. */
export function panelKindFromUrl(): PanelKind | null {
  const kind = new URL(window.location.href).searchParams.get("panel");
  return isPanelKind(kind) ? kind : null;
}

/**
 * Open (or re-focus) a detached panel on this window's session.
 *
 * The window is named per kind and session, so a second click on the same button raises the window that is
 * already showing that panel rather than piling up duplicates — while two different sessions each get their
 * own set. Opening it as a popup drops the browser chrome, which is what makes it read as a panel.
 */
export function openPanelWindow(kind: PanelKind): void {
  const here = new URL(window.location.href);
  const session = here.searchParams.get("session");
  if (!session) return; // no live session to join — nothing a panel could show
  const url = new URL("panel.html", here);
  url.searchParams.set("session", session);
  url.searchParams.set("panel", kind);
  const designId = here.searchParams.get("id");
  if (designId) url.searchParams.set("id", designId);

  const spec = PANELS[kind];
  const opened = window.open(
    url,
    `camber-${kind}-${session}`,
    `popup=1,width=${spec.width},height=${spec.height}`,
  );
  opened?.focus();
}
