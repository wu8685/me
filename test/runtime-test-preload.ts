import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const runtimeTestRoot = fs.mkdtempSync(
  path.join(fs.realpathSync(os.tmpdir()), 'me-bun-test-runtime-'),
);

process.env.ME_RUNTIME_ROOT = runtimeTestRoot;

process.on('exit', () => {
  fs.rmSync(runtimeTestRoot, { recursive: true, force: true });
});
