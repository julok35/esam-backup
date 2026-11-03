import { describe, expect, it } from 'vitest';
import { etaMs, formatBytes, formatDuration, formatRate, formatRateOf, GIB, MIB, percent, rateMiBps } from '../../src/test-page/format';

describe('formatage des tailles', () => {
  it('choisit l\'unité', () => {
    expect(formatBytes(0)).toBe('0 octet');
    expect(formatBytes(512)).toBe('512 octets');
    expect(formatBytes(1536)).toBe('1,5 Ko');
    expect(formatBytes(16 * MIB)).toBe('16,0 Mo');
    expect(formatBytes(GIB)).toBe('1,00 Go');
    expect(formatBytes(4 * GIB)).toBe('4,00 Go');
  });

  it('refuse les valeurs invalides', () => {
    expect(formatBytes(-1)).toBe('?');
    expect(formatBytes(Number.NaN)).toBe('?');
  });
});

describe('formatage des durées', () => {
  it('passe des millisecondes aux heures', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_345)).toBe('12,3 s');
    expect(formatDuration(245_000)).toBe('4 min 05 s');
    expect(formatDuration(3_720_000)).toBe('1 h 02 min');
  });
});

describe('débits', () => {
  it('calcule des Mo/s (1 Mo = 1 048 576 octets)', () => {
    expect(rateMiBps(100 * MIB, 1000)).toBe(100);
    expect(rateMiBps(GIB, 4000)).toBe(256);
    expect(formatRateOf(100 * MIB, 1000)).toBe('100,0 Mo/s');
    expect(formatRate(2.5)).toBe('2,50 Mo/s');
  });

  it('renvoie null sans durée', () => {
    expect(rateMiBps(10, 0)).toBeNull();
    expect(formatRate(null)).toBe('?');
  });

  it('estime le temps restant', () => {
    expect(etaMs(50 * MIB, 100 * MIB, 50)).toBe(1000);
    expect(etaMs(100, 100, null)).toBe(0);
    expect(etaMs(0, 100, null)).toBeNull();
  });

  it('borne le pourcentage', () => {
    expect(percent(5, 10)).toBe(50);
    expect(percent(20, 10)).toBe(100);
    expect(percent(0, 0)).toBe(0);
  });
});
