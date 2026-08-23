import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import process from 'node:process';

/**
 * Verify a build against its provenance manifest.
 *
 * `npm run provenance` writes a manifest of every artifact and its SHA-256, and
 * nothing ever checked it. A manifest that is generated but never verified is
 * the same class of defect as a gate that never runs: it looks like evidence
 * and proves nothing, because no failure mode produces a visible symptom.
 *
 * This closes the loop. It re-hashes every artifact the manifest names and
 * fails on three distinct conditions, which are worth separating because they
 * mean different things:
 *
 *   - **missing**   an artifact in the manifest is not on disk; the build is
 *                   incomplete or the manifest is from a different build.
 *   - **mismatch**  the bytes changed after the manifest was written.
 *   - **unlisted**  a file exists in `dist/` that the manifest does not name,
 *                   which means the manifest is stale and cannot vouch for
 *                   the whole build.
 *
 * Exported for tests; run directly it verifies the repository's own manifest.
 */

export const MANIFEST_SCHEMA = 'bot-buffet.provenance.v1';

export function parseManifest(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('provenance_manifest_unparsable');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('provenance_manifest_unparsable');
  if (parsed.schema !== MANIFEST_SCHEMA)
    throw new Error(`provenance_manifest_schema_unsupported:${String(parsed.schema)}`);
  if (!Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0)
    throw new Error('provenance_manifest_empty');
  for (const artifact of parsed.artifacts) {
    if (
      !artifact ||
      typeof artifact.path !== 'string' ||
      typeof artifact.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256)
    )
      throw new Error('provenance_manifest_entry_invalid');
  }
  return parsed;
}

/**
 * Render the manifest as a `sha256sum -c` compatible file.
 *
 * The JSON manifest is machine-readable but nothing standard consumes it. This
 * format can be verified by `sha256sum -c` or `shasum -a 256 -c` on any machine
 * without Bot Buffet installed, which is what someone checking a downloaded
 * artifact actually has to hand.
 */
export function renderChecksums(manifest) {
  return (
    manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join('\n') + '\n'
  );
}

export async function verifyManifest(manifest, { root = resolve('.'), listDist } = {}) {
  const missing = [];
  const mismatched = [];

  for (const artifact of manifest.artifacts) {
    const absolute = resolve(root, artifact.path);
    let bytes;
    try {
      bytes = await readFile(absolute);
    } catch {
      missing.push(artifact.path);
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== artifact.sha256) {
      mismatched.push({ path: artifact.path, expected: artifact.sha256, actual });
    }
  }

  // A stale manifest cannot vouch for a build, so an unlisted artifact is a
  // failure rather than a curiosity.
  const listed = new Set(manifest.artifacts.map((artifact) => artifact.path));
  const unlisted = listDist ? (await listDist()).filter((path) => !listed.has(path)) : [];

  return {
    ok: missing.length === 0 && mismatched.length === 0 && unlisted.length === 0,
    checked: manifest.artifacts.length,
    missing,
    mismatched,
    unlisted,
  };
}

async function listDistFiles(root) {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const found = [];
  const walk = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) found.push(relative(root, absolute).replaceAll('\\', '/'));
    }
  };
  await walk(join(root, 'dist'));
  return found;
}

export async function main() {
  const root = resolve('.');
  const manifestPath = resolve('provenance.json');
  try {
    await stat(manifestPath);
  } catch {
    console.error('No provenance.json found. Run `npm run provenance` first.');
    process.exit(1);
  }

  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  const result = await verifyManifest(manifest, { root, listDist: () => listDistFiles(root) });

  for (const path of result.missing) console.error(`missing:   ${path}`);
  for (const entry of result.mismatched)
    console.error(
      `mismatch:  ${entry.path}\n  expected ${entry.expected}\n  actual   ${entry.actual}`,
    );
  for (const path of result.unlisted) console.error(`unlisted:  ${path}`);

  if (!result.ok) {
    console.error(
      `Provenance verification FAILED: ${result.missing.length} missing, ${result.mismatched.length} mismatched, ${result.unlisted.length} unlisted.`,
    );
    process.exit(1);
  }

  console.log(
    `Provenance verified: ${result.checked} artifacts match ${manifest.sourceRevision ?? 'unknown revision'}.`,
  );
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('provenance-verify.mjs');
if (invokedDirectly) await main();
