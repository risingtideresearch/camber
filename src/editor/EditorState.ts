import { createModel, Model } from "../core/model";
import { Draw3dParams, createDraw3dParams } from "../core/draw3d";
import { ModelSelection } from "../core/modelSelection";

export type Tool = "select" | "add";

export interface EditorState {
  model: Model;
  draw3dParams: Draw3dParams;
  tool: Tool;
  selection: ModelSelection;
}

export function createEditorState(): EditorState {
  return {
    model: createModel(),
    draw3dParams: createDraw3dParams(),
    tool: "select", // "select" = click a point to select (then drag/delete/knuckle); "add" = click to add
    selection: null, // the persistently selected control point (highlighted in the editors)
  };
}
