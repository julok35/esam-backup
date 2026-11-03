import { execSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Identifiant du build : commit court (si disponible) et horodatage. */
function buildId(): string {
  let commit = 'local';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // Pas de dépôt git : on garde "local".
  }
  return `${commit}-${Date.now().toString(36)}`;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

/**
 * Écrit dist/precache.json : liste des fichiers à mettre en cache par public/sw.js à
 * l'installation (chemins relatifs à la base). Construite à partir du contenu réel
 * de dist/ une fois tout écrit. Les pages sont aussi listées sous leur URL de
 * navigation ("./", "test/").
 */
function precacheManifest(): Plugin {
  return {
    name: 'esam-precache-manifest',
    apply: 'build',
    enforce: 'post',
    writeBundle(options) {
      const outDir = options.dir ?? resolve(root, 'dist');
      const excluded = new Set(['sw.js', 'precache.json']);
      const files = listFiles(outDir)
        .map((file) => relative(outDir, file).split(sep).join('/'))
        .filter((file) => !excluded.has(file) && !file.endsWith('.map'));
      const pages = files.filter((file) => file === 'index.html' || file.endsWith('/index.html')).map((file) => file.replace(/index\.html$/, '') || './');
      const list = [...new Set([...pages, ...files])].sort();
      writeFileSync(join(outDir, 'precache.json'), `${JSON.stringify(list, null, 2)}\n`);
    },
  };
}

export default defineConfig(({ command, isPreview }) => ({
  // Production (et prévisualisation du build) sous https://julok35.github.io/esam-backup/
  base: command === 'build' || isPreview ? '/esam-backup/' : '/',
  define: {
    __BUILD_ID__: JSON.stringify(command === 'build' ? buildId() : 'dev'),
  },
  plugins: [precacheManifest()],
  build: {
    target: 'es2022',
    // Chrome gère modulepreload nativement : pas besoin du correctif.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      // Multipage : une entrée par page HTML. Ajouter ici toute nouvelle page.
      input: {
        main: resolve(root, 'index.html'),
        test: resolve(root, 'test/index.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));
