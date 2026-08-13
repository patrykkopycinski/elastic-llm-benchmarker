#!/usr/bin/env node
// Regression guard for the ssh2 named-export ESM bug (PR #25 broke daemon
// startup; fixed in the ssh2-esm-import follow-up).
//
// tsup's ESM output passes named imports straight through to real Node
// module resolution. Vitest/vite apply CJS interop that hides mismatches
// between what cjs-module-lexer can statically detect from a CommonJS
// dependency (e.g. ssh2's nested `utils` property) and what a plain
// `import { utils } from 'ssh2'` actually gets at runtime. The unit suite
// cannot see this class of bug -- only importing the *built* artifact
// under real, unmocked Node can.
//
// This script does exactly that against every tsup entry point, with no
// test-runner interop in the way:
//   - cli.js runs `program.parse(process.argv)` unconditionally at import
//     time (it is not guarded by an `import.meta.url` check), so it must be
//     smoke-tested as a real subprocess (`node dist/cli.js --help`) rather
//     than imported in-process.
//   - index.js, api/queue-server.js, and scripts/run-queue-benchmarks.js all
//     guard their side-effecting entrypoint code behind
//     `process.argv[1] === fileURLToPath(import.meta.url)`, which is false
//     when this script is the one doing the importing -- so a plain dynamic
//     `import()` exercises full module instantiation (import bindings,
//     top-level code) without side effects.
//
// A `SyntaxError: Named export '...' not found` (or any other
// module-instantiation failure) fails the process, which fails
// `npm run build` / CI.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

const importEntries = ['index.js', 'api/queue-server.js', 'scripts/run-queue-benchmarks.js'];

let failed = false;

// cli.js: real subprocess, since it parses process.argv unconditionally on import.
try {
  execFileSync('node', [path.join(distDir, 'cli.js'), '--help'], { stdio: 'pipe' });
  console.log('ok  cli.js (subprocess: node dist/cli.js --help)');
} catch (err) {
  failed = true;
  console.error('FAIL cli.js (subprocess: node dist/cli.js --help)');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  if (err && typeof err === 'object' && 'stderr' in err) {
    console.error(String(err.stderr));
  }
}

// Remaining entries: guarded against side effects, safe to import in-process.
for (const entry of importEntries) {
  const entryPath = path.join(distDir, entry);
  const entryUrl = `file://${entryPath}`;
  try {
    await import(entryUrl);
    console.log(`ok  ${entry}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${entry}`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  }
}

if (failed) {
  console.error('\nsmoke-esm-build: one or more built entry points failed to import/run under real Node ESM.');
  process.exit(1);
}

console.log('\nsmoke-esm-build: all built entry points imported/ran cleanly.');
