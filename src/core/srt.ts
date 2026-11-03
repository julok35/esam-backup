/*
 * Conversion des sous-titres DJI (M30T et variantes) en traces GPX et KML (lot 7).
 *
 * Format supposé (M30T, firmwares récents), un bloc par image vidéo (30 par seconde) :
 *
 *   1
 *   00:00:00,000 --> 00:00:00,033
 *   <font size="28">FrameCnt: 1, DiffTime: 33ms
 *   2026-10-18 14:03:21.123
 *   [iso: 100] [shutter: 1/1000.0] [fnum: 2.8] [ev: 0] [color_md: default]
 *   [focal_len: 24.00] [latitude: 45.456789] [longitude: 5.912345]
 *   [rel_alt: 120.500 abs_alt: 1456.300] [ct: 5500] </font>
 *
 * Hypothèses et tolérances :
 * - blocs séparés par une ligne vide ; le numéro de bloc est ignoré ; la ligne
 *   d'horodatage `HH:MM:SS,mmm --> HH:MM:SS,mmm` est obligatoire (sinon le bloc
 *   est ignoré) ; fins de ligne CRLF et marque d'ordre des octets acceptées ;
 * - balises HTML (`<font>`) retirées ; `SrtCnt : 1` accepté à la place de `FrameCnt` ;
 * - champs entre crochets `[clé: valeur]`, plusieurs paires possibles dans un même
 *   crochet (`[rel_alt: 120.500 abs_alt: 1456.300]`), espaces libres autour du « : » ;
 * - coordonnées : `latitude`/`lat`, `longitude`/`longtitude` (faute présente sur
 *   certains firmwares)/`lon`/`lng` ; anciens firmwares : `GPS(lon,lat,alt)` ou
 *   `GPS (lon, lat, alt)` (longitude en premier), avec `BAROMETER:45.6` pour la
 *   hauteur relative ;
 * - altitudes : `abs_alt` (absolue, utilisée dans le GPX), `rel_alt` (relative au
 *   décollage), `altitude` seule considérée comme relative (Mavic Air, Mini : non
 *   vérifié sur appareil) ;
 * - date absolue `AAAA-MM-JJ HH:MM:SS.mmm` (aussi `AAAA.MM.JJ`, `/`, virgule) :
 *   heure LOCALE de l'appareil, sans fuseau. Interprétée dans le fuseau du
 *   téléphone (option `utcOffsetMinutes` pour fixer le décalage). Sans date
 *   absolue, l'option `startTime` plus le décalage du bloc dans la vidéo est
 *   utilisée ; sans les deux, le point est écarté ;
 * - points sans coordonnées valides, ou à 0,0 (GPS pas encore accroché au
 *   décollage), écartés ; fichier tronqué : le dernier bloc incomplet est écarté.
 */

export interface TrackPoint {
  time: Date;
  lat: number;
  lon: number;
  /** Altitude absolue en mètres, si connue. */
  altAbs?: number;
  /** Hauteur relative au point de décollage en mètres, si connue. */
  altRel?: number;
  /** Autres champs lus (iso, shutter, fnum, ct, frameCnt, offsetMs...). */
  extra: Record<string, string | number>;
}

export interface SrtParseOptions {
  /** Décalage de l'heure de l'appareil par rapport à UTC, en minutes (120 pour l'heure d'été française). Par défaut : fuseau du téléphone. */
  utcOffsetMinutes?: number;
  /** Instant du début de la vidéo, pour les fichiers sans date absolue. */
  startTime?: Date;
}

export interface SrtParseReport {
  points: TrackPoint[];
  /** Blocs avec horodatage trouvés. */
  blocks: number;
  /** Blocs écartés (sans coordonnées valides, à 0,0, ou sans date). */
  rejected: number;
}

const TIMING = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const ABS_DATE = /(\d{4})[-./](\d{2})[-./](\d{2})[ T]+(\d{1,2}):(\d{2}):(\d{2})(?:[.,:](\d{1,6}))?/;
const NUMBER = /^[-+]?\d+(?:\.\d+)?$/;
const GPS_TUPLE = /GPS\s*\(\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*(?:,\s*([-+]?\d+(?:\.\d+)?)\s*M?\s*)?\)/i;
const HOME_TUPLE = /HOME\s*\(\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)/i;
const BAROMETER = /BAROMETER\s*:\s*([-+]?\d+(?:\.\d+)?)/i;
const FRAME_COUNT = /(?:FrameCnt|SrtCnt)\s*:\s*(\d+)/i;
const DIFF_TIME = /DiffTime\s*:\s*(\d+(?:\.\d+)?)\s*ms/i;

function timingToMs(h: string, m: string, s: string, ms: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, '0'));
}

function parseAbsoluteDate(text: string, options: SrtParseOptions): Date | null {
  const match = ABS_DATE.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac] = match;
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms] as const;
  let date: Date;
  if (options.utcOffsetMinutes !== undefined) {
    date = new Date(Date.UTC(...parts) - options.utcOffsetMinutes * 60_000);
  } else {
    date = new Date(...parts);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

function toValue(raw: string): string | number {
  return NUMBER.test(raw) ? Number(raw) : raw;
}

/** Paires clé-valeur de tous les crochets : `[a: 1] [b: 2 c: 3]`. */
function readBracketFields(text: string): Map<string, string | number> {
  const fields = new Map<string, string | number>();
  for (const bracket of text.matchAll(/\[([^\]]*)\]/g)) {
    const inner = bracket[1] ?? '';
    for (const pair of inner.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^\s\],]+)/g)) {
      const key = (pair[1] ?? '').toLowerCase();
      const value = pair[2] ?? '';
      if (key !== '' && value !== '') fields.set(key, toValue(value));
    }
  }
  return fields;
}

function takeNumber(fields: Map<string, string | number>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = fields.get(key);
    if (typeof value === 'number' && Number.isFinite(value)) {
      fields.delete(key);
      return value;
    }
  }
  return undefined;
}

export function isValidCoordinate(lat: number | undefined, lon: number | undefined): boolean {
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6);
}

/** Lit un SRT DJI et rend aussi le nombre de blocs lus et écartés. */
export function parseDjiSrtWithReport(text: string, options: SrtParseOptions = {}): SrtParseReport {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const points: TrackPoint[] = [];
  let blocks = 0;
  let rejected = 0;
  for (const chunk of normalized.split(/\n[ \t]*\n/)) {
    const timing = TIMING.exec(chunk);
    if (!timing) continue;
    blocks += 1;
    const [, h1, m1, s1, ms1, h2, m2, s2, ms2] = timing as unknown as [string, string, string, string, string, string, string, string, string];
    const offsetMs = timingToMs(h1, m1, s1, ms1);
    const endMs = timingToMs(h2, m2, s2, ms2);
    const content = chunk.slice(timing.index + timing[0].length).replace(/<[^>]*>/g, ' ');

    const fields = readBracketFields(content);
    let lat = takeNumber(fields, 'latitude', 'lat');
    let lon = takeNumber(fields, 'longitude', 'longtitude', 'lon', 'lng');
    let altAbs = takeNumber(fields, 'abs_alt');
    let altRel = takeNumber(fields, 'rel_alt', 'altitude');

    const extra: Record<string, string | number> = { offsetMs, durationMs: endMs - offsetMs };
    const gps = GPS_TUPLE.exec(content);
    if (gps && (lat === undefined || lon === undefined)) {
      lon = Number(gps[1]);
      lat = Number(gps[2]);
      if (gps[3] !== undefined && altAbs === undefined) altAbs = Number(gps[3]);
    }
    const barometer = BAROMETER.exec(content);
    if (barometer && altRel === undefined) altRel = Number(barometer[1]);
    const home = HOME_TUPLE.exec(content);
    if (home) {
      extra.homeLon = Number(home[1]);
      extra.homeLat = Number(home[2]);
    }
    const frame = FRAME_COUNT.exec(content);
    if (frame) extra.frameCnt = Number(frame[1]);
    const diff = DIFF_TIME.exec(content);
    if (diff) extra.diffTimeMs = Number(diff[1]);
    for (const [key, value] of fields) extra[key] = value;

    let time = parseAbsoluteDate(content, options);
    if (!time && options.startTime) time = new Date(options.startTime.getTime() + offsetMs);

    if (!time || !isValidCoordinate(lat, lon)) {
      rejected += 1;
      continue;
    }
    const point: TrackPoint = { time, lat: lat as number, lon: lon as number, extra };
    if (altAbs !== undefined && Number.isFinite(altAbs)) point.altAbs = altAbs;
    if (altRel !== undefined && Number.isFinite(altRel)) point.altRel = altRel;
    points.push(point);
  }
  return { points, blocks, rejected };
}

/** Points GPS valides d'un SRT DJI, dans l'ordre du fichier. */
export function parseDjiSrt(text: string, options: SrtParseOptions = {}): TrackPoint[] {
  return parseDjiSrtWithReport(text, options).points;
}

export interface ExportOptions {
  /** Nom de la trace (nom du fichier vidéo, par exemple). */
  name: string;
  /** Ne garder qu'un point par intervalle : true pour un par seconde, ou un intervalle en ms. */
  thinning?: boolean | number;
}

/** Garde le premier point de chaque intervalle (1 s par défaut). L'ordre est conservé. */
export function thinPoints(points: readonly TrackPoint[], intervalMs = 1000): TrackPoint[] {
  const kept: TrackPoint[] = [];
  let lastSlot: number | null = null;
  for (const point of points) {
    const slot = Math.floor(point.time.getTime() / intervalMs);
    if (slot === lastSlot) continue;
    lastSlot = slot;
    kept.push(point);
  }
  return kept;
}

function applyThinning(points: readonly TrackPoint[], thinning: ExportOptions['thinning']): readonly TrackPoint[] {
  if (thinning === undefined || thinning === false) return points;
  return thinPoints(points, thinning === true ? 1000 : thinning);
}

/** Échappe le texte pour XML (contenu et attributs). Retire les caractères de contrôle interdits. */
export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function coord(value: number): string {
  return String(Number(value.toFixed(7)));
}

function alt(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Trace GPX 1.1 : un trk, un trkseg, des trkpt horodatés en UTC, altitude absolue si connue. */
export function toGpx(points: readonly TrackPoint[], options: ExportOptions): string {
  const list = applyThinning(points, options.thinning);
  const name = escapeXml(options.name);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="ESAM Sauvegarde" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${name}</name>${list[0] ? `<time>${list[0].time.toISOString()}</time>` : ''}</metadata>`,
    '  <trk>',
    `    <name>${name}</name>`,
    '    <trkseg>',
  ];
  for (const p of list) {
    const ele = p.altAbs !== undefined ? `<ele>${alt(p.altAbs)}</ele>` : '';
    lines.push(`      <trkpt lat="${coord(p.lat)}" lon="${coord(p.lon)}">${ele}<time>${p.time.toISOString()}</time></trkpt>`);
  }
  lines.push('    </trkseg>', '  </trk>', '</gpx>', '');
  return lines.join('\n');
}

/**
 * Trace KML 2.2 : une LineString (altitude absolue si tous les points l'ont, sinon
 * collée au sol) et l'intervalle de temps du vol (TimeSpan, UTC).
 */
export function toKml(points: readonly TrackPoint[], options: ExportOptions): string {
  const list = applyThinning(points, options.thinning);
  const name = escapeXml(options.name);
  const allAbs = list.length > 0 && list.every((p) => p.altAbs !== undefined);
  const coordinates = list.map((p) => (allAbs ? `${coord(p.lon)},${coord(p.lat)},${alt(p.altAbs as number)}` : `${coord(p.lon)},${coord(p.lat)}`));
  const first = list[0];
  const last = list[list.length - 1];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${name}</name>`,
    '    <Placemark>',
    `      <name>${name}</name>`,
  ];
  if (first && last) {
    lines.push(`      <TimeSpan><begin>${first.time.toISOString()}</begin><end>${last.time.toISOString()}</end></TimeSpan>`);
  }
  lines.push(
    '      <LineString>',
    `        <altitudeMode>${allAbs ? 'absolute' : 'clampToGround'}</altitudeMode>`,
    `        <coordinates>${coordinates.join(' ')}</coordinates>`,
    '      </LineString>',
    '    </Placemark>',
    '  </Document>',
    '</kml>',
    '',
  );
  return lines.join('\n');
}

/** Rayon moyen de la Terre (m). */
const EARTH_RADIUS_M = 6_371_008.8;

/** Distance haversine entre deux points, en mètres. */
export function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface TrackSummary {
  points: number;
  start: Date | null;
  end: Date | null;
  durationMs: number;
  distanceM: number;
  altAbsMin: number | null;
  altAbsMax: number | null;
  altRelMin: number | null;
  altRelMax: number | null;
}

/** Minimum et maximum sans décomposition en arguments (un vol long dépasse 50 000 points). */
function minMax(values: readonly number[]): [number | null, number | null] {
  let min: number | null = null;
  let max: number | null = null;
  for (const v of values) {
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return [min, max];
}

/** Résumé d'une trace : durée, distance parcourue, altitudes extrêmes, nombre de points. */
export function trackSummary(points: readonly TrackPoint[]): TrackSummary {
  let distanceM = 0;
  for (let i = 1; i < points.length; i += 1) distanceM += haversineMeters(points[i - 1] as TrackPoint, points[i] as TrackPoint);
  const [start, end] = minMax(points.map((p) => p.time.getTime()));
  const [altAbsMin, altAbsMax] = minMax(points.flatMap((p) => (p.altAbs === undefined ? [] : [p.altAbs])));
  const [altRelMin, altRelMax] = minMax(points.flatMap((p) => (p.altRel === undefined ? [] : [p.altRel])));
  return {
    points: points.length,
    start: start === null ? null : new Date(start),
    end: end === null ? null : new Date(end),
    durationMs: start === null || end === null ? 0 : end - start,
    distanceM,
    altAbsMin,
    altAbsMax,
    altRelMin,
    altRelMax,
  };
}
