/** Shared by individual exports and the library-wide ZIP backup. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Do not revoke before the browser has consumed the download request.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
