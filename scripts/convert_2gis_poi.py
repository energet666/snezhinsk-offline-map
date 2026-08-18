#!/usr/bin/env python3
"""Regenerate data/poi.geojson from newData_140826/02_FINAL_2gis_organizations.json.

Run this whenever the 2GIS export is refreshed. See CLAUDE.md for why
organizations come from this file instead of OSM.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'newData_140826', '02_FINAL_2gis_organizations.json')
DST = os.path.join(ROOT, 'data', 'poi.geojson')

PHONE_RE = re.compile(r'^[+8][\d\s\-‒–—()]{6,}$')
DAY_MAP = [
    ('Mon', 'Пн'), ('Tue', 'Вт'), ('Wed', 'Ср'), ('Thu', 'Чт'),
    ('Fri', 'Пт'), ('Sat', 'Сб'), ('Sun', 'Вс'),
]
SOCIAL_DOMAINS = ('vk.com', 'ok.ru', 't.me', 'wa.me', 'instagram.', 'facebook.', 'telegram.')

# Monuments/plaques are not organizations: listing them here would put a
# memorial plaque into the org list of the building it hangs on. They go to
# data/memorials.geojson (their own map layer) via scripts/build_memorials.py.
MEMORIAL_CATEGORIES = {'Памятники и скульптуры', 'Памятные доски'}


def split_phones(phones):
    tel, web = [], []
    for p in phones:
        p = p.strip()
        if not p:
            continue
        (tel if PHONE_RE.match(p) else web).append(p)
    return tel, web


def pick_website(web_candidates):
    if not web_candidates:
        return ''
    # Prefer a bare/own domain over a social-network profile link.
    own = [w for w in web_candidates if not any(s in w for s in SOCIAL_DOMAINS)]
    chosen = own[0] if own else web_candidates[0]
    return chosen if chosen.startswith('http') else 'https://' + chosen


def translate_hours(h):
    if not h:
        return ''
    for en, ru in DAY_MAP:
        h = h.replace(en, ru)
    return h.replace('closed', 'выходной')


def street_housenumber(o):
    details = o.get('address_details') or {}
    for c in details.get('components', []):
        if c.get('type') == 'street_number' and c.get('street'):
            return c['street'], c.get('number', '')
    addr = (o.get('address') or '').strip()
    if ',' in addr:
        street, _, num = addr.rpartition(',')
        return street.strip(), num.strip()
    return '', ''


def main():
    data = json.load(open(SRC, encoding='utf-8'))
    orgs = data['organizations']

    features = []
    skipped = 0
    memorials = 0
    for o in orgs:
        if o.get('category') in MEMORIAL_CATEGORIES:
            memorials += 1
            continue
        if not o.get('coordinates'):
            skipped += 1
            continue
        tel, web = split_phones(o.get('phones') or [])
        street, housenumber = street_housenumber(o)
        lon, lat = o['coordinates']
        props = {
            'id': '2gis_' + str(o['source_id']),
            'name': o.get('name') or '',
            'category': o.get('category') or '',
            'street': street,
            'housenumber': housenumber,
            'phone': '; '.join(tel),
            'opening_hours': translate_hours(o.get('working_hours') or ''),
            'website': pick_website(web),
            'source': '2GIS',
        }
        features.append({
            'type': 'Feature',
            'properties': props,
            'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
        })

    out = {'type': 'FeatureCollection', 'features': features}
    with open(DST, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'wrote {len(features)} features to {DST} '
          f'(skipped {skipped} without coordinates, {memorials} memorials -> memorials.geojson)')


if __name__ == '__main__':
    main()
