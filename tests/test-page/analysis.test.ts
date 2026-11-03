import { describe, expect, it } from 'vitest';
import {
  adviceFor,
  capabilityVerdict,
  cardFingerprintText,
  classifyHandleName,
  errorDetail,
  errorInfo,
  extensionOf,
  extensionStats,
  isLikelyRJpeg,
  largestFile,
  oldestFiles,
  type ScannedFile,
} from '../../src/test-page/analysis';
import { StorageError } from '../../src/storage/errors';

function file(path: string, size: number, lastModified: number): ScannedFile {
  return { path, name: path.split('/').pop() ?? path, size, lastModified };
}

const files = [
  file('DCIM/100MEDIA/DJI_0001.MP4', 3000, 300),
  file('DCIM/100MEDIA/DJI_0001.SRT', 10, 300),
  file('DCIM/100MEDIA/DJI_0001.LRF', 500, 300),
  file('DCIM/100MEDIA/DJI_0002_T.JPG', 200, 100),
  file('DCIM/100MEDIA/DJI_0002_W.JPG', 400, 100),
  file('MISC/README', 1, 50),
];

describe('extensions', () => {
  it('extrait l\'extension en minuscules', () => {
    expect(extensionOf('DJI_0001.MP4')).toBe('mp4');
    expect(extensionOf('README')).toBe('(sans)');
    expect(extensionOf('.cache')).toBe('(sans)');
    expect(extensionOf('a.')).toBe('(sans)');
  });

  it('compte et trie par volume', () => {
    const stats = extensionStats(files);
    expect(stats[0]).toEqual({ ext: 'mp4', count: 1, bytes: 3000 });
    expect(stats.find((s) => s.ext === 'jpg')).toEqual({ ext: 'jpg', count: 2, bytes: 600 });
  });

  it('repère les R-JPEG du M30T', () => {
    expect(isLikelyRJpeg('DJI_0002_T.JPG')).toBe(true);
    expect(isLikelyRJpeg('DJI_0002_W.JPG')).toBe(false);
  });
});

describe('empreinte de carte', () => {
  it('trouve le plus gros fichier', () => {
    expect(largestFile(files)?.name).toBe('DJI_0001.MP4');
    expect(largestFile([])).toBeNull();
  });

  it('liste les plus anciens, à égalité par chemin', () => {
    expect(oldestFiles(files, 3).map((f) => f.name)).toEqual(['README', 'DJI_0002_T.JPG', 'DJI_0002_W.JPG']);
  });

  it('donne un texte stable indépendant de l\'ordre de parcours', () => {
    const a = cardFingerprintText('Lexar', files, 4);
    const b = cardFingerprintText('Lexar', [...files].reverse(), 4);
    expect(a).toBe(b);
    expect(a.split('\n')[0]).toBe('racine=Lexar');
  });
});

describe('nature du nom de poignée', () => {
  it('reconnaît un numéro de série de volume', () => {
    expect(classifyHandleName('6A3B-1C2D')).toBe('volume-uuid');
  });

  it('reconnaît les noms de volume courants', () => {
    expect(classifyHandleName('Lexar')).toBe('volume-label');
    expect(classifyHandleName('DJI')).toBe('volume-label');
    expect(classifyHandleName('SanDisk 512')).toBe('volume-label');
  });

  it('reconnaît les dossiers génériques', () => {
    expect(classifyHandleName('DCIM')).toBe('generic-folder');
    expect(classifyHandleName('Download')).toBe('generic-folder');
    expect(classifyHandleName('100MEDIA')).toBe('generic-folder');
  });

  it('classe le reste en autre', () => {
    expect(classifyHandleName('Carte Kevin')).toBe('other');
  });
});

describe('erreurs', () => {
  it('donne nom, message et conseil d\'une DOMException', () => {
    const info = errorInfo(new DOMException('refusé', 'NotAllowedError'));
    expect(info.name).toBe('NotAllowedError');
    expect(info.message).toBe('refusé');
    expect(info.advice).toContain('acceptez');
  });

  it('remonte à l\'exception enveloppée par StorageError', () => {
    const wrapped = new StorageError('no-space', 'essai.bin', new DOMException('plein', 'QuotaExceededError'));
    const info = errorInfo(wrapped);
    expect(info.name).toBe('QuotaExceededError');
    expect(info.message).toContain('plein');
    expect(errorDetail(wrapped)).toMatch(/^QuotaExceededError: plein/);
  });

  it('a un conseil par défaut', () => {
    expect(adviceFor('BizarreError')).toContain('Notez le message');
    expect(errorInfo('texte').name).toBe('Error');
  });
});

describe('verdict des capacités', () => {
  it('bloque si une capacité indispensable manque', () => {
    const v = capabilityVerdict([
      { id: 'a', label: 'A', level: 'critical', present: false },
      { id: 'b', label: 'B', level: 'useful', present: false },
      { id: 'c', label: 'C', level: 'info', present: null },
    ]);
    expect(v.blocking).toBe(true);
    expect(v.missingUseful).toEqual(['B']);
  });

  it('ne bloque pas sinon', () => {
    expect(capabilityVerdict([{ id: 'a', label: 'A', level: 'critical', present: true }]).blocking).toBe(false);
  });
});
