import { useEffect, useRef } from "react";
import { Button } from "../../components/Button";

export function RenamePrompt({
  name,
  dependents,
  onChoose,
}: {
  readonly name: string;
  readonly dependents: readonly string[];
  readonly onChoose: (update: boolean | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="wrenameprompt"
      aria-labelledby="wrename-title"
      aria-describedby="wrename-description"
      onCancel={(event) => {
        event.preventDefault();
        onChoose(null);
      }}
    >
      <h2 id="wrename-title">Update dependent fields?</h2>
      <p id="wrename-description">
        Renaming to “{name}” affects {dependents.length}{" "}
        {dependents.length === 1 ? "field" : "fields"}. Update their formulas
        automatically to use the new name?
      </p>
      <ul>
        {dependents.map((address) => (
          <li key={address}>
            <code>{address}</code>
          </li>
        ))}
      </ul>
      <p>Renaming only will leave the old references in these formulas.</p>
      <div className="wrenameactions">
        <Button onClick={() => onChoose(null)}>Cancel</Button>
        <Button onClick={() => onChoose(false)}>Rename only</Button>
        <Button variant="primary" onClick={() => onChoose(true)}>
          Rename and update
        </Button>
      </div>
    </dialog>
  );
}
