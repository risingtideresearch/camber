/** A Unicode-friendly basename, shared by individual exports and ZIP backups. */
export function safeExportName(name: string): string {
  return (
    name
      .replace(/[^\p{L}\p{N}._\- ]+/gu, "_")
      .trim()
      .replace(/^[. ]+|[. ]+$/g, "") || "hull"
  );
}
