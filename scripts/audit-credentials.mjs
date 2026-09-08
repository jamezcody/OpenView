import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const arguments_ = isMain ? process.argv.slice(2) : [];
const supportedOptions = new Set(['--generated']);
const unsupportedOptions = arguments_.filter(
  (argument) => argument.startsWith('-') && !supportedOptions.has(argument),
);
const positionalArguments = arguments_.filter(
  (argument) => !argument.startsWith('-'),
);
if (unsupportedOptions.length > 0 || positionalArguments.length > 1)
  throw new Error(
    'Usage: node scripts/audit-credentials.mjs [--generated] [directory]',
  );
const generatedOutput = arguments_.includes('--generated');
const scanRoot = resolve(positionalArguments[0] ?? projectRoot);
const ignoredDirectories = new Set([
  '.git',
  '.next',
  '.npm-cache',
  '.vinext',
  '.wrangler',
  'artifacts',
  'bin',
  'dist',
  'node_modules',
  'obj',
  'outputs',
  'payload',
  'work',
]);
const textExtensions = new Set([
  '',
  '.bat',
  '.cjs',
  '.cmd',
  '.conf',
  '.config',
  '.cs',
  '.csproj',
  '.css',
  '.csv',
  '.env',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.lock',
  '.manifest',
  '.md',
  '.mjs',
  '.properties',
  '.props',
  '.ps1',
  '.py',
  '.sh',
  '.sln',
  '.svg',
  '.targets',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);
const forbiddenCredentialExtensions = new Set([
  '.der',
  '.key',
  '.p12',
  '.pem',
  '.pfx',
  '.dpapi',
]);
const forbiddenCredentialNames = [
  /^\.npmrc$/i,
  /(?:^|[._-])(?:credential|credentials|secret|secrets)(?:[._-].*)?\.(?:json|xml)$/i,
];
const rules = [
  [
    'sensitive URL parameter',
    /[?&#;](?:access[_-]?key|access[_-]?token|api[_-]?key|apikey|api[_-]?token|auth|authorization|auth[_-]?token|client[_-]?secret|credential|key|password|secret|sig|signature|token|x[_-]amz[_-](?:credential|signature)|x[_-]api[_-]key|x[_-]goog[_-](?:credential|signature))=/i,
  ],
  [
    'URL-embedded credentials',
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`<>]+:[^\s/@"'`<>]+@[a-z0-9.-]+(?::[0-9]{1,5})?/i,
  ],
  ['private-key material', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  [
    'GitHub token',
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  ],
  ['OpenAI-style token', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['AWS access-key id', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  [
    'provider access token',
    /\b(?:glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/,
  ],
  [
    'JSON Web Token',
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}\b/,
  ],
];
const quotedAssignmentPattern =
  /["']?([A-Z_][A-Z0-9_.-]*)["']?\s*[:=]\s*(["'`])([^"'`\r\n]*)\2/gi;
const configAssignmentPattern =
  /^\s*(?:export\s+)?["']?([A-Z_][A-Z0-9_.-]*)["']?\s*[:=]\s*(.*?)\s*$/i;
const credentialNamePattern =
  /(?:^|_)(?:ACCESS_?KEY|ACCESS_?TOKEN|ACCOUNT_?KEY|API_?KEY|API_?TOKEN|AUTH|AUTHORIZATION|AUTH_?TOKEN|CLIENT_?SECRET|CONNECTION_?STRING|CREDENTIALS?|DATABASE_?URL|JWT|PASSWORD|PASSWD|PASSPHRASE|PAT|PRIVATE_?KEY|SAS|SAS_?TOKEN|SECRET|SESSION_?(?:KEY|TOKEN)|SIGNING_?KEY|TOKEN|WEBHOOK_?(?:KEY|SECRET|TOKEN))(?:$|_)/i;
const placeholderPattern =
  /^(?:<[^<>]+>|\[[^[\]]+\]|\$\{[A-Z_][A-Z0-9_]*\}|%[A-Z_][A-Z0-9_]*%|\*+|x{3,}|(?:change|replace)[-_ ]?me(?:[-_ ].*)?|not[-_ ]?a[-_ ]?real(?:[-_ ].*)?|(?:placeholder|redacted|your)(?:$|[-_ ].*))$/i;
const environmentReferencePattern =
  /^(?:(?:process|import\.meta)\.env(?:\.[A-Z_][A-Z0-9_]*|\[["'][A-Z_][A-Z0-9_]*["']\])|\$env:[A-Z_][A-Z0-9_]*|\$[A-Z_][A-Z0-9_]*)$/i;
const configExtensions = new Set([
  '.conf',
  '.config',
  '.env',
  '.ini',
  '.json',
  '.jsonc',
  '.properties',
  '.toml',
  '.yaml',
  '.yml',
]);
const connectionSecretNames = [
  'AccountKey',
  'ClientSecret',
  'Password',
  'Pwd',
  'SharedAccessKey',
  'SharedAccessSignature',
];
const connectionSecretPattern = new RegExp(
  `(?:^|[;,\\s"'])(?:${connectionSecretNames.join('|')})\\s*=\\s*([^;,"'\\s}]{6,})`,
  'gi',
);

const exactAllowedMatches = new Map([
  [
    'tests/camping.test.ts\0URL-embedded credentials',
    new Set([['https://test-user', 'test-password@example.invalid'].join(':')]),
  ],
  [
    'tests/search.test.ts\0non-placeholder secret assignment',
    new Set(['fixture-user', 'fixture-password']),
  ],
]);

const findings = [];
let filesScanned = 0;
let bytesScanned = 0;

function report(path, line, rule) {
  findings.push({ path: relative(scanRoot, path), line, rule });
}

function normalizedCredentialName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.-]+/g, '_')
    .toUpperCase();
}

function isCredentialName(name) {
  return credentialNamePattern.test(normalizedCredentialName(name));
}

function isSafeAssignedValue(raw, name = '') {
  const value = raw
    .trim()
    .replace(/\s+#.*$/, '')
    .trim();
  return (
    value.length === 0 ||
    /^(?:false|null|true|undefined)$/i.test(value) ||
    (normalizedCredentialName(name) === 'CREDENTIALS' &&
      /^(?:include|omit|same-origin)$/i.test(value)) ||
    placeholderPattern.test(value) ||
    environmentReferencePattern.test(value)
  );
}

function isAllowedMatch(rel, rule, value) {
  return exactAllowedMatches.get(`${rel}\0${rule}`)?.has(value) ?? false;
}

function matchesFor(pattern, line) {
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  return line.matchAll(new RegExp(pattern.source, flags));
}

function isPublicRegulatoryAuthorization(projectRel, name, raw) {
  // FCC LMS lkp_authorization_type.dat defines these public classifications:
  // C = Construction Permit, L = License, S = Special Temporary Authority.
  // This exception is for one field in prepared radio record pages only.
  return (
    name === 'authorization_type' &&
    /^public\/radio\/versions\/radio-[a-f0-9]{20}\/records\/r[0-3]{0,12}-\d{4,}\.json$/.test(
      projectRel,
    ) &&
    /^(?:[CLS]|"[CLS]"\s*,?)$/.test(raw.trim())
  );
}

export function credentialFindingsForLine(
  line,
  {
    projectRel = '',
    extension = '',
    environmentFile = false,
    generatedOutput = false,
  } = {},
) {
  const found = [];
  for (const [rule, pattern] of rules)
    for (const match of matchesFor(pattern, line))
      if (!isAllowedMatch(projectRel, rule, match[0])) found.push(rule);

  // Generated identifiers may be named key/token; their high-confidence
  // token, key and URL checks above still run independently of assignments.
  if (generatedOutput) return found;
  quotedAssignmentPattern.lastIndex = 0;
  for (
    let match = quotedAssignmentPattern.exec(line);
    match;
    match = quotedAssignmentPattern.exec(line)
  ) {
    if (!isCredentialName(match[1])) continue;
    const value = match[3].trim();
    if (
      !isSafeAssignedValue(value, match[1]) &&
      !isPublicRegulatoryAuthorization(projectRel, match[1], value) &&
      !isAllowedMatch(projectRel, 'non-placeholder secret assignment', value)
    )
      found.push('non-placeholder secret assignment');
  }
  if (environmentFile || configExtensions.has(extension)) {
    const match = configAssignmentPattern.exec(line);
    if (
      match &&
      isCredentialName(match[1]) &&
      !isSafeAssignedValue(match[2], match[1]) &&
      !isPublicRegulatoryAuthorization(projectRel, match[1], match[2]) &&
      !isAllowedMatch(
        projectRel,
        'non-placeholder config secret assignment',
        match[2].trim(),
      )
    )
      found.push('non-placeholder config secret assignment');
  }
  connectionSecretPattern.lastIndex = 0;
  for (
    let match = connectionSecretPattern.exec(line);
    match;
    match = connectionSecretPattern.exec(line)
  )
    if (
      !isSafeAssignedValue(match[1]) &&
      !isAllowedMatch(
        projectRel,
        'credential-bearing connection string',
        match[1].trim(),
      )
    )
      found.push('credential-bearing connection string');
  return found;
}

async function scanFile(path) {
  const rel = relative(scanRoot, path).split(sep).join('/');
  const projectRel = relative(projectRoot, path).split(sep).join('/');

  const extension = extname(path).toLowerCase();
  const name = rel.split('/').at(-1)?.toLowerCase() ?? '';
  const environmentFile =
    /^\.env(?:\.|$)/.test(name) || /^\.dev\.vars(?:\.|$)/.test(name);
  if (
    forbiddenCredentialExtensions.has(extension) ||
    forbiddenCredentialNames.some((pattern) => pattern.test(name))
  ) {
    report(path, 0, 'credential-bearing file type');
    return;
  }
  if (environmentFile && !name.endsWith('.example')) {
    report(path, 0, 'local environment file');
  }
  if (!environmentFile && !textExtensions.has(extension)) return;

  const metadata = await stat(path);
  filesScanned += 1;
  bytesScanned += metadata.size;
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    for (const rule of credentialFindingsForLine(line, {
      projectRel,
      extension,
      environmentFile,
      generatedOutput,
    }))
      report(path, lineNumber, rule);
  }
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) await scanFile(path);
  }
}

if (isMain) {
  await walk(scanRoot);

  if (findings.length) {
    for (const finding of findings)
      console.error(
        `${finding.path}${finding.line ? `:${finding.line}` : ''} [${finding.rule}]`,
      );
    console.error(
      `Credential audit failed with ${findings.length} finding(s). Match values were intentionally suppressed.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Credential audit passed: ${filesScanned.toLocaleString()} text files and ${bytesScanned.toLocaleString()} bytes scanned.`,
    );
  }
}
