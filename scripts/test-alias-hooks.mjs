import { pathToFileURL } from "node:url";
import path from "node:path";

const repoRoot = pathToFileURL(path.resolve(import.meta.dirname, "..") + path.sep).href;
const SERVER_ONLY_STUB = "data:text/javascript,export%20%7B%7D%3B";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only" || specifier === "client-only") {
    return { url: SERVER_ONLY_STUB, shortCircuit: true };
  }
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (specifier === "next/navigation") return nextResolve("next/navigation.js", context);

  const isProjectSource = specifier.startsWith("@/") || specifier.startsWith(".");
  const target = specifier.startsWith("@/") ? new URL(specifier.slice(2), repoRoot).href : specifier;
  try {
    return await nextResolve(target, context);
  } catch (error) {
    if (!isProjectSource) throw error;
    if (error?.code === "ERR_UNSUPPORTED_DIR_IMPORT") {
      try {
        return await nextResolve(`${target.replace(/\/$/, "")}/index.ts`, context);
      } catch (indexError) {
        if (indexError?.code !== "ERR_MODULE_NOT_FOUND") throw indexError;
        return nextResolve(`${target.replace(/\/$/, "")}.ts`, context);
      }
    }
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || /\.[a-z0-9]+$/i.test(target)) throw error;
    return nextResolve(`${target}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
  return nextLoad(url, context);
}
