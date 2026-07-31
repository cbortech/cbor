#!/usr/bin/env node
/**
 * Fetches third-party test-vector fixtures from their upstream repositories.
 *
 * Most of these (edn-test-vectors, edn-abnf, cddlc) are NOT committed to this
 * repository because their upstream redistribution terms are not explicit
 * (see the README.md in each destination directory). cbor-test-vectors IS
 * committed (BSD 2-Clause license) — re-run that source to pick up upstream
 * changes.
 *
 * Usage:
 *   node scripts/fetch-test-vectors.mjs [edn-test-vectors] [edn-abnf] [cddlc] [cbor-test-vectors]
 *
 * With no arguments, all sources are fetched.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  cpSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const sources = {
  'edn-test-vectors': {
    url: 'https://github.com/hildjj/edn-test-vectors.git',
    fetch(cloneDir) {
      const dest = join(repoRoot, 'src/cdn/test-vectors/edn-test-vectors');
      for (const file of [
        'basic.csv',
        'encoding-indicators.csv',
        'success.csv',
        'failures.csv',
      ]) {
        const src = join(cloneDir, file);
        if (!existsSync(src))
          throw new Error(`Expected file missing upstream: ${src}`);
        copyFileSync(src, join(dest, file));
      }
    },
  },
  'edn-abnf': {
    url: 'https://github.com/cabo/edn-abnf.git',
    fetch(cloneDir) {
      const dest = join(repoRoot, 'src/cdn/test-vectors/edn-abnf');
      const files = [
        'basic.csv',
        'level-shifter.csv',
        'float.csv',
        'rawstrings.csv',
        'encoding-indicators.csv',
      ];
      for (const file of files) {
        const src = join(cloneDir, 'tests', file);
        if (!existsSync(src))
          throw new Error(`Expected file missing upstream: ${src}`);
        copyFileSync(src, join(dest, file));
      }
    },
  },
  cddlc: {
    url: 'https://github.com/cabo/cddlc.git',
    fetch(cloneDir) {
      const dest = join(repoRoot, 'src/cddl/test-vectors/cddlc');
      for (const dir of ['data', 'test']) {
        const src = join(cloneDir, dir);
        if (!existsSync(src))
          throw new Error(`Expected directory missing upstream: ${src}`);
        rmSync(join(dest, dir), { recursive: true, force: true });
        cpSync(src, join(dest, dir), {
          recursive: true,
          verbatimSymlinks: true,
        });
      }
    },
  },
  'cbor-test-vectors': {
    url: 'https://github.com/cbor-wg/cbor-test-vectors.git',
    fetch(cloneDir) {
      const dest = join(repoRoot, 'src/cbor/test-vectors');
      for (const dir of ['rfc8949', 'rfc8949-appendixA', 'spike']) {
        const srcDir = join(cloneDir, 'tests', dir);
        if (!existsSync(srcDir))
          throw new Error(`Expected directory missing upstream: ${srcDir}`);
        const vectors = readdirSync(srcDir).filter(
          (file) => file.endsWith('.cbor') || file.endsWith('.edn')
        );
        if (vectors.length === 0)
          throw new Error(`No .cbor/.edn files found upstream in: ${srcDir}`);
        const destDir = join(dest, dir);
        rmSync(destDir, { recursive: true, force: true });
        mkdirSync(destDir, { recursive: true });
        for (const file of vectors)
          copyFileSync(join(srcDir, file), join(destDir, file));
      }
    },
  },
};

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(sources);

for (const name of names) {
  const source = sources[name];
  if (!source) {
    console.error(
      `Unknown source: ${name} (expected one of ${Object.keys(sources).join(', ')})`
    );
    process.exitCode = 1;
    continue;
  }

  const cloneDir = mkdtempSync(join(tmpdir(), `cbor-${name}-`));
  try {
    console.log(`Cloning ${source.url} ...`);
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--quiet', source.url, cloneDir],
      {
        stdio: 'inherit',
      }
    );
    source.fetch(cloneDir);
    console.log(`Fetched ${name}`);
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}
