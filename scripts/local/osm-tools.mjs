import { spawn } from 'node:child_process';
import { mkdir, access, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadFile, verifyDownload } from './osm-io.mjs';

export const CONVERTER = {
  version: '0.10.2',
  bytes: 93278824,
  url: 'https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar',
  sha256: 'f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d',
};
export const JAVA = {
  bytes: 48999141,
  url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip',
  sha256: 'd35f31e712f0fcf6ac5a093edc90204fbff22f720ba3950bd09d331d5e621636',
  directory: 'jdk-21.0.12.1+1-jre',
};
export function runProcess(
  command,
  args,
  { signal, cwd, onLine = () => {} } = {},
) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '',
      pending = '',
      processError;
    const receive = (chunk) => {
      const text = chunk
        .toString()
        .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
      tail = (tail + text).slice(-4000);
      pending = (pending + text).slice(-8000);
      const lines = pending.split(/[\r\n]+/);
      pending = lines.pop() || '';
      for (const line of lines) if (line.trim()) onLine(line.slice(0, 500));
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', (error) => {
      processError = error;
    });
    child.once('close', (code) => {
      if (processError) reject(processError);
      else if (signal?.aborted) reject(new Error('Operation stopped.'));
      else if (code === 0) accept(tail);
      else
        reject(
          new Error(
            `Preparation process exited (${code}). ${tail.slice(-1800)}`,
          ),
        );
    });
  });
}
export async function ensureTools(root, signal, report) {
  const tools = join(root, 'tools');
  await mkdir(tools, { recursive: true });
  const jar = join(tools, `planetiler-${CONVERTER.version}.jar`);
  if (
    !(await access(jar).then(
      () => true,
      () => false,
    ))
  ) {
    report('Downloading map converter (89 MiB)…');
    const partial = `${jar}.part`;
    await downloadFile({ ...CONVERTER, path: partial, signal });
    await verifyDownload(partial, CONVERTER.sha256, 'sha256', signal);
    await rename(partial, jar);
  } else await verifyDownload(jar, CONVERTER.sha256, 'sha256', signal);
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    const version = await runProcess('java', ['-version'], { signal });
    if (!/version "(?:2[1-9]|[3-9]\d)\./.test(version))
      throw new Error('Install Java 21 or newer to prepare OSM maps.');
    return { jar, java: 'java' };
  }
  const runtime = join(tools, JAVA.directory),
    java = join(runtime, 'bin', 'java.exe');
  const ready = join(runtime, '.openview-ready');
  if (
    !(await Promise.all([access(java), access(ready)]).then(
      () => true,
      () => false,
    ))
  ) {
    report('Downloading private Java runtime (47 MiB)…');
    const archive = join(tools, 'java.zip');
    await downloadFile({ ...JAVA, path: archive, signal });
    await verifyDownload(archive, JAVA.sha256, 'sha256', signal);
    // The archive is checksum pinned. Validate every entry before extraction as well.
    const script = join(tools, 'extract-java.ps1');
    await writeFile(
      script,
      `param([string] $Archive, [string] $Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\\') + '\\'
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  [long] $bytes = 0
  if ($zip.Entries.Count -gt 3000) { throw 'Too many runtime files.' }
  foreach ($entry in $zip.Entries) {
    $path = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $entry.FullName))
    if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe runtime archive path.' }
    $bytes += $entry.Length
    if ($bytes -gt 536870912) { throw 'Runtime archive is too large.' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
`,
    );
    // A cancelled extraction is discarded only within the owned tool directory.
    await rm(runtime, { recursive: true, force: true });
    await runProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        archive,
        tools,
      ],
      { signal },
    );
    await access(java);
    await runProcess(java, ['-version'], { signal });
    await writeFile(ready, JAVA.sha256);
    await rm(archive, { force: true });
  }
  return { jar, java };
}
