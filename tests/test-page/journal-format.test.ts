import { describe, expect, it } from 'vitest';
import {
  architectureVerdict,
  buildSummary,
  CSV_BOM,
  CSV_COLUMNS,
  csvCell,
  csvFileName,
  csvLine,
  parseJournal,
  toCsv,
  type JournalEntry,
} from '../../src/test-page/journal-format';

function entry(partial: Partial<JournalEntry>): JournalEntry {
  return { ts: '2026-11-03T10:00:00.000Z', step: 1, test: 'essai', param: '', bytes: null, ms: null, rate: null, result: 'OK', detail: '', ...partial };
}

describe('CSV', () => {
  it('écrit l\'en-tête seul pour un journal vide', () => {
    const csv = toCsv([]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toBe(`${CSV_BOM}${CSV_COLUMNS.join(';')}\r\n`);
    expect(csv).toContain('horodatage;etape;test;parametre;taille_octets;duree_ms;debit_Mo_s;resultat;detail');
  });

  it('formate une ligne avec virgule décimale', () => {
    const line = csvLine(entry({ test: 'lecture', param: 'morceau 4 Mo', bytes: 1048576, ms: 12.34, rate: 81.0373, detail: 'ok' }));
    expect(line).toBe('2026-11-03T10:00:00.000Z;1;lecture;morceau 4 Mo;1048576;12,3;81,04;OK;ok');
  });

  it('laisse vides les valeurs sans objet', () => {
    expect(csvLine(entry({}))).toBe('2026-11-03T10:00:00.000Z;1;essai;;;;;OK;');
  });

  it('échappe séparateurs, guillemets et sauts de ligne', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell('simple, texte')).toBe('simple, texte');
  });

  it('une ligne par mesure, fins de ligne CRLF', () => {
    const csv = toCsv([entry({}), entry({ step: 2 })]);
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(3);
  });

  it('nomme le fichier avec la date locale', () => {
    expect(csvFileName(new Date(2026, 10, 3, 9, 5))).toBe('esam-etape0-2026-11-03-09h05.csv');
  });
});

describe('relecture du journal', () => {
  it('relit un JSON valide et écarte les lignes abîmées', () => {
    const json = JSON.stringify([entry({}), { ts: 1 }, null, entry({ result: 'ECHEC' })]);
    expect(parseJournal(json)).toHaveLength(2);
  });

  it('résiste à un contenu absent ou invalide', () => {
    expect(parseJournal(null)).toEqual([]);
    expect(parseJournal('pas du json')).toEqual([]);
    expect(parseJournal('{"a":1}')).toEqual([]);
  });
});

describe('verdict et résumé', () => {
  const ok = [
    entry({ step: 1, test: 'lecture plus gros fichier' }),
    entry({ step: 2, test: "écriture fichier d'essai" }),
    entry({ step: 2, test: 'relecture et empreinte' }),
  ];

  it('incomplet tant que les étapes 1 et 2 ne sont pas faites', () => {
    expect(architectureVerdict([])).toContain('incomplet');
    expect(architectureVerdict(ok.slice(0, 2))).toContain('incomplet');
  });

  it('validé quand carte lue et SSD écrit et relu', () => {
    expect(architectureVerdict(ok)).toContain('validée');
  });

  it('à revoir si la dernière mesure critique échoue', () => {
    expect(architectureVerdict([...ok, entry({ step: 2, test: 'relecture et empreinte', result: 'ECHEC' })])).toContain('à revoir');
  });

  it('se fonde sur la dernière mesure', () => {
    expect(architectureVerdict([entry({ step: 1, test: 'lecture plus gros fichier', result: 'ECHEC' }), ...ok])).toContain('validée');
  });

  it('résume chaque étape avec la dernière mesure de chaque test', () => {
    const text = buildSummary([...ok, entry({ step: 3, test: 'a lecture seule', bytes: 100 * 1048576, ms: 1000, rate: 100 }), entry({ step: 3, test: 'a lecture seule', bytes: 100 * 1048576, ms: 500, rate: 200 })], {
      now: new Date(2026, 10, 3, 9, 0),
      device: 'SM-S928B, Chrome 142',
      build: 'abc',
    });
    expect(text).toContain('Appareil : SM-S928B, Chrome 142');
    expect(text).toContain('architecture validée');
    expect(text).toContain('Étape 0 - Capacités du navigateur\n  pas encore fait');
    expect(text).toContain('200,0 Mo/s');
    expect(text).not.toContain('100,0 Mo/s');
  });
});
