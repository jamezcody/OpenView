import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export async function readShipKey() {
  const supplied = process.env.AISSTREAM_API_KEY?.trim();
  // Remove it before launching Vite/Wrangler or any child browser-facing runtime.
  delete process.env.AISSTREAM_API_KEY;
  if (process.env.AISSTREAM_ENABLED === 'false') return '';
  if (supplied) return supplied;
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await promisify(execFile)(
      join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        fileURLToPath(new URL('./ais-credential.ps1', import.meta.url)),
        '-Action',
        'Read',
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 8192 },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}
