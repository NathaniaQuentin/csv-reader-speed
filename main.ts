// The program the harness runs: `node /bot/main.ts` (Node 22). It reads every
// case from /input/cases.json (a JSON array of {id, input}), answers each one
// alone with run() from solve.js, and writes /output/answers.json: a JSON array
// of the answers, one per case and in the cases' order. Outside a container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
// Answers are streamed to disk as they are computed, one per write, instead
// of building the whole serialized file in memory first: the scored set is
// tens of megabytes of answers, and the sandbox caps memory at 1024 MB.

import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the house baseline runs with --no-incremental-marking,
// and an entry may tune V8's flags the same way).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

// The output directory is created when missing; only this file is written,
// never the directory itself removed.
mkdirSync(OUTPUT_DIR, { recursive: true });
const out = createWriteStream(join(OUTPUT_DIR, 'answers.json'), { encoding: 'utf8' });
const finished = new Promise<void>((resolve, reject) => {
  out.on('finish', resolve);
  out.on('error', reject);
});
out.write('[');
for (let i = 0; i < cases.length; i++) {
  if (i > 0) out.write(',');
  if (!out.write(JSON.stringify(run(cases[i].input)))) {
    await new Promise<void>((resolve) => out.once('drain', resolve));
  }
}
out.end(']');
await finished;
