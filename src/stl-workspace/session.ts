import { forgetAnalysisSession } from "./windows";
import {
  emptyBook,
  interpretSheetCommand,
  type SheetCommand,
  type WeightBook,
} from "../core/sheet/book";
import { EMPTY_LOADING, type StabilityLoadingState } from "../analysis/loading";
import {
  DEFAULT_CONFIGURATION,
  validateConfiguration,
  type Asset,
  type Configuration,
  type Inspection,
} from "./setup";
import { WorkspaceService } from "./service";

export interface ProjectSnapshot {
  configuration: Configuration;
  book: WeightBook;
  loading: StabilityLoadingState;
}
/** The one command/history authority shared by the main view and its secondary windows. */
export class ProjectSession {
  readonly id = crypto.randomUUID();
  readonly windows = new Set<Window>();
  readonly viewWindows = new Map<string, Window>();
  readonly service: WorkspaceService;
  readonly initialConfiguration: Configuration;
  readonly listeners = new Set<() => void>();
  private past: ProjectSnapshot[] = [];
  private future: ProjectSnapshot[] = [];
  private saved?: ProjectSnapshot;
  private value: {
    document: ProjectSnapshot;
    dirty: boolean;
    undo: boolean;
    redo: boolean;
  };
  constructor(
    readonly asset: Asset,
    readonly initialPreview: Inspection,
    document?: ProjectSnapshot,
    saved = false,
  ) {
    this.service = new WorkspaceService(asset);
    const snapshot = document ?? {
      configuration: { ...DEFAULT_CONFIGURATION },
      book: emptyBook(),
      loading: { ...EMPTY_LOADING },
    };
    this.initialConfiguration = snapshot.configuration;
    this.value = {
      document: snapshot,
      dirty: !saved,
      undo: false,
      redo: false,
    };
    if (saved) this.saved = snapshot;
  }
  // Opening uses this same service: parsed preview is not discarded/reinstalled.
  static async open(asset: Asset, document?: ProjectSnapshot, saved = false) {
    const session = new ProjectSession(asset, {}, document, saved);
    try {
      Object.assign(
        session.initialPreview,
        await session.service.preview(session.value.document.configuration),
      );
      return session;
    } catch (e) {
      session.service.dispose();
      throw e;
    }
  }
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  };
  getSnapshot = () => this.value;
  private publish(document: ProjectSnapshot) {
    this.value = {
      document,
      dirty: document !== this.saved,
      undo: !!this.past.length,
      redo: !!this.future.length,
    };
    this.listeners.forEach((f) => f());
  }
  change(update: (previous: ProjectSnapshot) => ProjectSnapshot) {
    const before = this.value.document,
      next = update(before);
    if (next === before || JSON.stringify(next) === JSON.stringify(before))
      return;
    this.past = [...this.past.slice(-99), before];
    this.future = [];
    this.publish(next);
  }
  dispatch = async (command: SheetCommand) => {
    const result = interpretSheetCommand(this.value.document.book, command);
    if ("rejected" in result) return result;
    this.change((s) => ({ ...s, book: result.book }));
    return { accepted: true as const };
  };
  configure(configuration: Configuration, expected?: Configuration) {
    if (expected && this.value.document.configuration !== expected)
      throw new Error(
        "Hull settings changed in another view. Review the current settings and try again.",
      );
    validateConfiguration(configuration);
    this.change((s) => ({ ...s, configuration }));
  }
  loading = (update: (p: StabilityLoadingState) => StabilityLoadingState) =>
    this.change((s) => ({ ...s, loading: update(s.loading) }));
  undo = () => {
    const p = this.past.pop();
    if (p) {
      this.future.push(this.value.document);
      this.publish(p);
    }
  };
  redo = () => {
    const p = this.future.pop();
    if (p) {
      this.past.push(this.value.document);
      this.publish(p);
    }
  };
  downloaded(snapshot: ProjectSnapshot) {
    this.saved = snapshot;
    this.publish(this.value.document);
  }
  dispose() {
    forgetAnalysisSession(this.id);
    this.windows.forEach((w) => w.close());
    this.windows.clear();
    this.viewWindows.clear();
    this.service.dispose();
  }
}
