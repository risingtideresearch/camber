// ---------- minimal structural types for the Patchwork plugin host ----------
//
// The tool imports no runtime values from the Patchwork or Automerge packages — the host passes a live
// document handle into the tool, and reads the exported `plugins` array structurally. So rather than add
// (and install) the `@inkandswitch/patchwork-plugins` / `@automerge/automerge-repo` packages just for
// their types, we declare the small surface we actually touch here. This keeps the build to the same
// esbuild + typescript toolchain camber already uses, with no extra dependencies.
//
// These shapes intentionally match the real ones (DocHandle, ToolRender, the plugin descriptors) so the
// bundle drops straight into a Patchwork host.

export interface DocHandle<T> {
  readonly url: string;
  doc(): T | undefined;
  change(fn: (doc: T) => void): void;
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
}

export type ToolElement = HTMLElement & { repo?: unknown; hive?: unknown };

// A tool renders into `element` for the document behind `handle`, and returns a cleanup function the host
// calls on unmount.
export type ToolRender<T = unknown> = (
  handle: DocHandle<T>,
  element: ToolElement,
) => () => void;

export interface DatatypeImplementation<T> {
  init(doc: T, repo?: unknown): void;
  getTitle(doc: T): string;
  setTitle?(doc: T, title: string): void;
  markCopy?(doc: T): void;
}

interface PluginBase {
  id: string;
  name: string;
  icon?: string;
  unlisted?: boolean;
}

export interface DatatypePlugin<T> extends PluginBase {
  type: "patchwork:datatype";
  load(): Promise<DatatypeImplementation<T>>;
}

export interface ToolPlugin<T> extends PluginBase {
  type: "patchwork:tool";
  supportedDatatypes: string[] | "*";
  forTitleBar?: boolean;
  tags?: string[];
  load(): Promise<ToolRender<T>>;
}

export type Plugin<T = unknown> = DatatypePlugin<T> | ToolPlugin<T>;
