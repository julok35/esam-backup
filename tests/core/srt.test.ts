import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  escapeXml,
  haversineMeters,
  isValidCoordinate,
  parseDjiSrt,
  parseDjiSrtWithReport,
  thinPoints,
  toGpx,
  toKml,
  type TrackPoint,
  trackSummary,
} from '../../src/core/srt';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
/** Heure d'été française le 18 octobre 2026 : UTC+2. */
const CEST = 120;

/**
 * Vérifie qu'un XML est bien formé (balises équilibrées, entités connues), sans
 * analyseur XML disponible sous Node.
 */
function expectWellFormedXml(xml: string): void {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
  const body = xml.replace(/^<\?xml[^>]*\?>/, '');
  const stack: string[] = [];
  for (const match of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attributes, selfClosing] = match;
    expect(attributes).not.toMatch(/[<]/);
    if (selfClosing) continue;
    if (closing) expect(stack.pop()).toBe(tag);
    else stack.push(tag as string);
  }
  expect(stack).toEqual([]);
  const text = body.replace(/<[^>]*>/g, '');
  expect(text).not.toMatch(/[<>]/);
  for (const entity of text.matchAll(/&[^;\s]*;?/g)) expect(entity[0]).toMatch(/^&(amp|lt|gt|quot|apos);$/);
}

describe('parseDjiSrt : M30T', () => {
  const text = fixture('m30t-wide.srt');

  it('lit les points et écarte ceux à 0,0 (GPS pas encore accroché)', () => {
    const report = parseDjiSrtWithReport(text, { utcOffsetMinutes: CEST });
    expect(report.blocks).toBe(90);
    expect(report.rejected).toBe(3);
    expect(report.points).toHaveLength(87);
  });

  it('lit coordonnées, altitudes, date et champs annexes', () => {
    const [first] = parseDjiSrt(text, { utcOffsetMinutes: CEST });
    expect(first).toBeDefined();
    const p = first as TrackPoint;
    expect(p.time.toISOString()).toBe('2026-10-18T12:03:21.100Z');
    expect(p.lat).toBeCloseTo(45.456794, 6);
    expect(p.lon).toBeCloseTo(5.912348, 6);
    expect(p.altAbs).toBeCloseTo(1456.45, 3);
    expect(p.altRel).toBeCloseTo(120.65, 3);
    expect(p.extra).toMatchObject({ iso: 100, shutter: '1/1000.0', fnum: 2.8, ev: 0, color_md: 'default', focal_len: 24, ct: 5500, frameCnt: 4, diffTimeMs: 33, offsetMs: 100 });
    expect(p.extra).not.toHaveProperty('latitude');
  });

  it('sans décalage fourni : heure locale du téléphone', () => {
    const [first] = parseDjiSrt(text);
    expect(first?.time.getTime()).toBe(new Date(2026, 9, 18, 14, 3, 21, 100).getTime());
  });

  it('fichier tronqué : le bloc incomplet est écarté', () => {
    const report = parseDjiSrtWithReport(fixture('m30t-truncated.srt'), { utcOffsetMinutes: CEST });
    expect(report).toMatchObject({ blocks: 10, rejected: 1 });
    expect(report.points).toHaveLength(9);
  });

  it('coupé en plein milieu, n’importe où : jamais d’exception', () => {
    for (let cut = 0; cut < 2_000; cut += 37) {
      expect(() => parseDjiSrt(text.slice(0, cut))).not.toThrow();
    }
  });
});

describe('parseDjiSrt : variantes', () => {
  it('anciens firmwares : HOME(...) et GPS(lon,lat,alt), BAROMETER', () => {
    const points = parseDjiSrt(fixture('dji-old-gps.srt'), { utcOffsetMinutes: CEST });
    expect(points).toHaveLength(6);
    expect(points[0]).toMatchObject({ lat: 45.456789, lon: 5.912345, altAbs: 1456.3, altRel: 120.5 });
    expect(points[0]?.extra).toMatchObject({ homeLat: 45.45, homeLon: 5.91 });
    expect(points[0]?.time.toISOString()).toBe('2026-10-18T12:11:51.000Z');
    // « GPS (...) » avec une espace.
    expect(points[1]).toMatchObject({ lat: 45.456889, lon: 5.912445, altAbs: 1457.3 });
  });

  it('CRLF, marque d’ordre, SrtCnt, espaces autour des « : », « longtitude », « altitude »', () => {
    const report = parseDjiSrtWithReport(fixture('dji-variant-crlf.srt'), { utcOffsetMinutes: CEST });
    expect(report).toMatchObject({ blocks: 4, rejected: 1 });
    const [first, second] = report.points;
    expect(first).toMatchObject({ lat: 45.3, lon: 5.8, altRel: 50.3 });
    expect(first?.altAbs).toBeUndefined();
    expect(first?.extra).toMatchObject({ frameCnt: 1, iso: 110 });
    expect(second?.time.toISOString()).toBe('2026-10-18T07:15:02.033Z');
  });

  it('sans date absolue : startTime plus le décalage du bloc, sinon écarté', () => {
    const text = '1\n00:00:02,500 --> 00:00:02,533\n[latitude: 45.1] [longitude: 5.7]\n';
    expect(parseDjiSrt(text)).toEqual([]);
    const [p] = parseDjiSrt(text, { startTime: new Date('2026-10-18T12:00:00.000Z') });
    expect(p?.time.toISOString()).toBe('2026-10-18T12:00:02.500Z');
  });

  it.each([
    ['vide', ''],
    ['texte quelconque', 'bonjour\n\nau revoir'],
    ['latitude hors limites', '1\n00:00:00,000 --> 00:00:00,033\n2026-10-18 14:00:00.000 [latitude: 95.0] [longitude: 5.7]'],
    ['longitude hors limites', '1\n00:00:00,000 --> 00:00:00,033\n2026-10-18 14:00:00.000 [latitude: 45.0] [longitude: 185]'],
    ['coordonnées non numériques', '1\n00:00:00,000 --> 00:00:00,033\n2026-10-18 14:00:00.000 [latitude: N/A] [longitude: -]'],
    ['sans horodatage de bloc', '2026-10-18 14:00:00.000 [latitude: 45.0] [longitude: 5.7]'],
  ])('entrée sale (%s) : aucun point', (_label, text) => {
    expect(parseDjiSrt(text)).toEqual([]);
  });

  it('isValidCoordinate', () => {
    expect(isValidCoordinate(0, 0)).toBe(false);
    expect(isValidCoordinate(0, 5)).toBe(true);
    expect(isValidCoordinate(undefined, 5)).toBe(false);
    expect(isValidCoordinate(-90, -180)).toBe(true);
    expect(isValidCoordinate(Number.NaN, 5)).toBe(false);
  });
});

describe('export GPX et KML', () => {
  const points = parseDjiSrt(fixture('m30t-wide.srt'), { utcOffsetMinutes: CEST });

  it('GPX : trk, trkseg, trkpt horodatés UTC, altitude absolue', () => {
    const gpx = toGpx(points, { name: 'DJI_20261018140321_0001_W' });
    expectWellFormedXml(gpx);
    expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
    expect(gpx.match(/<trkpt /g)).toHaveLength(87);
    expect(gpx).toContain('<trkpt lat="45.456794" lon="5.912348"><ele>1456.45</ele><time>2026-10-18T12:03:21.100Z</time></trkpt>');
    expect(gpx.match(/<trk>/g)).toHaveLength(1);
    expect(gpx.match(/<trkseg>/g)).toHaveLength(1);
  });

  it('GPX : un point par seconde avec thinning', () => {
    const gpx = toGpx(points, { name: 'vol', thinning: true });
    expect(gpx.match(/<trkpt /g)).toHaveLength(3);
    expect(toGpx(points, { name: 'vol', thinning: 500 }).match(/<trkpt /g)).toHaveLength(6);
  });

  it('GPX : sans altitude absolue, pas de <ele>', () => {
    const relOnly = parseDjiSrt(fixture('dji-variant-crlf.srt'), { utcOffsetMinutes: CEST });
    const gpx = toGpx(relOnly, { name: 'x' });
    expect(gpx).not.toContain('<ele>');
    expectWellFormedXml(gpx);
  });

  it('échappe le nom', () => {
    const name = 'Dolly & Max <"Mont Granier"> l\'été\u0001';
    const gpx = toGpx(points.slice(0, 2), { name });
    const kml = toKml(points.slice(0, 2), { name });
    expectWellFormedXml(gpx);
    expectWellFormedXml(kml);
    expect(gpx).toContain('<name>Dolly &amp; Max &lt;&quot;Mont Granier&quot;&gt; l&apos;été</name>');
    expect(escapeXml('a&b')).toBe('a&amp;b');
  });

  it('trace vide : XML valide quand même', () => {
    expectWellFormedXml(toGpx([], { name: 'vide' }));
    expectWellFormedXml(toKml([], { name: 'vide' }));
    expect(toKml([], { name: 'vide' })).not.toContain('<TimeSpan>');
  });

  it('KML : LineString absolue, intervalle de temps UTC', () => {
    const kml = toKml(points, { name: 'vol', thinning: true });
    expectWellFormedXml(kml);
    expect(kml).toContain('xmlns="http://www.opengis.net/kml/2.2"');
    expect(kml).toContain('<altitudeMode>absolute</altitudeMode>');
    expect(kml).toContain('<TimeSpan><begin>2026-10-18T12:03:21.100Z</begin><end>2026-10-18T12:03:23.000Z</end></TimeSpan>');
    expect(kml).toMatch(/<coordinates>5\.912348,45\.456794,1456\.45 \S+ \S+<\/coordinates>/);
    const relOnly = parseDjiSrt(fixture('dji-variant-crlf.srt'), { utcOffsetMinutes: CEST });
    expect(toKml(relOnly, { name: 'x' })).toContain('<altitudeMode>clampToGround</altitudeMode>');
  });

  it('thinPoints garde le premier point de chaque seconde, dans l’ordre', () => {
    const thinned = thinPoints(points);
    expect(thinned.map((p) => p.time.toISOString())).toEqual(['2026-10-18T12:03:21.100Z', '2026-10-18T12:03:22.000Z', '2026-10-18T12:03:23.000Z']);
    expect(thinPoints([])).toEqual([]);
  });
});

describe('trackSummary', () => {
  it('résume la trace du M30T', () => {
    const summary = trackSummary(parseDjiSrt(fixture('m30t-wide.srt'), { utcOffsetMinutes: CEST }));
    expect(summary.points).toBe(87);
    expect(summary.start?.toISOString()).toBe('2026-10-18T12:03:21.100Z');
    expect(summary.end?.toISOString()).toBe('2026-10-18T12:03:23.967Z');
    expect(summary.durationMs).toBe(2_867);
    expect(summary.distanceM).toBeGreaterThan(15);
    expect(summary.distanceM).toBeLessThan(17);
    expect(summary.altAbsMin).toBeCloseTo(1456.45, 3);
    expect(summary.altAbsMax).toBeCloseTo(1460.75, 3);
    expect(summary.altRelMin).toBeCloseTo(120.65, 3);
    expect(summary.altRelMax).toBeCloseTo(124.95, 3);
  });

  it('trace vide', () => {
    expect(trackSummary([])).toEqual({
      points: 0,
      start: null,
      end: null,
      durationMs: 0,
      distanceM: 0,
      altAbsMin: null,
      altAbsMax: null,
      altRelMin: null,
      altRelMax: null,
    });
  });

  it('haversine : un degré de latitude fait environ 111,2 km', () => {
    expect(haversineMeters({ lat: 45, lon: 5 }, { lat: 46, lon: 5 })).toBeCloseTo(111_195, -1);
    expect(haversineMeters({ lat: 45, lon: 5 }, { lat: 45, lon: 5 })).toBe(0);
  });

  it('supporte une longue trace sans débordement de pile', () => {
    const base = Date.UTC(2026, 9, 18, 12);
    const long: TrackPoint[] = Array.from({ length: 200_000 }, (_, i) => ({ time: new Date(base + i * 33), lat: 45, lon: 5 + i * 1e-7, altAbs: 1000 + (i % 7), extra: {} }));
    const summary = trackSummary(long);
    expect(summary.altAbsMax).toBe(1006);
    expect(summary.points).toBe(200_000);
  });
});
