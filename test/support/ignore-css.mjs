/** Server-render tests exercise markup, not the browser's CSS loader. */
export async function load(url, context, nextLoad) {
  if (url.endsWith(".css"))
    return { format: "module", source: "export {};", shortCircuit: true };
  return nextLoad(url, context);
}
