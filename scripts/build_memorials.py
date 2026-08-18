#!/usr/bin/env python3
"""Build data/memorials.geojson — monuments, sculptures and memorial plaques.

Two sources, merged because neither is complete on its own:
  * OSM (Overpass, historic=memorial/monument + tourism=artwork) — has the
    Lenin statue, Вечный огонь, Бажов, Васильев, Щёлкин, which 2GIS lacks;
  * the manual 2GIS export (categories «Памятники и скульптуры» /
    «Памятные доски») — has воинов-пограничников, воинов-интернационалистов,
    «Спираль вечности», «Спящий медведь» and most of the plaques, which OSM
    lacks. These are excluded from data/poi.geojson (see convert_2gis_poi.py)
    so a monument is not both an "organization" and a memorial.

Usage:
    python3 scripts/build_memorials.py            # fetch from Overpass
    python3 scripts/build_memorials.py --osm-cache /tmp/overpass.json

NB: HTTPS to overpass-api.de does not work from this environment, plain HTTP
does; area[] queries time out, so the query is bbox-scoped (see CLAUDE.md).
"""
import argparse
import json
import math
import os
import re
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GIS_SRC = os.path.join(ROOT, 'newData_140826', '02_FINAL_2gis_organizations.json')
DST = os.path.join(ROOT, 'data', 'memorials.geojson')

OVERPASS_URL = 'http://overpass-api.de/api/interpreter'
BBOX = '56.0229,60.6445,56.1211,60.8203'  # same city bbox the other layers use
QUERY = f"""[out:json][timeout:60][bbox:{BBOX}];
(
  node["historic"~"^(memorial|monument)$"];
  way["historic"~"^(memorial|monument)$"];
  node["tourism"="artwork"];
  way["tourism"="artwork"];
);
out center tags;
"""

GIS_CATEGORIES = {'Памятники и скульптуры', 'Памятные доски'}

# Words that say "this is a monument" rather than what it commemorates —
# ignored when matching an OSM name against a 2GIS one.
GENERIC_WORDS = {
    'памятник', 'памятная', 'памятные', 'мемориальная', 'мемориальные',
    'мемориал', 'доска', 'доски', 'скульптура', 'стела', 'стелла', 'бюст',
    'герою', 'героям', 'лауреату', 'первому', 'бывшему', 'почетному',
    'социалистического', 'государственной', 'ленинской', 'сталинской',
    'премий', 'премии', 'труда', 'города', 'снежинска',
}
MERGE_DIST_M = 150


def fetch_osm(retries=8):
    """Overpass regularly answers 'server too busy' here — just keep asking."""
    for attempt in range(1, retries + 1):
        # Overpass answers a bare urllib request with 408 far more often than
        # it answers curl — send a real User-Agent like curl does.
        req = urllib.request.Request(
            OVERPASS_URL, data=QUERY.encode('utf-8'),
            headers={'User-Agent': 'map-offline/1.0 (snezhinsk offline map)'})
        try:
            body = urllib.request.urlopen(req, timeout=120).read()
        except Exception as e:  # noqa: BLE001 — network flakiness is expected
            print(f'  attempt {attempt}: {e}')
            time.sleep(5)
            continue
        if body.lstrip().startswith(b'{'):
            return json.loads(body)
        print(f'  attempt {attempt}: overpass busy')
        time.sleep(5)
    raise SystemExit('Overpass did not answer with JSON, try again later')


def norm(s):
    s = s.lower().replace('ё', 'е')
    return re.sub(r'[^а-яa-z0-9 ]+', ' ', s)


def tokens(name):
    return {w for w in norm(name).split() if len(w) >= 4 and w not in GENERIC_WORDS}


def dist_m(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[1] - b[1]) * 111320, (a[0] - b[0]) * 111320 * math.cos(lat))


def kind_of(name, osm_tags=None, gis_category=None):
    tags = osm_tags or {}
    if tags.get('memorial') == 'plaque' or gis_category == 'Памятные доски':
        return 'plaque'
    if re.match(r'^(мемориальн\w+|памятн\w+)\s+(доска|табличка|доски)', norm(name)):
        return 'plaque'
    return 'monument'


def osm_records(data):
    out = []
    for e in data['elements']:
        t = e.get('tags', {})
        # Re-check the tags instead of trusting the input: with --osm-cache the
        # dump may be a broader query (the city is full of historic=boundary_stone
        # "кварт.ст." forest markers, which are not memorials).
        if t.get('historic') not in ('memorial', 'monument') and t.get('tourism') != 'artwork':
            continue
        if t.get('building'):  # a building tagged historic=* is not a monument
            continue
        name = t.get('name', '').strip()
        if not name:
            continue  # nothing to show on the map or find in search
        lon = e.get('lon') or (e.get('center') or {}).get('lon')
        lat = e.get('lat') or (e.get('center') or {}).get('lat')
        if lon is None or lat is None:
            continue
        out.append({
            'id': f"osm_{e['type']}_{e['id']}",
            'name': name,
            'kind': kind_of(name, osm_tags=t),
            'artist': t.get('artist_name', ''),
            'inscription': t.get('inscription', ''),
            'description': t.get('description', ''),
            'street': '', 'housenumber': '',
            'sources': ['OSM'],
            'coords': [round(lon, 7), round(lat, 7)],
        })
    return out


def gis_records():
    with open(GIS_SRC, encoding='utf-8') as f:
        orgs = json.load(f)['organizations']
    out = []
    for o in orgs:
        if o.get('category') not in GIS_CATEGORIES:
            continue
        c = o.get('coordinates')
        if not c:
            continue
        name = (o.get('name') or '').strip()
        if not name:
            continue
        details = o.get('address_details') or {}
        street = housenumber = ''
        for comp in details.get('components', []):
            if comp.get('type') == 'street_number' and comp.get('street'):
                street, housenumber = comp['street'], comp.get('number', '')
                break
        out.append({
            'id': f"2gis_{o.get('source_id') or name}",
            'name': name,
            'kind': kind_of(name, gis_category=o.get('category')),
            'artist': '', 'inscription': '',
            'description': (o.get('description') or '').strip(),
            'street': street, 'housenumber': housenumber,
            'sources': ['2GIS'],
            'coords': [round(c[0], 7), round(c[1], 7)],
        })
    return out


def merge(osm, gis):
    """Same object in both sources -> one feature keeping the richer fields."""
    merged = list(gis)
    for o in osm:
        hit = None
        for g in merged:
            if dist_m(o['coords'], g['coords']) > MERGE_DIST_M:
                continue
            n1, n2 = norm(o['name']), norm(g['name'])
            if tokens(o['name']) & tokens(g['name']) or n1 in n2 or n2 in n1:
                hit = g
                break
        if hit is None:
            merged.append(o)
            continue
        # 2GIS names are spelled out ("Памятник Петру Ильичу Чайковскому"),
        # OSM ones abbreviated ("П. И. Чайковскому") — keep the fuller one,
        # and take the extras (artist/inscription) OSM has and 2GIS never does.
        if len(o['name']) > len(hit['name']):
            hit['name'] = o['name']
        for field in ('artist', 'inscription', 'description'):
            if not hit[field]:
                hit[field] = o[field]
        hit['sources'].append('OSM')
        hit['id'] += '+' + o['id']
    return merged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--osm-cache', help='raw Overpass JSON to use instead of fetching')
    args = ap.parse_args()

    if args.osm_cache:
        with open(args.osm_cache, encoding='utf-8') as f:
            osm_data = json.load(f)
    else:
        print('Fetching memorials from Overpass…')
        osm_data = fetch_osm()

    osm = osm_records(osm_data)
    gis = gis_records()
    records = merge(osm, gis)
    records.sort(key=lambda r: (r['kind'] != 'monument', r['name']))

    features = []
    for r in records:
        props = {k: v for k, v in r.items() if k != 'coords'}
        props['source'] = ', '.join(dict.fromkeys(props.pop('sources')))
        features.append({
            'type': 'Feature',
            'properties': props,
            'geometry': {'type': 'Point', 'coordinates': r['coords']},
        })

    with open(DST, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': features}, f,
                  ensure_ascii=False, indent=1)
        f.write('\n')

    monuments = sum(1 for r in records if r['kind'] == 'monument')
    both = sum(1 for r in records if len(r['sources']) > 1)
    print(f'{DST}: {len(features)} memorials '
          f'({monuments} monuments, {len(features) - monuments} plaques; '
          f'OSM {len(osm)}, 2GIS {len(gis)}, matched in both {both})')


if __name__ == '__main__':
    main()
