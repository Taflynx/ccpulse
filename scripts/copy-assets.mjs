import { copyFileSync, chmodSync } from 'node:fs';
copyFileSync('src/pricing-data.json', 'dist/pricing-data.json');
for (const f of ['index.html', 'app.js']) copyFileSync(`src/dashboard/${f}`, `dist/dashboard/${f}`);
chmodSync('dist/cli.js', 0o755);
