// Règle typographique du projet : seul le tiret classique "-" est autorisé.
// Échoue si un fichier texte du dépôt contient un tiret cadratin (U+2014) ou
// demi-cadratin (U+2013). Fichiers examinés : ceux suivis par git, plus les
// nouveaux fichiers non ignorés (pour attraper l'erreur avant le commit).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN = [
  { char: String.fromCharCode(0x2014), label: 'tiret cadratin (U+2014)' },
  { char: String.fromCharCode(0x2013), label: 'demi-cadratin (U+2013)' },
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.mp4', '.mov', '.mp3', '.wasm',
]);

/** Vrai si le contenu ressemble à un fichier binaire (octet nul dans les 8000 premiers octets). */
export function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/** Renvoie les occurrences interdites d'un texte : { line, column, label } (1-indexés). */
export function findTypoIssues(text) {
  const issues = [];
  const lines = text.split('\n');
  lines.forEach((content, index) => {
    for (const { char, label } of FORBIDDEN) {
      let column = content.indexOf(char);
      while (column !== -1) {
        issues.push({ line: index + 1, column: column + 1, label });
        column = content.indexOf(char, column + 1);
      }
    }
  });
  return issues.sort((a, b) => a.line - b.line || a.column - b.column);
}

export function listRepoFiles(cwd = process.cwd()) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd });
  return [...new Set(out.toString('utf8').split('\0').filter(Boolean))];
}

/** Contrôle une liste de fichiers et renvoie les problèmes trouvés, avec le chemin. */
export function checkFiles(files, cwd = process.cwd()) {
  const problems = [];
  for (const file of files) {
    if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const full = `${cwd}/${file}`;
    if (!existsSync(full)) continue; // supprimé dans la copie de travail
    const buffer = readFileSync(full);
    if (looksBinary(buffer)) continue;
    for (const issue of findTypoIssues(buffer.toString('utf8'))) problems.push({ file, ...issue });
  }
  return problems;
}

function main() {
  const files = listRepoFiles();
  const problems = checkFiles(files);
  if (problems.length === 0) {
    console.log(`Typographie OK : ${files.length} fichiers vérifiés, aucun tiret cadratin ni demi-cadratin.`);
    return;
  }
  for (const p of problems) console.error(`${p.file}:${p.line}:${p.column} ${p.label} interdit, remplacer par "-"`);
  console.error(`\n${problems.length} tiret(s) interdit(s). Seul le tiret classique "-" est autorisé.`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
