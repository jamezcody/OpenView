import { createHash } from 'node:crypto';
import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, type Plugin } from 'vite';
import hostingConfig from './.openai/hosting.json';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';
const CESIUM_ION_MODULE_SUFFIX = '/@cesium/engine/Source/Core/Ion.js';
const CESIUM_DEFAULT_TOKEN_LENGTH = 345;
const CESIUM_DEFAULT_TOKEN_SHA256 =
  'cd471a429327b7c79a70b0c7da0af876c4790908a3c3d58fa3c925c501a5c356';

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

function stripCesiumDefaultAccessToken(): Plugin {
  return {
    name: 'openview-strip-cesium-default-access-token',
    enforce: 'pre',
    transform(code, id) {
      const modulePath = id.split('?', 1)[0].replaceAll('\\', '/');
      if (!modulePath.endsWith(CESIUM_ION_MODULE_SUFFIX)) return;

      const assignment = /const defaultAccessToken\s*=\s*"([^"]+)"\s*;/g;
      const matches = [...code.matchAll(assignment)];
      if (matches.length !== 1)
        throw new Error(
          `Expected one Cesium default access-token assignment; found ${matches.length}.`,
        );

      const token = matches[0][1];
      const digest = createHash('sha256').update(token).digest('hex');
      if (
        token.length !== CESIUM_DEFAULT_TOKEN_LENGTH ||
        digest !== CESIUM_DEFAULT_TOKEN_SHA256
      )
        throw new Error(
          'The bundled Cesium default access token changed; refusing to package an unreviewed credential.',
        );

      return {
        code: code.replace(assignment, 'const defaultAccessToken = "";'),
        map: null,
      };
    },
  };
}

const localBindingConfig = {
  main: 'vinext/server/fetch-handler',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: {
      watch: {
        // Offline inventories, test output and build artifacts can change tens
        // of thousands of files. They are read on demand, not HMR source code.
        ignored: [
          '**/work/**',
          '**/research/**',
          '**/dist/**',
          '**/.wrangler/**',
          '**/public/camping/**',
          '**/public/cells/**',
          '**/public/cesium/**',
          '**/public/coverage/**',
          '**/public/parks/**',
          '**/public/radio/**',
          '**/public/search/**',
        ],
        ...(isCodexSeatbeltSandbox
          ? { useFsEvents: false, usePolling: true }
          : {}),
      },
    },
    plugins: [
      stripCesiumDefaultAccessToken(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
      }),
    ],
  };
});
