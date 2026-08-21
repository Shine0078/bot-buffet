import { readFileSync, writeFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const npm = { name: lock.name, version: lock.version, dependencies: {} };
const components = [];
function walk(node, path = []) {
  for (const [name, value] of Object.entries(node.packages ?? {})) {
    if (name === '') continue;
    const packageName = name.replace(/^node_modules\//, '');
    const packageValue = value;
    components.push({
      type: 'library',
      name: packageName,
      version: packageValue.version ?? 'unknown',
      purl: `pkg:npm/${packageName}@${packageValue.version ?? 'unknown'}`,
      scope: path.length ? 'optional' : 'required',
    });
  }
}
walk(lock);
writeFileSync(
  'sbom.cyclonedx.json',
  JSON.stringify(
    {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        component: { type: 'application', name: npm.name, version: npm.version },
      },
      components,
    },
    null,
    2,
  ),
);
console.log(`Wrote SBOM with ${components.length} components`);
