import { readdir, readFile, writeFile } from 'node:fs/promises';
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
const sarif = {
  version: '2.1.0',
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  runs: [
    {
      tool: {
        driver: {
          name: 'bot-buffet-secret-scan',
          version: '0.1.0',
          informationUri: 'https://github.com/openai/bot-buffet',
          rules: [
            {
              id: 'secret.high-confidence',
              name: 'High-confidence secret pattern',
              shortDescription: { text: 'Credential-like material must not be committed.' },
              helpUri: 'https://docs.github.com/en/code-security/secret-scanning',
            },
          ],
        },
      },
      results: findings.map((path) => ({
        ruleId: 'secret.high-confidence',
        level: 'error',
        message: { text: 'High-confidence credential pattern detected.' },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: path.replaceAll('\\', '/') },
            },
          },
        ],
      })),
    },
  ],
};
await writeFile('results.sarif', JSON.stringify(sarif, null, 2), { mode: 0o600 });
if (findings.length) {
  console.error(`Secret-like material found in: ${findings.join(', ')}`);
  process.exit(1);
}
console.log('Secret scan passed: no high-confidence credential patterns in runtime sources.');
