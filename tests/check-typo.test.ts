import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFiles, findTypoIssues, listRepoFiles, looksBinary } from '../scripts/check-typo.mjs';

// Caractères construits par code : ce fichier doit lui-même passer le contrôle.
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

describe('check-typo', () => {
  it('trouve les tirets cadratins et demi-cadratins avec leur position', () => {
    expect(findTypoIssues('ok - ok\nmauvais ' + EM + ' ici\n' + EN + 'x')).toEqual([
      { line: 2, column: 9, label: 'tiret cadratin (U+2014)' },
      { line: 3, column: 1, label: 'demi-cadratin (U+2013)' },
    ]);
    expect(findTypoIssues('2026-10-18 Dolly et Max - Mont Granier')).toEqual([]);
  });

  it('ignore les fichiers binaires', () => {
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x00, 0x47]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode('texte'))).toBe(false);
  });

  it('contrôle des fichiers sur disque', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esam-typo-'));
    writeFileSync(join(dir, 'bon.md'), 'Titre - sous-titre\n');
    writeFileSync(join(dir, 'mauvais.ts'), `// a ${EM} b\n`);
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0, 1, 2, 0xe2, 0x80, 0x94]));
    const problems = checkFiles(['bon.md', 'mauvais.ts', 'image.bin', 'absent.txt'], dir);
    expect(problems).toEqual([{ file: 'mauvais.ts', line: 1, column: 6, label: 'tiret cadratin (U+2014)' }]);
  });

  it('liste les fichiers du dépôt git, suivis et nouveaux non ignorés', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esam-typo-git-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), 'ignore.txt\n');
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'ignore.txt'), EM);
    expect(listRepoFiles(dir).sort()).toEqual(['.gitignore', 'a.txt']);
  });
});
