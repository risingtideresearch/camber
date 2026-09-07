/* eslint-disable react-refresh/only-export-components -- the provider and its hook are one binding */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** The operation exposed by the last formula editor to receive focus. */
type FormulaInsertion = (text: string, caretBack: number) => void;

interface FormulaInsertionContextValue {
  readonly available: boolean;
  readonly activate: (insertion: FormulaInsertion) => () => void;
  readonly insert: (text: string, caretBack?: number) => void;
}

const FormulaInsertionContext = createContext<FormulaInsertionContextValue>({
  available: false,
  activate: () => () => undefined,
  insert: () => undefined,
});

/**
 * The reference is outside every individual formula editor. Remembering the last editor here lets a press in
 * the reference put text back at its caret, even though keyboard navigation may have moved DOM focus away.
 */
export function FormulaInsertionProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [target, setTarget] = useState<FormulaInsertion | null>(null);
  const activate = useCallback((insertion: FormulaInsertion) => {
    setTarget(() => insertion);
    return () =>
      setTarget((current: FormulaInsertion | null) =>
        current === insertion ? null : current,
      );
  }, []);
  const value = useMemo<FormulaInsertionContextValue>(
    () => ({
      available: target !== null,
      activate,
      insert: (text, caretBack = 0) => target?.(text, caretBack),
    }),
    [activate, target],
  );
  return (
    <FormulaInsertionContext.Provider value={value}>
      {children}
    </FormulaInsertionContext.Provider>
  );
}

export const useFormulaInsertion = (): FormulaInsertionContextValue =>
  useContext(FormulaInsertionContext);
