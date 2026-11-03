import { describe, expect, it } from 'vitest';
import {
  bytesPerSecond,
  daysBetween,
  formatBytes,
  formatDecimal,
  formatDuration,
  formatRate,
  isoDate,
  isoDateToDayNumber,
  isoFromParts,
  isValidIsoDate,
  todayIso,
} from '../../src/core/format';
import * as core from '../../src/core';

describe('formatBytes', () => {
  it('affiche les octets en français, unités décimales', () => {
    expect(formatBytes(0)).toBe('0 octet');
    expect(formatBytes(1)).toBe('1 octet');
    expect(formatBytes(999)).toBe('999 octets');
    expect(formatBytes(1000)).toBe('1 Ko');
    expect(formatBytes(1_234_567)).toBe('1,2 Mo');
    expect(formatBytes(1_200_000_000)).toBe('1,2 Go');
    expect(formatBytes(15_340_000_000)).toBe('15,3 Go');
    expect(formatBytes(512_000_000_000)).toBe('512 Go');
    expect(formatBytes(1_500_000_000_000)).toBe('1,5 To');
    expect(formatBytes(2_000_000_000_000_000)).toBe('2000 To');
  });

  it('refuse les valeurs absurdes', () => {
    expect(formatBytes(-1)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('-');
  });

  it('formatDecimal retire les zéros inutiles', () => {
    expect(formatDecimal(2, 1)).toBe('2');
    expect(formatDecimal(2.25, 2)).toBe('2,25');
    expect(formatDecimal(10, 0)).toBe('10');
  });
});

describe('formatDuration', () => {
  it('secondes, minutes, heures', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(59_600)).toBe('1 min 00 s');
    expect(formatDuration(185_000)).toBe('3 min 05 s');
    expect(formatDuration(3_720_000)).toBe('1 h 02 min');
    expect(formatDuration(-5)).toBe('-');
  });
});

describe('formatRate et bytesPerSecond', () => {
  it('calcule et affiche le débit en Mo/s', () => {
    expect(bytesPerSecond(200_000_000, 2000)).toBe(100_000_000);
    expect(bytesPerSecond(1, 0)).toBeNull();
    expect(bytesPerSecond(-1, 10)).toBeNull();
    expect(formatRate(85_300_000)).toBe('85,3 Mo/s');
    expect(formatRate(205_000_000)).toBe('205 Mo/s');
    expect(formatRate(null)).toBe('-');
  });
});

describe('dates AAAA-MM-JJ', () => {
  it('isoDate et todayIso utilisent l’heure locale', () => {
    expect(isoDate(new Date(2026, 9, 18, 23, 59))).toBe('2026-10-18');
    expect(isoDate(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
    expect(todayIso(new Date(2026, 10, 3, 8))).toBe('2026-11-03');
    expect(() => isoDate(new Date(Number.NaN))).toThrow(RangeError);
  });

  it('valide les dates réelles', () => {
    expect(isValidIsoDate('2026-10-18')).toBe(true);
    expect(isValidIsoDate('2028-02-29')).toBe(true);
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('2026-1-01')).toBe(false);
    expect(isValidIsoDate('18-10-2026')).toBe(false);
    expect(isoDateToDayNumber('1970-01-02')).toBe(1);
    expect(isoFromParts(2026, 10, 18)).toBe('2026-10-18');
    expect(isoFromParts(2026, 2, 30)).toBeNull();
    expect(isoFromParts(2026.5, 1, 1)).toBeNull();
    expect(isoFromParts(0, 1, 1)).toBeNull();
  });

  it('daysBetween traverse les changements d’heure et de mois', () => {
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysBetween('2026-10-18', '2026-10-15')).toBe(-3);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('nope', '2026-01-01')).toBeNull();
  });
});

describe('réexports de src/core', () => {
  it('expose chaque module depuis index.ts', () => {
    for (const name of [
      'normalizeInterventionName',
      'planImport',
      'cardFingerprint',
      'transitionCard',
      'parseDjiSrt',
      'toGpx',
      'buildManifest',
      'formatBytes',
      'CoreError',
    ]) {
      expect(typeof (core as Record<string, unknown>)[name]).toBe('function');
    }
    expect(core.ROOT_FOLDER).toBe('ESAM');
  });
});
