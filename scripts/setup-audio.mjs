import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../.tools/python', import.meta.url));
const installer = spawn(process.env.PALIMPSEST_PYTHON || 'python', [
  '-m', 'pip', 'install', '--upgrade', '--target', target, 'yt-dlp[default]',
], { stdio: 'inherit', windowsHide: true });
installer.on('error', () => {
  console.error('Python 3.10+ is required. Install Python or set PALIMPSEST_PYTHON to its executable.');
  process.exitCode = 1;
});
installer.on('exit', (code) => { process.exitCode = code ?? 1; });
