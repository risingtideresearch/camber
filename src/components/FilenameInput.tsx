import "./FilenameInput.css";

// The editable design-name field shared by the editor and the interpolation viewer. Styled as a quiet
// inline title that reveals its border on hover / focus; `dirty` paints an amber edge while there are
// unsaved edits. `onBlur` lets a host restore a required name that was blanked.
interface FilenameInputProps {
  value: string;
  placeholder?: string;
  title?: string;
  dirty?: boolean;
  maxLength?: number;
  onChange: (value: string) => void;
  onBlur?: () => void;
}

export function FilenameInput({
  value,
  placeholder,
  title,
  dirty = false,
  maxLength = 120,
  onChange,
  onBlur,
}: FilenameInputProps) {
  return (
    <input
      className={"filename" + (dirty ? " dirty" : "")}
      placeholder={placeholder}
      title={title}
      maxLength={maxLength}
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
    />
  );
}
