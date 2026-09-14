import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../components/Button";
import { buildSheetJson, parseSheet } from "../core/sheet/json";
import { linkedProject, type AnalysisView } from "./windows";
import { ProjectSession } from "./session";
import { writeRecovery, readRecovery, clearRecovery } from "./recovery";
import { Workspace } from "./Workspace";
import { DEFAULT_CONFIGURATION, message } from "./setup";
import {
  decodeProject,
  download,
  encodeProject,
  hasProjectMagic,
  MAX_PROJECT_BYTES,
} from "./project";
import "./StlApp.css";

export function StlApp() {
  return new URL(window.location.href).searchParams.has("session") ? (
    <DetachedProject />
  ) : (
    <LocalApp />
  );
}
function DetachedProject() {
  const [linked] = useState(linkedProject);
  if (!linked)
    return (
      <main className="stl-empty">
        <h1>Project window unavailable</h1>
        <p>
          This view belongs to an open project. Open your saved project in the
          main window, then open a new view from there.
        </p>
        <a href="./analysis.html">Open a project</a>
      </main>
    );
  return (
    <div className="stl-app">
      <Project
        session={linked.session}
        initialView={linked.view}
        detached
        recoveryEnabled={false}
        setRecoveryEnabled={() => undefined}
        onOpen={() => (window.opener as Window | null)?.focus()}
        reading={false}
      />
    </div>
  );
}
function LocalApp() {
  const [session, setSession] = useState<ProjectSession>();
  const active = useRef<ProjectSession | undefined>(undefined);
  const pending = useRef<ProjectSession | undefined>(undefined);
  const generation = useRef(0);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [recoverable, setRecoverable] =
    useState<Awaited<ReturnType<typeof readRecovery>>>(null);
  const [recoveryEnabled, setRecoveryEnabled] = useState(false);
  useEffect(() => {
    let current = true;
    void readRecovery().then(
      (value) => {
        if (current) setRecoverable(value);
      },
      (e) => {
        if (current)
          setNotice(
            `Local recovery unavailable: ${message(e)}. You can still open a downloaded project.`,
          );
      },
    );
    return () => {
      current = false;
    };
  }, []);
  const recover = async () => {
    if (!recoverable) return;
    const id = ++generation.current;
    setReading(true);
    const next = new ProjectSession(
      recoverable.asset,
      {},
      recoverable.document,
    );
    pending.current = next;
    try {
      Object.assign(
        next.initialPreview,
        await next.service.preview(recoverable.document.configuration),
      );
      if (id !== generation.current) {
        next.dispose();
        return;
      }
      install(next);
      setRecoveryEnabled(true);
    } catch (e) {
      next.dispose();
      if (id === generation.current) setError(message(e));
    } finally {
      if (id === generation.current) {
        pending.current = undefined;
        setReading(false);
      }
    }
  };
  useEffect(() => {
    const close = () => {
      generation.current++;
      pending.current?.dispose();
      active.current?.dispose();
    };
    window.addEventListener("unload", close);
    return () => {
      window.removeEventListener("unload", close);
      close();
    };
  }, []);
  const install = (next: ProjectSession) => {
    active.current?.dispose();
    active.current = next;
    setSession(next);
    setError("");
    setNotice("");
  };
  const openFile = async (file: File) => {
    const before = active.current;
    const beforeDocument = before?.getSnapshot().document;
    let attaching = false;
    if (
      before?.getSnapshot().dirty &&
      (before.asset.bytes.byteLength ||
        !file.name.toLowerCase().endsWith(".stl")) &&
      !confirm(
        "Open another project? Download the current project first to keep unsaved work. It stays open until the new file parses successfully.",
      )
    )
      return;
    const id = ++generation.current;
    setReading(true);
    setError("");
    let next: ProjectSession | undefined;
    let migration: string | undefined;
    try {
      if (file.size > MAX_PROJECT_BYTES)
        throw new Error(
          "File exceeds the supported size (64 MiB STL plus 4 MiB metadata).",
        );
      const bytes = await file.arrayBuffer();
      if (id !== generation.current) return;
      if (
        file.name.toLowerCase().endsWith(".camber-analysis") ||
        hasProjectMagic(bytes)
      ) {
        if (
          before?.getSnapshot().dirty &&
          !before.asset.bytes.byteLength &&
          file.name.toLowerCase().endsWith(".stl") &&
          !confirm(
            "This file is an analysis project. Replace the unsaved weight book?",
          )
        )
          return;
        const loaded = decodeProject(bytes);
        migration = loaded.migration;
        next = new ProjectSession(
          loaded.asset,
          {},
          {
            configuration: loaded.configuration,
            book: loaded.book,
            loading: loaded.loading,
          },
          !migration,
        );
      } else {
        if (
          !file.name.toLowerCase().endsWith(".stl") ||
          !bytes.byteLength ||
          bytes.byteLength > 64 * 1024 * 1024
        )
          throw new Error(
            "Choose a non-empty .stl or .camber-analysis file (STL maximum 64 MiB).",
          );
        attaching = !!before && !before.asset.bytes.byteLength;
        const document =
          before && !before.asset.bytes.byteLength
            ? {
                ...before.getSnapshot().document,
                configuration: { ...DEFAULT_CONFIGURATION },
              }
            : undefined;
        next = new ProjectSession({ name: file.name, bytes }, {}, document);
      }
      pending.current = next;
      Object.assign(
        next.initialPreview,
        await next.service.preview(next.getSnapshot().document.configuration),
      );
      if (id !== generation.current) {
        next.dispose();
        return;
      }
      if (before && before.getSnapshot().document !== beforeDocument) {
        if (attaching) {
          const latest = before.getSnapshot().document;
          next.change((s) => ({
            ...s,
            book: latest.book,
            loading: latest.loading,
          }));
        } else if (
          !confirm(
            "The current project changed during import. Replace it anyway? Download it first if you want to keep those edits.",
          )
        ) {
          next.dispose();
          return;
        }
      }
      pending.current = undefined;
      install(next);
      if (migration) setNotice(migration);
    } catch (e) {
      next?.dispose();
      if (id === generation.current) setError(message(e));
    } finally {
      if (id === generation.current) {
        setReading(false);
        pending.current = undefined;
      }
    }
  };
  const cancel = () => {
    generation.current++;
    pending.current?.dispose();
    pending.current = undefined;
    setReading(false);
  };
  return (
    <div
      className="stl-app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (reading) return;
        if (e.dataTransfer.files.length !== 1)
          setError("Drop one STL or project file at a time.");
        else void openFile(e.dataTransfer.files[0]);
      }}
    >
      <input
        ref={input}
        className="stl-file-input"
        type="file"
        accept=".stl,.camber-analysis"
        aria-label="Import STL or analysis project"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void openFile(file);
        }}
      />
      {notice && (
        <div className="stl-notice">
          {notice}
          <Button onClick={() => setNotice("")}>Dismiss</Button>
        </div>
      )}
      {error && (
        <div className="stl-notice" role="alert">
          {error}
          <Button onClick={() => setError("")}>Dismiss</Button>
        </div>
      )}
      {reading && (
        <div className="stl-notice" role="status">
          Reading triangles…<Button onClick={cancel}>Cancel import</Button>
        </div>
      )}
      {session ? (
        <Project
          key={session.id}
          session={session}
          recoveryEnabled={recoveryEnabled}
          setRecoveryEnabled={setRecoveryEnabled}
          onOpen={() => input.current?.click()}
          reading={reading}
        />
      ) : (
        <>
          <header className="stl-topbar">
            <b>Camber · Weights & stability</b>
            <span>Local files · no upload</span>
            <Button disabled={reading} onClick={() => input.current?.click()}>
              Open project…
            </Button>
          </header>
          <main className="stl-welcome">
            <h1>Start with the boat—or just its weights.</h1>
            <p>
              Drop an STL to view it immediately. Set scale and analysis details
              only when you need them.
            </p>
            <div className="stl-actions">
              <Button
                variant="primary"
                disabled={reading}
                onClick={() => input.current?.click()}
              >
                Open STL or project
              </Button>
              <Button
                disabled={reading}
                onClick={() =>
                  install(
                    new ProjectSession(
                      { name: "Untitled", bytes: new ArrayBuffer(0) },
                      {},
                    ),
                  )
                }
              >
                Start a weight book
              </Button>
            </div>
            {recoverable && (
              <div className="stl-recovery">
                <Button disabled={reading} onClick={() => void recover()}>
                  Recover {recoverable.asset.name}
                </Button>
                <Button
                  onClick={() => {
                    void clearRecovery().then(
                      () => setRecoverable(null),
                      (e) => setError(message(e)),
                    );
                  }}
                >
                  Forget recovery copy
                </Button>
                <p>Local recovery is not a downloaded file or a backup.</p>
              </div>
            )}
            <small>Binary / ASCII STL · up to 64 MiB / 200,000 triangles</small>
          </main>
        </>
      )}
    </div>
  );
}

function Project({
  session,
  onOpen,
  reading,
  recoveryEnabled,
  setRecoveryEnabled,
  initialView,
  detached = false,
}: {
  session: ProjectSession;
  onOpen: () => void;
  reading: boolean;
  recoveryEnabled: boolean;
  setRecoveryEnabled: (enabled: boolean) => void;
  initialView?: AnalysisView;
  detached?: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { document: snapshot } = state;
  const bookInput = useRef<HTMLInputElement>(null);
  const [recoveryStatus, setRecoveryStatus] = useState("");
  useEffect(() => {
    if (!recoveryEnabled) return;
    let current = true;
    const timer = setTimeout(() => {
      void writeRecovery(session.id, session.asset, snapshot).then(
        () => {
          if (current)
            setRecoveryStatus(
              "Local recovery updated · still download to keep",
            );
        },
        (e) => {
          if (current)
            setRecoveryStatus(
              `Recovery unavailable: ${message(e)}. Download to keep your work.`,
            );
        },
      );
    }, 800);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [session, snapshot, recoveryEnabled]);
  const [error, setError] = useState("");
  const save = () => {
    try {
      const document = session.getSnapshot().document;
      download(
        `${session.asset.name.replace(/\.stl$/i, "")}.camber-analysis`,
        encodeProject(
          session.asset,
          document.configuration,
          document.book,
          document.loading,
        ),
      );
      session.downloaded(document);
      setError("");
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => {
    document.title = `${session.asset.name} — ${initialView ?? "Camber analysis"}`;
    const before = (e: BeforeUnloadEvent) => {
      if (!detached && session.getSnapshot().dirty) e.preventDefault();
    };
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        try {
          const s = session.getSnapshot().document;
          download(
            `${session.asset.name.replace(/\.stl$/i, "")}.camber-analysis`,
            encodeProject(session.asset, s.configuration, s.book, s.loading),
          );
          session.downloaded(s);
        } catch (error) {
          setError(message(error));
        }
      }
    };
    window.addEventListener("beforeunload", before);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("keydown", key);
    };
  }, [session, detached, initialView]);
  const importBook = async (file: File) => {
    const before = session.getSnapshot().document;
    try {
      if (file.size > 4 * 1024 * 1024)
        throw new Error("Weight book exceeds 4 MiB.");
      const text = await file.text(),
        json = JSON.parse(text);
      if (
        ![1, 2].includes(json?.version) ||
        !Array.isArray(json.items) ||
        !Array.isArray(json.views)
      )
        throw new Error("Not a supported weight book.");
      if (session.getSnapshot().document !== before)
        throw new Error(
          "The project changed while reading the file. Try again.",
        );
      const book = parseSheet(text);
      if (
        !confirm(
          "Replace the weight book? Coordinates and formulas are kept as written, not adapted to this STL. Check datums and any Camber station references.",
        )
      )
        return;
      session.change((s) => ({ ...s, book }));
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <>
      <header className="stl-topbar">
        <b>Camber</b>
        <span className="stl-project-name">{session.asset.name}</span>
        <small>{state.dirty ? "Unsaved changes" : "Downloaded snapshot"}</small>
        <Button disabled={reading} onClick={onOpen}>
          {detached ? "Project window" : "Open…"}
        </Button>
        <Button variant="primary" onClick={save}>
          Download project
        </Button>
        <details className="stl-project-menu">
          <summary>Project</summary>
          <div>
            <Button disabled={!state.undo} onClick={session.undo}>
              Undo
            </Button>
            <Button disabled={!state.redo} onClick={session.redo}>
              Redo
            </Button>
            <Button onClick={() => bookInput.current?.click()}>
              Import book…
            </Button>
            <Button
              onClick={() =>
                download(
                  "weights.json",
                  new Blob([buildSheetJson(snapshot.book)], {
                    type: "application/json",
                  }),
                )
              }
            >
              Export book
            </Button>
            {!detached && (
              <label className="stl-check">
                <input
                  type="checkbox"
                  checked={recoveryEnabled}
                  onChange={(e) => setRecoveryEnabled(e.target.checked)}
                />
                Keep local recovery copy
              </label>
            )}
            <small>
              {recoveryEnabled
                ? recoveryStatus || "Preparing local recovery…"
                : "Download to keep your work. Recovery is optional and browser storage can be cleared."}
            </small>
          </div>
        </details>
      </header>
      <input
        ref={bookInput}
        className="stl-file-input"
        type="file"
        accept=".json"
        aria-label="Import weight book"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importBook(file);
        }}
      />
      {error && <p role="alert">{error}</p>}
      <Workspace
        session={session}
        snapshot={snapshot}
        initialView={initialView}
        detached={detached}
        onAttach={onOpen}
      />
    </>
  );
}
