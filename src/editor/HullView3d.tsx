// The editor's 3D panel: `View3d` wired to this window's store and UI state.
//
// `View3d` itself stays prop-driven, because the interpolation viewer renders it too and that app holds no
// store — it derives one hull from a blend and has nothing to dispatch. This wrapper is the editor-side
// adapter, and it is what makes the 3D view a PANEL: like the others it takes nothing, so it can be mounted
// wherever the window's two providers are.

import { View3d } from "../components/View3d";
import { useDocumentRuntime } from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import { DetachPanelButton } from "./DetachPanelButton";

export function HullView3d() {
  const model = useDocumentRuntime();
  const { selection, sampling, curvature, stl } = useEditorUi();
  return (
    <View3d
      model={model}
      selection={selection}
      sampling={sampling}
      curvature={curvature}
      stl={stl}
      // Detaching a copy of this pane is an editor idea, not a 3D-view one — the interpolation app renders
      // the same View3d and has no session to open a window on. So it is passed in from here.
      actions={<DetachPanelButton kind="view3d" />}
    />
  );
}
