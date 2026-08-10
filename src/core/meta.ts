// Shared session metadata reducer. The DocumentStoreServer is its only writer: windows may request a name,
// while begin/complete/fail save transitions remain server-owned and cannot be forged through the protocol.

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

export type SessionMetaTransition =
  | { type: "setName"; name: string }
  | { type: "beginSave"; name: string }
  | {
      type: "completeSave";
      currentId: string;
      name: string;
      savedState: HullState;
    }
  | { type: "failSave" };

export const initialSessionMeta = (state: HullState): SessionMeta => ({
  initialized: true,
  name: "",
  design: { currentId: null, savedName: null, savedState: state },
  saving: false,
});

/** Pure metadata reducer for server-owned session transitions. */
export function applyMetaCommand(
  before: SessionMeta,
  command: SessionMetaTransition,
): SessionMeta {
  switch (command.type) {
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
