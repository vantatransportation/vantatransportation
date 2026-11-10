import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const stub = (n) => pathToFileURL(path.join(here, "stubs", n)).href;
const tryFile = (base) => [base + ".ts", base + ".tsx", path.join(base, "index.ts")].find((f) => existsSync(f));

export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
  if (specifier === "next/server") return { url: stub("next-server.mjs"), shortCircuit: true };
  if (specifier === "next/headers") return { url: stub("next-headers.mjs"), shortCircuit: true };
  if (specifier === "next/navigation") return { url: stub("next-navigation.mjs"), shortCircuit: true };
  if (specifier === "next/cache") return { url: "data:text/javascript,export {}", shortCircuit: true };
  if (specifier === "react") return { url: stub("react.mjs"), shortCircuit: true };
  if (specifier === "@supabase/supabase-js") return { url: stub("supabase.mjs"), shortCircuit: true };
  if (specifier.startsWith("@/")) {
    const f = tryFile(path.join(root, "src", specifier.slice(2)));
    if (f) return next(pathToFileURL(f).href, context);
  }
  if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.includes("/src/")) {
    const f = tryFile(path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier));
    if (f) return next(pathToFileURL(f).href, context);
  }
  return next(specifier, context);
}
