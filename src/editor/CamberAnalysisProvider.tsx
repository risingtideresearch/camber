// Camber's composition adapter. Shared panels never see the document store, runtime
// model, editor UI, or worker source. Detached panels retain the same authored session.
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AnalysisProvider,
  type AnalysisHost,
} from "../analysis/ui/AnalysisProvider";
import { createHullAnalysis } from "../analysis/queries";
import { createCamberAnalysisClient } from "../analysis/camber/client";
import { unitScale } from "../core/lengthUnits";
import { defaultSession } from "../core/runtime";
import type { SheetCommand } from "../core/sheet/book";
import {
  useDocumentDispatch,
  useDocumentSnapshot,
  useDocumentStore,
} from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";

export function CamberAnalysisProvider({ children }: { children: ReactNode }) {
  const snapshot = useDocumentSnapshot();
  const store = useDocumentStore();
  const dispatchDocument = useDocumentDispatch();
  const { perf } = useEditorUi();
  const [client] = useState(() =>
    createCamberAnalysisClient(
      () =>
        new Worker(new URL("../worker/analysisWorker.ts", import.meta.url), {
          type: "module",
        }),
    ),
  );
  const rev = snapshot.sliceRevs;
  const key = `${store.windowId}/${rev.plan}/${rev.trim}/${rev.stations}/${rev.transom}/${rev.scalars}/${perf.numSections}/${perf.girthSteps}`;
  const hull = useMemo(() => {
    const state = snapshot.state.hull;
    const source = {
      key,
      state,
      session: defaultSession(state),
      sliceRevs: snapshot.sliceRevs,
      numSections: perf.numSections,
      girthSteps: perf.girthSteps,
    };
    return createHullAnalysis(
      {
        id: key,
        fixedTrim: state.deckRake,
        referenceWaterline: state.waterline * unitScale(state.unit, "m"),
        weightFrame: "camber-deck-x-world-z",
      },
      client.runner(source),
      {
        stability: true,
        measurements: true,
        legacySlices: true,
        pointViews: true,
        arbitraryPlanes: false,
      },
    );
    // The store's hull slice clocks are authoritative across structured clones. Book edits,
    // scrubber movement and fresh snapshot object identities must not replace this handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    clearTimeout(timer.current);
    client.activate(key); // before the shared provider's passive query effects
    return () => {
      timer.current = setTimeout(() => client.dispose(), 0);
    };
  }, [client, key]);
  const dispatch = useCallback(
    async (command: SheetCommand) => {
      const result = await dispatchDocument(command);
      return "rejected" in result
        ? { rejected: result.rejected }
        : { accepted: true as const };
    },
    [dispatchDocument],
  );
  const host = useMemo<AnalysisHost>(
    () => ({
      hull,
      book: snapshot.state.weights,
      displayUnit: snapshot.state.hull.unit,
      dispatch,
    }),
    [hull, snapshot.state.weights, snapshot.state.hull.unit, dispatch],
  );
  return <AnalysisProvider host={host}>{children}</AnalysisProvider>;
}
