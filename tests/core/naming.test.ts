import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/core/errors';
import {
  cleanText,
  fallbackInterventionName,
  findNearbyInterventions,
  interventionPath,
  MAX_INTERVENTION_NAME_LENGTH,
  MAX_SOURCE_NAME_LENGTH,
  mostFrequentCaptureDate,
  nextFallbackNumber,
  nextImportNumber,
  normalizeInterventionName,
  parseInterventionName,
  RESCUE_FOLDER,
  resolveFileNameCollision,
  ROOT_FOLDER,
  sourceFolderName,
  splitExtension,
  SYSTEM_FOLDER,
  systemPath,
  truncateName,
  yearFolder,
} from '../../src/core/naming';

// Tirets typographiques construits à la volée : la règle du projet les interdit dans les sources.
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);
const NBSP = String.fromCharCode(0xa0);

const EXAMPLE = '2026-10-18 Dolly et Max - Mont Granier';

describe('normalizeInterventionName', () => {
  it('produit le nom du brief', () => {
    expect(normalizeInterventionName({ date: '2026-10-18', animals: 'Dolly et Max', place: 'Mont Granier' })).toBe(EXAMPLE);
  });

  it('réduit les espaces, supprime les bordures et les points', () => {
    expect(normalizeInterventionName({ date: '2026-10-18', animals: `  Dolly   et${NBSP}Max `, place: ' Mont\tGranier.  ' })).toBe(EXAMPLE);
    expect(normalizeInterventionName({ date: '2026-10-18', animals: '. Dolly et Max', place: '- Mont Granier -' })).toBe(EXAMPLE);
  });

  it('remplace les caractères interdits sur exFAT et Drive', () => {
    expect(normalizeInterventionName({ date: '2026-10-18', animals: 'Dolly/Max', place: 'Col: "Granier" <nord>?|*\\' })).toBe(
      '2026-10-18 Dolly Max - Col Granier nord',
    );
    expect(normalizeInterventionName({ date: '2026-10-18', animals: 'Dolly\nMax\u0000', place: 'Granier' })).toBe('2026-10-18 Dolly Max - Granier');
  });

  it('convertit les tirets cadratins et demi-cadratins', () => {
    const name = normalizeInterventionName({ date: '2026-10-18', animals: 'Dolly', place: `Saint${EN_DASH}Pierre${EM_DASH}de-Chartreuse` });
    expect(name).toBe('2026-10-18 Dolly - Saint-Pierre-de-Chartreuse');
    expect(name).not.toContain(EN_DASH);
    expect(name).not.toContain(EM_DASH);
  });

  it('évite un faux séparateur dans la partie animaux', () => {
    expect(normalizeInterventionName({ date: '2026-10-18', animals: `Dolly ${EM_DASH} Max`, place: 'Mont Granier' })).toBe(
      '2026-10-18 Dolly, Max - Mont Granier',
    );
  });

  it('compose les accents (saisie iPhone décomposée)', () => {
    const decomposed = 'Chai\u0302ne';
    const name = normalizeInterventionName({ date: '2026-10-18', animals: 'Max', place: decomposed });
    expect(name).toBe('2026-10-18 Max - Chaîne'.normalize('NFC'));
  });

  it('gère les parties manquantes', () => {
    expect(normalizeInterventionName({ date: '2026-10-18', animals: '  ', place: '' })).toBeNull();
    expect(normalizeInterventionName({ date: '2026-10-18', animals: 'Dolly', place: ' ' })).toBe('2026-10-18 Dolly - à préciser');
    expect(normalizeInterventionName({ date: '2026-10-18', animals: '', place: 'Mont Granier' })).toBe('2026-10-18 à préciser - Mont Granier');
  });

  it('borne la longueur', () => {
    const name = normalizeInterventionName({ date: '2026-10-18', animals: 'Dolly '.repeat(30), place: 'Mont Granier '.repeat(30) });
    expect(name).not.toBeNull();
    expect(Array.from(name as string).length).toBeLessThanOrEqual(MAX_INTERVENTION_NAME_LENGTH);
    expect(name).toMatch(/^2026-10-18 Dolly.* - Mont Granier/);
    expect(name).not.toMatch(/[\s.-]$/);
    const longAnimals = normalizeInterventionName({ date: '2026-10-18', animals: 'A'.repeat(300), place: 'Granier' });
    expect(Array.from(longAnimals as string).length).toBeLessThanOrEqual(MAX_INTERVENTION_NAME_LENGTH);
    expect(longAnimals).toMatch(/ - Granier$/);
  });

  it('refuse une date invalide avec un message en français', () => {
    expect(() => normalizeInterventionName({ date: '2026-02-30', animals: 'Dolly', place: 'Granier' })).toThrow(CoreError);
    try {
      normalizeInterventionName({ date: '18/10/2026', animals: 'Dolly', place: 'Granier' });
    } catch (error) {
      expect((error as CoreError).code).toBe('invalid-date');
      expect((error as CoreError).userMessage).toContain('2026-10-18');
    }
  });
});

describe('cleanText et truncateName', () => {
  it('nettoie', () => {
    expect(cleanText('  a  b  ')).toBe('a b');
    expect(cleanText('...')).toBe('');
    expect(truncateName('abcdef', 3)).toBe('abc');
    expect(truncateName('ab -cdef', 4)).toBe('ab');
    expect(truncateName('court', 10)).toBe('court');
    // Ne coupe pas un caractère hors du plan de base en deux.
    expect(truncateName('ab\u{1F415}cd', 3)).toBe('ab\u{1F415}');
  });
});

describe('noms de repli', () => {
  it('fallbackInterventionName', () => {
    expect(fallbackInterventionName('2026-10-18', 1)).toBe('2026-10-18 Sauvegarde intervention 1 - à renommer');
    expect(() => fallbackInterventionName('2026-10-18', 0)).toThrow(RangeError);
    expect(() => fallbackInterventionName('2026-99-18', 1)).toThrow(CoreError);
  });

  it('nextFallbackNumber incrémente dans la journée sans réutiliser', () => {
    const existing = [
      EXAMPLE,
      '2026-10-18 Sauvegarde intervention 1 - à renommer',
      '2026-10-18 Sauvegarde intervention 3 - à renommer',
      '2026-10-17 Sauvegarde intervention 7 - à renommer',
      '2026.10.18 sauvegarde  intervention 2 - A renommer',
      'n’importe quoi',
    ];
    expect(nextFallbackNumber(existing, '2026-10-18')).toBe(4);
    expect(nextFallbackNumber(existing, '2026-10-17')).toBe(8);
    expect(nextFallbackNumber(existing, '2026-10-19')).toBe(1);
    expect(nextFallbackNumber([], '2026-10-18')).toBe(1);
  });
});

describe('parseInterventionName', () => {
  it('lit un nom conforme', () => {
    expect(parseInterventionName(EXAMPLE)).toEqual({
      date: '2026-10-18',
      animals: 'Dolly et Max',
      place: 'Mont Granier',
      normalized: EXAMPLE,
      isCanonical: true,
      isFallback: false,
    });
  });

  it.each([
    ['2026.10.18 Dolly et Max - Mont Granier'],
    ['18-10-2026 Dolly et Max - Mont Granier'],
    ['18.10.2026 Dolly et Max - Mont Granier'],
    ['18/10/2026 Dolly et Max - Mont Granier'],
    ['2026-10-18. Dolly et Max - Mont Granier'],
    ['2026-10-18 - Dolly et Max - Mont Granier'],
    ['2026-10-18 Dolly et Max-Mont Granier'],
    ['2026-10-18 Dolly et Max -Mont Granier'],
    ['2026-10-18   Dolly  et Max  -  Mont Granier '],
    ['2026_10_18 Dolly et Max - Mont Granier'],
    ['20261018 Dolly et Max - Mont Granier'],
    [`2026-10-18 Dolly et Max ${EN_DASH} Mont Granier`],
    [`2026-10-18 Dolly et Max ${EM_DASH} Mont Granier`],
  ])('tolère un nom Drive mal saisi : %s', (name) => {
    const parsed = parseInterventionName(name);
    expect(parsed).not.toBeNull();
    expect(parsed?.date).toBe('2026-10-18');
    expect(parsed?.animals).toBe('Dolly et Max');
    expect(parsed?.place).toBe('Mont Granier');
    expect(parsed?.normalized).toBe(EXAMPLE);
    expect(parsed?.isCanonical).toBe(false);
  });

  it('garde les tirets internes du lieu', () => {
    expect(parseInterventionName('2026-10-18 Dolly - Saint-Pierre-de-Chartreuse')?.place).toBe('Saint-Pierre-de-Chartreuse');
    expect(parseInterventionName('2026-10-18 Dolly-Saint-Pierre')?.place).toBe('Saint-Pierre');
  });

  it('accepte un nom sans lieu', () => {
    const parsed = parseInterventionName('2026-10-18 Dolly');
    expect(parsed).toMatchObject({ date: '2026-10-18', animals: 'Dolly', place: '', normalized: '2026-10-18 Dolly', isCanonical: true });
  });

  it('reconnaît un nom de repli', () => {
    const parsed = parseInterventionName('2026-10-18 Sauvegarde intervention 2 - à renommer');
    expect(parsed?.isFallback).toBe(true);
    expect(parsed?.isCanonical).toBe(true);
    expect(parseInterventionName('2026.10.18 sauvegarde intervention 2 - à renommer')?.normalized).toBe(
      '2026-10-18 Sauvegarde intervention 2 - à renommer',
    );
  });

  it.each([[''], ['Dolly et Max - Mont Granier'], ['2026-02-30 Dolly - Granier'], ['32-10-2026 Dolly - Granier'], ['2026-10-18'], ['2026-10-18 - '], ['Photos 2026']])(
    'refuse un nom sans date lisible ou vide : %s',
    (name) => {
      expect(parseInterventionName(name)).toBeNull();
    },
  );
});

describe('mostFrequentCaptureDate', () => {
  const now = new Date(2026, 10, 3, 9, 0);

  it('prend la date la plus fréquente', () => {
    const dates = [new Date(2026, 9, 18, 14), new Date(2026, 9, 18, 15), new Date(2026, 9, 17, 23), new Date(2026, 9, 18, 0, 5).getTime()];
    expect(mostFrequentCaptureDate(dates, now)).toBe('2026-10-18');
  });

  it('en cas d’égalité, la plus récente', () => {
    expect(mostFrequentCaptureDate([new Date(2026, 9, 17, 10), new Date(2026, 9, 18, 10)], now)).toBe('2026-10-18');
    expect(mostFrequentCaptureDate([new Date(2026, 9, 18, 10), new Date(2026, 9, 17, 10)], now)).toBe('2026-10-18');
  });

  it('se replie sur la date du jour', () => {
    expect(mostFrequentCaptureDate([], now)).toBe('2026-11-03');
    expect(mostFrequentCaptureDate([null, undefined, Number.NaN], now)).toBe('2026-11-03');
  });

  it('ignore les horloges déréglées', () => {
    const dates = [new Date(1970, 0, 1), new Date(2000, 0, 1), new Date(2000, 0, 1), new Date(2030, 0, 1), new Date(2026, 9, 18)];
    expect(mostFrequentCaptureDate(dates, now)).toBe('2026-10-18');
  });
});

describe('findNearbyInterventions', () => {
  const names = [
    '2026-10-14 Rex - Chamrousse',
    '2026-10-15 Médor - Belledonne',
    '2026.10.16 Kiwi - Vercors',
    '2026-10-18 Sauvegarde intervention 1 - à renommer',
    EXAMPLE,
    '2026-10-19 Futur - Ailleurs',
    'Divers',
  ];

  it('même date ou trois jours avant, du plus proche au plus lointain', () => {
    const found = findNearbyInterventions(names, '2026-10-18');
    expect(found.map((f) => [f.name, f.daysBefore])).toEqual([
      [EXAMPLE, 0],
      ['2026-10-18 Sauvegarde intervention 1 - à renommer', 0],
      ['2026.10.16 Kiwi - Vercors', 2],
      ['2026-10-15 Médor - Belledonne', 3],
    ]);
  });

  it('respecte daysBack et traverse les mois', () => {
    expect(findNearbyInterventions(names, '2026-10-18', 0)).toHaveLength(2);
    expect(findNearbyInterventions(['2026-09-30 Rex - Col'], '2026-10-02').map((f) => f.daysBefore)).toEqual([2]);
    expect(() => findNearbyInterventions(names, 'hier')).toThrow(CoreError);
  });
});

describe('sous-dossier source', () => {
  it('normalise la saisie', () => {
    expect(sourceFolderName('Drone M30T', 1)).toBe('Drone M30T');
    expect(sourceFolderName('  Kévin  ', 1)).toBe('Kévin');
    expect(sourceFolderName('Kévin/GoPro', 1)).toBe('Kévin GoPro');
    expect(Array.from(sourceFolderName('x'.repeat(200), 1))).toHaveLength(MAX_SOURCE_NAME_LENGTH);
  });

  it('saisie vide : ImportN - à renommer', () => {
    expect(sourceFolderName('', 1)).toBe('Import1 - à renommer');
    expect(sourceFolderName(' ?? ', 3)).toBe('Import3 - à renommer');
    expect(() => sourceFolderName('', 0)).toThrow(RangeError);
  });

  it('nextImportNumber', () => {
    expect(nextImportNumber(['Drone M30T', 'Import1 - à renommer', 'Import4 - à renommer', 'Kévin'])).toBe(5);
    expect(nextImportNumber([])).toBe(1);
  });
});

describe('arborescence', () => {
  it('constantes et chemins', () => {
    expect([ROOT_FOLDER, RESCUE_FOLDER, SYSTEM_FOLDER]).toEqual(['ESAM', '01 - Secours', '_systeme']);
    expect(yearFolder('2026-10-18')).toBe('2026');
    expect(yearFolder(new Date(2027, 0, 1, 0, 30))).toBe('2027');
    expect(() => yearFolder('2026')).toThrow(CoreError);
    expect(interventionPath({ year: '2026', intervention: EXAMPLE, source: 'Drone M30T' })).toEqual([
      'ESAM',
      '01 - Secours',
      '2026',
      EXAMPLE,
      'Drone M30T',
    ]);
    expect(interventionPath({ year: '2026', intervention: EXAMPLE })).toHaveLength(4);
    expect(() => interventionPath({ year: '2026', intervention: 'a/b' })).toThrow(RangeError);
    expect(() => interventionPath({ year: '2026', intervention: '..' })).toThrow(RangeError);
    expect(() => interventionPath({ year: '2026', intervention: EXAMPLE, source: '' })).toThrow(RangeError);
    expect(systemPath()).toEqual(['ESAM', '_systeme']);
    expect(systemPath('index.json')).toEqual(['ESAM', '_systeme', 'index.json']);
  });
});

describe('resolveFileNameCollision', () => {
  it('garde le nom s’il est libre', () => {
    expect(resolveFileNameCollision('photo.jpg', [])).toBe('photo.jpg');
    expect(resolveFileNameCollision('photo.jpg', ['autre.jpg'])).toBe('photo.jpg');
  });

  it('suffixe _2 puis _3 en respectant l’extension', () => {
    expect(resolveFileNameCollision('photo.jpg', ['photo.jpg'])).toBe('photo_2.jpg');
    expect(resolveFileNameCollision('photo.jpg', ['photo.jpg', 'photo_2.jpg'])).toBe('photo_3.jpg');
    expect(resolveFileNameCollision('DJI_0001.MP4', ['DJI_0001.MP4'])).toBe('DJI_0001_2.MP4');
  });

  it('compare sans tenir compte de la casse (exFAT)', () => {
    expect(resolveFileNameCollision('PHOTO.JPG', ['photo.jpg', 'Photo_2.JPG'])).toBe('PHOTO_3.JPG');
  });

  it('extensions doubles, sans extension, fichiers cachés', () => {
    expect(resolveFileNameCollision('archive.TAR.GZ', ['archive.tar.gz'])).toBe('archive_2.TAR.GZ');
    expect(resolveFileNameCollision('README', ['README'])).toBe('README_2');
    expect(resolveFileNameCollision('.nomedia', ['.nomedia'])).toBe('.nomedia_2');
    expect(resolveFileNameCollision('photo.2026.jpg', ['photo.2026.jpg'])).toBe('photo.2026_2.jpg');
    expect(resolveFileNameCollision('photo_2.jpg', ['photo_2.jpg'])).toBe('photo_2_2.jpg');
    expect(splitExtension('a.')).toEqual({ base: 'a.', extension: '' });
    expect(splitExtension('.tar.gz')).toEqual({ base: '.tar', extension: '.gz' });
  });

  it('propriété : jamais un nom existant, jamais deux fois le même', () => {
    // Générateur pseudo-aléatoire déterministe (LCG) : le test est reproductible.
    let seed = 42;
    const random = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const bases = ['photo', 'PHOTO', 'DJI_0001', 'photo_2', 'clip', 'a'];
    const extensions = ['.jpg', '.JPG', '.mp4', '', '.tar.gz'];
    for (let run = 0; run < 50; run += 1) {
      const taken: string[] = [];
      for (let i = 0; i < random(20); i += 1) taken.push(`${bases[random(bases.length)]}${extensions[random(extensions.length)]}`);
      const initial = new Set(taken.map((n) => n.toLowerCase()));
      const produced = new Set<string>();
      for (let i = 0; i < 40; i += 1) {
        const wanted = `${bases[random(bases.length)]}${extensions[random(extensions.length)]}`;
        const result = resolveFileNameCollision(wanted, taken);
        const key = result.toLowerCase();
        expect(initial.has(key)).toBe(false);
        expect(produced.has(key)).toBe(false);
        expect(taken.map((n) => n.toLowerCase())).not.toContain(key);
        produced.add(key);
        taken.push(result);
      }
    }
  });
});
