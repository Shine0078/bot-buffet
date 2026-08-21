import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const roots = ['.', '.github'];
const suspicious =
  /(sk-[A-Za-z0-9_-]{20,}|AIza[\w-]{25,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{25,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)/;
const ignored = new Set(['node_modules', 'dist', '.data', '.git', 'coverage', 'backups']);
const findings = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name.startsWith('.data-')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (
      ['.ts', '.js', '.mjs', '.json', '.html', '.css', '.yml', '.yaml', '.env'].includes(
        extname(entry.name),
      )
    ) {
      const text = await readFile(path, 'utf8');
      if (suspicious.test(text)) findings.push(path);
    }
  }
}
for (const root of roots) await walk(root);
if (findings.length) {
  console.error(`Secret-like material found in: ${findings.join(', ')}`);
  process.exit(1);
}
console.log('Secret scan passed: no high-confidence credential patterns in runtime sources.');
