import type { HullState } from "./hull";

export interface DesignIdentity {
  readonly currentId: string | null;
  readonly savedName: string | null;
  readonly savedState: HullState | null;
}

export interface SessionMeta {
  readonly initialized: boolean;
  readonly name: string;
  readonly design: DesignIdentity;
  readonly saving: boolean;
}

/** Metadata changes a window may request. Save lifecycle transitions remain owner-only. */
export type MetaCommand =
  | {
      type: "initializeDesign";
      currentId: string | null;
      savedName: string | null;
      name: string;
      savedState: HullState;
    }
  | { type: "setName"; name: string };

type OwnerMetaTransition =
  | MetaCommand
  | { type: "beginSave"; name: string }
  | {
      type: "completeSave";
      currentId: string;
      name: string;
      savedState: HullState;
    }
  | { type: "failSave" };

export const initialSessionMeta = (): SessionMeta => ({
  initialized: false,
  name: "",
  design: { currentId: null, savedName: null, savedState: null },
  saving: false,
});

/** Pure metadata reducer used by both window-requested commands and owner save transitions. */
export function applyMetaCommand(
  before: SessionMeta,
  command: OwnerMetaTransition,
): SessionMeta {
  switch (command.type) {
    case "initializeDesign":
      return {
        initialized: true,
        name: command.name,
        design: {
          currentId: command.currentId,
          savedName: command.savedName,
          savedState: command.savedState,
        },
        saving: false,
      };
    case "setName":
      return before.name === command.name
        ? before
        : { ...before, name: command.name };
    case "beginSave":
      return { ...before, name: command.name, saving: true };
    case "completeSave":
      return {
        initialized: true,
        name: command.name,
        design: {
          currentId: command.currentId,
          savedName: command.name,
          savedState: command.savedState,
        },
        saving: false,
      };
    case "failSave":
      return before.saving ? { ...before, saving: false } : before;
  }
}
