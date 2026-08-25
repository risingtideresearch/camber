// Shared session metadata reducer. The DocumentStoreServer is its only writer: windows may request a name,
// while begin/complete/fail save transitions remain server-owned and cannot be forged through the protocol.

import type { SessionDocument } from "./sessionDocument";

export interface DesignIdentity {
  readonly currentId: string | null;
  readonly savedName: string | null;
  /**
   * The whole document as it stood at the last save — hull AND sheet. Both, because this is what Revert
   * restores, and reverting a hull while leaving a half-typed weight sheet behind would be a lie.
   */
  readonly savedState: SessionDocument | null;
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
      savedState: SessionDocument;
    }
  | { type: "failSave" };

export const initialSessionMeta = (state: SessionDocument): SessionMeta => ({
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
