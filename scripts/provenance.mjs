import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const root = resolve('.');
const files = [];
const addFile = async (absolutePath) => {
  try {
    const info = await stat(absolutePath);
    if (info.isFile()) files.push(absolutePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolutePath);
    else if (entry.isFile()) await addFile(absolutePath);
  }
};
try {
  await walk(join(root, 'dist'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
for (const path of ['package.json', 'package-lock.json', 'Dockerfile', '.github/workflows/ci.yml'])
  await addFile(resolve(path));
const artifacts = [];
for (const absolutePath of files.sort()) {
  const bytes = await readFile(absolutePath);
  artifacts.push({
    path: relative(root, absolutePath).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD']);
const provenance = {
  schema: 'bot-buffet.provenance.v1',
  generatedAt: new Date().toISOString(),
  sourceRevision: stdout.trim(),
  artifacts,
  note: 'Unsigned local build manifest; use CI/OIDC attestation before production promotion.',
};
await writeFile(resolve('provenance.json'), JSON.stringify(provenance, null, 2), { mode: 0o600 });

// Also emit the manifest in `sha256sum -c` format. The JSON is machine
// readable but nothing standard consumes it, and the person checking a
// downloaded artifact has `sha256sum` to hand, not this repository.
const checksums = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join('\n');
await writeFile(resolve('SHA256SUMS.txt'), `${checksums}\n`, { mode: 0o600 });

console.log(`Wrote provenance for ${artifacts.length} artifacts at ${provenance.sourceRevision}`);
console.log('Wrote SHA256SUMS.txt (verify with: sha256sum -c SHA256SUMS.txt)');
