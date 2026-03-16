import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

function resolveBuildHash(): string {
  const envBuildHash =
    process.env.MIDDLEMAN_BUILD_HASH?.trim() || process.env.VITE_BUILD_HASH?.trim()
  if (envBuildHash) {
    return envBuildHash
  }

  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

const minifyFlag = process.env.MINIFY?.trim().toLowerCase()
const buildMinifier =
  minifyFlag === 'false' || minifyFlag === '0' ? false : 'esbuild'
const buildHash = resolveBuildHash()

const config = defineConfig({
  build: {
    minify: buildMinifier,
    cssMinify: buildMinifier,
  },
  define: {
    __BUILD_HASH__: JSON.stringify(buildHash),
    'import.meta.env.VITE_BUILD_HASH': JSON.stringify(buildHash),
    'import.meta.env.VITE_MINIFY': JSON.stringify(minifyFlag ?? ''),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    devtools(),
    nitro({ rollupConfig: { external: [/^@sentry\//] } }),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
      },
    }),
    viteReact(),
  ],
})

export default config
