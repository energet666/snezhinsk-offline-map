#!/usr/bin/env python3
"""Докачивает недостающие спутниковые тайлы Esri в tiles/{z}/{x}/{y}.png.

Области берутся из scripts/fetch_osm_area.py (AREAS), так что покрытие
фотоподложки и векторных данных задаётся одним списком bbox'ов.

    python3 scripts/fetch_tiles.py --areas vozdvizhenka,znamenka
    python3 scripts/fetch_tiles.py --areas all --zooms 12-17

Уже скачанные тайлы пропускаются, так что скрипт можно перезапускать.
HTTPS до arcgisonline из этого окружения не проходит — только plain HTTP
(та же история, что с Overpass, см. CLAUDE.md).
"""

import argparse
import math
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_osm_area import AREAS, NEW_AREAS, USER_AGENT  # noqa: E402

TILES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tiles')
# Esri World Imagery: обратите внимание на порядок {z}/{y}/{x} в URL — на
# диске тайлы лежат в привычном для Leaflet {z}/{x}/{y}.
TILE_URL = 'http://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/%d/%d/%d'


def deg2tile(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    rad = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(rad)) / math.pi) / 2.0 * n)
    return x, y


def tiles_for(bbox, z):
    south, west, north, east = bbox
    x0, y0 = deg2tile(north, west, z)
    x1, y1 = deg2tile(south, east, z)
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            yield x, y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--areas', default=','.join(NEW_AREAS))
    ap.add_argument('--zooms', default='12-17')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    areas = list(AREAS) if args.areas == 'all' else args.areas.split(',')
    lo, hi = (int(v) for v in args.zooms.split('-'))

    wanted = set()
    for area in areas:
        if area not in AREAS:
            sys.exit('неизвестная область: %s' % area)
        for z in range(lo, hi + 1):
            for x, y in tiles_for(AREAS[area], z):
                wanted.add((z, x, y))

    missing = [t for t in sorted(wanted)
               if not os.path.exists(os.path.join(TILES_DIR, str(t[0]), str(t[1]), '%d.png' % t[2]))]
    print('нужно %d тайлов, отсутствует %d' % (len(wanted), len(missing)))
    if args.dry_run:
        return

    ok = failed = 0
    for i, (z, x, y) in enumerate(missing, 1):
        path = os.path.join(TILES_DIR, str(z), str(x), '%d.png' % y)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            req = urllib.request.Request(TILE_URL % (z, y, x), headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as r:
                blob = r.read()
            # Пишем через .part, чтобы оборванная закачка не оставила битый
            # png, который потом будет молча пропущен как «уже скачанный».
            with open(path + '.part', 'wb') as f:
                f.write(blob)
            os.replace(path + '.part', path)
            ok += 1
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print('  %d/%d/%d: %s' % (z, x, y, exc), file=sys.stderr)
        if i % 100 == 0:
            print('  %d/%d' % (i, len(missing)))
        time.sleep(0.05)
    print('скачано %d, ошибок %d' % (ok, failed))


if __name__ == '__main__':
    main()
