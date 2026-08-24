#!/usr/bin/env node
// build/sea/bundle.mjs — bundle a Node subsystem entry point (gateway or
// hermes broker CLI) into a single CommonJS file suitable for embedding into
// a Node SEA (single-executable-application) blob.
//
// This is a packaging-only script: it does not modify gateway/src, hermes
// packages' src, or generator/src logic. It compiles the ALREADY-BUILT `dist`
// output (tsc) of those subsystems into one file so `node --experimental-sea-config`
// has a single entry to snapshot.
//
// Usage:
//   node build/sea/bundle.mjs \
//     --entry <path-to-compiled-entry.js> \
//     --outfile <path-to-bundle.cjs> \
//     --cwd <package-dir-for-module-resolution> \
//     --external <comma,separated,bare,specifiers> \
//     [--esbuild <path-to-an-esbuild-package-dir>]
//
// See docs/PACKAGING.md for the externals rationale (native addons and
// dynamic-import-only browser automation deps that cannot be single-file
// bundled).

import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = { external: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--entry") out.entry = argv[++i];
    else if (a === "--outfile") out.outfile = argv[++i];
    else if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--esbuild") out.esbuildDir = argv[++i];
    else if (a === "--external") {
      out.external.push(...argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
    } else {
      throw new Error(`bundle.mjs: unknown argument ${a}`);
    }
  }
  for (const req of ["entry", "outfile", "cwd"]) {
    if (!out[req]) throw new Error(`bundle.mjs: --${req} is required`);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Default: resolve esbuild from this repo's gateway/ package (the one
  // subsystem guaranteed to carry esbuild as a real dependency chain). A
  // caller may point --esbuild at a different node_modules root.
  const esbuildDir =
    opts.esbuildDir ?? path.resolve(import.meta.dirname, "..", "..", "gateway", "node_modules", "esbuild");
  const esbuild = require_(path.join(esbuildDir, "package.json").replace(/package\.json$/, "lib/main.js"));

  const result = await esbuild.build({
    entryPoints: [path.resolve(opts.cwd, opts.entry)],
    absWorkingDir: path.resolve(opts.cwd),
    outfile: path.resolve(opts.outfile),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    // SEA main scripts run as CommonJS; the compiled `dist` output is ESM
    // (`"type": "module"` in package.json), so esbuild also does the
    // ESM->CJS transform here (dynamic top-level await, if any, is handled
    // by esbuild's CJS interop wrapper).
    logLevel: "warning",
    external: opts.external,
    // Keep readable failure output (not minified) — these binaries are
    // internal tooling artifacts, not shipped-for-review frontend bundles.
    minify: false,
    sourcemap: false,
    metafile: true,
  });

  if (result.warnings.length) {
    for (const w of result.warnings) console.warn(w.text);
  }
  console.log(`bundled ${opts.entry} -> ${opts.outfile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
