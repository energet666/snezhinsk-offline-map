#!/usr/bin/env python3
"""Собирает data/*.geojson из Overpass API.

Раньше пайплайн экспорта в репозитории отсутствовал (см. CLAUDE.md: скрипт,
породивший buildings/landuse/roads, был потерян) — этот скрипт его
восстанавливает и заодно позволяет добавлять новые территории.

    python3 scripts/fetch_osm_area.py                     # все области
    python3 scripts/fetch_osm_area.py --areas vozdvizhenka
    python3 scripts/fetch_osm_area.py --areas snezhinsk --replace

По умолчанию данные *дописываются*: фича с уже существующим OSM id не
трогается. Это важно — многие фичи в data/ допатчены вручную (адреса зданий
по 2GIS, имена стадионов), и полная перезапись их потеряет. --replace нужен
только для осознанного пересбора файла с нуля.

Про Overpass из этого окружения: HTTPS не проходит, plain HTTP работает;
area-запросы часто отваливаются по таймауту — поэтому только bbox.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

# Только plain HTTP: HTTPS до Overpass из этого окружения не проходит
# (см. CLAUDE.md). Зеркала перебираются по кругу — основной инстанс регулярно
# уходит в 502/«too busy» на полчаса, и без перебора это валит всю выгрузку.
# Осторожно с региональными зеркалами: overpass.osm.ch отвечает мгновенно, но
# у него внутри только Швейцария — на запрос по Снежинску он честно вернёт
# ноль объектов, а не ошибку.
# Зеркал в списке нет намеренно: kumi.systems и private.coffee отвечают на
# plain HTTP редиректом 308 на HTTPS, который urllib для POST переиграть не
# может (тело запроса заново не отправляется), а HTTPS из этого окружения не
# проходит вовсе. overpass.osm.ch отвечает мгновенно и с HTTP 200, но внутри
# у него только Швейцария — на Снежинск он молча вернёт ноль объектов.
OVERPASS_URLS = [
    'http://overpass-api.de/api/interpreter',
]
USER_AGENT = 'map-offline/1.0 (offline city map of Snezhinsk)'
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')

# bbox = (юг, запад, север, восток).
# У посёлков это bbox их полигона place=village из OSM плюс поля ~330 м, так
# что в выборку попадает сам населённый пункт, а не окрестные садовые массивы.
AREAS = {
    # Исходный bbox города — тот же, что использовался всеми прошлыми
    # выгрузками (см. CLAUDE.md, раздел про Overpass).
    'snezhinsk':     (56.0229, 60.6445, 56.1211, 60.8203),
    # way/175311147
    'vozdvizhenka':  (56.1102, 60.7575, 56.1351, 60.8078),
    # way/49526137
    'voskresenskoe': (56.0557, 60.8008, 56.0844, 60.8495),
    # relation/15110032
    'blizhniy_beregovoy': (56.0022, 60.7744, 56.0225, 60.7988),
    # way/52003501
    'znamenka':      (56.1063, 60.8593, 56.1233, 60.9056),
    # Прямоугольник «город + все посёлки». Векторные данные отсюда не
    # выгружаются (в промежутке одни садовые массивы) — область существует
    # ради scripts/fetch_tiles.py: на малых зумах фотоподложка качается на
    # весь прямоугольник, чтобы при панорамировании от города к сёлам не
    # было дыр. На z16-17 фото есть только над самими населёнными пунктами.
    'surroundings':  (56.0022, 60.6445, 56.1351, 60.9056),
}

NEW_AREAS = ['vozdvizhenka', 'voskresenskoe', 'blizhniy_beregovoy', 'znamenka']


# ---------- Overpass ----------

def overpass(query, retries=15):
    """Отправляет запрос, повторяя при 429/504/«too busy» с ростом паузы.

    Ретраев намеренно много: с этого хоста Overpass регулярно отвечает
    «too busy», а на тяжёлых bbox'ах ещё и рвёт соединение — за пять попыток
    большой запрос не проходил.
    """
    for attempt in range(retries):
        try:
            url = OVERPASS_URLS[attempt % len(OVERPASS_URLS)]
            data = urllib.parse.urlencode({'data': query}).encode()
            # Без явного User-Agent Overpass отдаёт 406 на Python-urllib/*.
            req = urllib.request.Request(url, data, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=300) as r:
                body = r.read().decode()
            # Перегруженный Overpass отвечает HTTP 200, но не JSON'ом, а
            # HTML-страницей с «Dispatcher_Client … The server is probably too
            # busy». Без этой проверки перегрузка выглядит как загадочный
            # JSONDecodeError, а не как «подожди и повтори».
            if body.lstrip().startswith('<'):
                raise RuntimeError('сервер занят (HTML вместо JSON)')
            return json.loads(body)
        except Exception as exc:  # noqa: BLE001 - Overpass отвечает чем угодно
            # Пауза растёт только после того, как перебраны все зеркала —
            # иначе ждали бы минуту перед тем, как просто попробовать соседа.
            wait = min(15 * (attempt // len(OVERPASS_URLS) + 1), 90)
            print('  overpass %s: %s; повтор через %ds' % (url, exc, wait), file=sys.stderr)
            if attempt == retries - 1:
                raise
            time.sleep(wait)
    return None


# ---------- Геометрия ----------

def way_ring(el):
    return [[p['lon'], p['lat']] for p in el.get('geometry', []) if p]


def closed(ring):
    return len(ring) >= 4 and ring[0] == ring[-1]


def stitch(fragments):
    """Склеивает куски мультиполигона в замкнутые кольца по общим концам.

    Члены relation приходят отдельными way, и одно кольцо часто разрезано на
    несколько таких кусков — просто взять каждый member за кольцо нельзя.
    """
    rings, pool = [], [f for f in fragments if len(f) >= 2]
    while pool:
        cur = pool.pop(0)
        changed = True
        while not closed(cur) and changed:
            changed = False
            for i, frag in enumerate(pool):
                if cur[-1] == frag[0]:
                    cur = cur + frag[1:]
                elif cur[-1] == frag[-1]:
                    cur = cur + frag[::-1][1:]
                elif cur[0] == frag[-1]:
                    cur = frag[:-1] + cur
                elif cur[0] == frag[0]:
                    cur = frag[::-1][:-1] + cur
                else:
                    continue
                pool.pop(i)
                changed = True
                break
        if closed(cur):
            rings.append(cur)
    return rings


def relation_polygons(el):
    """Мультиполигон relation → список Polygon'ов.

    Пайплайн, породивший исходный data/buildings.geojson, обрабатывал только
    way["building"] и терял relation-мультиполигоны целиком (так пропала школа
    135, см. CLAUDE.md). Здесь они разбираются наравне с way.

    Именно список Polygon, а не один MultiPolygon: весь клиентский код
    (geo.js — buildingRingIndex, polygonCentroid) читает coordinates[0] как
    внешнее кольцо, то есть рассчитан только на Polygon. MultiPolygon не
    сломался бы с ошибкой, а тихо дал бы мусорный центроид и потерянную
    привязку организаций к зданию. Внешних колец у relation обычно одно;
    когда их несколько, каждое становится своей фичей (id 'rel<N>#2', …).
    """
    outer = stitch([way_ring(m) for m in el.get('members', []) if m.get('role') != 'inner'])
    inner = stitch([way_ring(m) for m in el.get('members', []) if m.get('role') == 'inner'])
    # Дырки приписываем первому внешнему кольцу: у нескольких внешних колец
    # в этих данных дырок не бывает, а гадать по вложенности незачем.
    return [{'type': 'Polygon', 'coordinates': [o] + (inner if i == 0 else [])}
            for i, o in enumerate(outer)]


def polygon_geometries(el):
    if el['type'] == 'relation':
        return relation_polygons(el)
    ring = way_ring(el)
    if len(ring) < 4:
        return []
    if not closed(ring):
        ring = ring + [ring[0]]
    return [{'type': 'Polygon', 'coordinates': [ring]}]


# ---------- Слои ----------

def s(tags, key):
    return tags.get(key, '')


# Запросы к Overpass идут по одному ключу (way["highway"]), без отбора
# значений на его стороне: regex-отрицание вида ["highway"!~"^(…)$"] выглядит
# аккуратнее, но заставляет Overpass перебирать всё подряд — тот же bbox
# отвечал 63 линии за 0.9 с простым запросом и не укладывался в 300 с с
# regex. Ненужные значения отсекаются здесь.

# Не дороги, а разметка платформ/лифтов и ещё не построенное.
ROAD_SKIP = {'proposed', 'construction', 'platform', 'elevator', 'corridor',
             'bus_stop', 'street_lamp', 'traffic_signals', 'crossing', 'stop',
             'give_way', 'turning_circle', 'motorway_junction'}
# Рельсовое, что имеет смысл рисовать (без переездов, стрелок и сигналов).
RAILWAY_KEEP = {'rail', 'light_rail', 'narrow_gauge', 'tram', 'subway',
                'preserved', 'disused', 'abandoned'}
# natural=* попадает в landuse только зелёнкой и болотами: natural=water —
# это отдельный слой water, дублировать его здесь нельзя.
NATURAL_KEEP = {'wood', 'scrub', 'wetland', 'heath', 'grassland'}


def props_roads(t):
    if t['highway'] in ROAD_SKIP:
        return None
    return {'highway': t['highway'], 'name': s(t, 'name'), 'ref': s(t, 'ref'),
            'oneway': s(t, 'oneway'), 'surface': s(t, 'surface')}


def props_buildings(t):
    return {'building': t.get('building') or 'yes', 'name': s(t, 'name'),
            'housenumber': s(t, 'addr:housenumber'), 'street': s(t, 'addr:street'),
            'levels': s(t, 'building:levels'), 'amenity': s(t, 'amenity'),
            'shop': s(t, 'shop'), 'office': s(t, 'office')}


def props_landuse(t):
    # Существующий словарь значений: landuse=* как есть, а leisure/natural —
    # с префиксом (leisure_stadium, natural_wood). См. LANDUSE_COLORS.
    for key in ('landuse', 'leisure', 'natural'):
        if key == 'natural' and t.get(key) not in NATURAL_KEEP:
            continue
        if t.get(key):
            value = t[key] if key == 'landuse' else '%s_%s' % (key, t[key])
            p = {'landuse': value}
            if t.get('name'):
                p['name'] = t['name']
            if t.get('sport'):
                p['sport'] = t['sport']
            return p
    return None


def props_water(t):
    p = {'natural': 'water'}
    if t.get('name'):
        p['name'] = t['name']
    return p


def props_railway(t):
    if t['railway'] not in RAILWAY_KEEP:
        return None
    return {'railway': t['railway']}


def props_parking(t):
    return {'name': s(t, 'name'), 'housenumber': s(t, 'addr:housenumber'),
            'street': s(t, 'addr:street')}


def props_places(t):
    return {'place': t['place'], 'name': t['name'],
            'population': s(t, 'population')}


# query — тело Overpass-запроса (bbox подставляется заголовком),
# geom — 'polygon' | 'line' | 'point', props — маппер тегов.
LAYERS = {
    'roads': dict(query='way["highway"];', geom='line', props=props_roads),
    'buildings': dict(
        query='way["building"];relation["building"]["type"="multipolygon"];',
        geom='polygon', props=props_buildings),
    'landuse': dict(
        query='way["landuse"];way["leisure"];way["natural"];'
              'relation["landuse"]["type"="multipolygon"];relation["leisure"]["type"="multipolygon"];',
        geom='polygon', props=props_landuse),
    'water': dict(
        query='way["natural"="water"];relation["natural"="water"]["type"="multipolygon"];',
        geom='polygon', props=props_water),
    'railway': dict(query='way["railway"];', geom='line', props=props_railway),
    'parking': dict(
        query='way["amenity"="parking"];node["amenity"="parking"];',
        geom='polygon_or_point', props=props_parking),
    'places': dict(
        query='node["place"~"^(city|town|village|hamlet)$"]["name"];',
        geom='point', props=props_places),
}
# poi/memorials/addr_nodes сюда не входят намеренно: организации собираются из
# 2GIS (scripts/convert_2gis_poi.py), памятники — scripts/build_memorials.py.


def feature_id(el):
    """OSM id так, как он записан в data/.

    way -> число, relation -> 'rel<N>': в data/water.geojson мультиполигоны
    озёр уже лежат под 'rel2379978', и без того же префикса скрипт добавил бы
    те же озёра вторым экземпляром. Пространства id у way и relation в OSM
    независимы, так что без префикса это ещё и просто неоднозначно.
    """
    return 'rel%d' % el['id'] if el['type'] == 'relation' else el['id']


def build_features(layer, elements):
    spec = LAYERS[layer]
    out = []
    for el in elements:
        tags = el.get('tags') or {}
        p = spec['props'](tags)
        if p is None:
            continue
        if spec['geom'] == 'point' or (spec['geom'] == 'polygon_or_point' and el['type'] == 'node'):
            geometries = [{'type': 'Point', 'coordinates': [el['lon'], el['lat']]}]
        elif spec['geom'] == 'line':
            ring = way_ring(el)
            geometries = [{'type': 'LineString', 'coordinates': ring}] if len(ring) >= 2 else []
        else:
            geometries = polygon_geometries(el)
        for i, geometry in enumerate(geometries):
            fid = feature_id(el)
            if i:
                fid = '%s#%d' % (fid, i + 1)
            out.append({'type': 'Feature',
                        'properties': dict(id=fid, **p),
                        'geometry': geometry})
    return out


# ---------- Слияние с тем, что уже лежит в data/ ----------

def load_existing(path):
    if not os.path.exists(path):
        return {'type': 'FeatureCollection', 'features': []}
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def id_key(fid):
    # Школа 135 попала в data/buildings.geojson руками, без префикса ('rel'
    # тогда не использовался) — сравниваем по голому числу, чтобы не добавить
    # её вторым экземпляром. Совпадение id way и relation внутри одного слоя
    # теоретически возможно, но их диапазоны в OSM разошлись на два порядка.
    return str(fid)[3:] if str(fid).startswith('rel') else str(fid)


def merge(path, fresh, replace):
    fc = {'type': 'FeatureCollection', 'features': []} if replace else load_existing(path)
    have = {id_key(f['properties'].get('id')) for f in fc['features']}
    added = 0
    for f in fresh:
        if id_key(f['properties']['id']) in have:
            continue
        have.add(id_key(f['properties']['id']))
        fc['features'].append(f)
        added += 1
    with open(path, 'w', encoding='utf-8') as out:
        json.dump(fc, out, ensure_ascii=False, separators=(',', ':'))
        out.write('\n')
    return added, len(fc['features'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--areas', default=','.join(NEW_AREAS),
                    help='через запятую: %s (или all)' % ', '.join(AREAS))
    ap.add_argument('--layers', default=','.join(LAYERS))
    ap.add_argument('--replace', action='store_true',
                    help='перезаписать файлы слоёв с нуля (сотрёт ручные правки!)')
    ap.add_argument('--cache-dir', default=None,
                    help='складывать/брать сырые ответы Overpass здесь')
    args = ap.parse_args()

    areas = list(AREAS) if args.areas == 'all' else args.areas.split(',')
    layers = args.layers.split(',')
    for a in areas:
        if a not in AREAS:
            sys.exit('неизвестная область: %s' % a)

    collected = {layer: [] for layer in layers}
    for area in areas:
        bbox = AREAS[area]
        for layer in layers:
            cache = (os.path.join(args.cache_dir, '%s_%s.json' % (area, layer))
                     if args.cache_dir else None)
            if cache and os.path.exists(cache):
                with open(cache, encoding='utf-8') as f:
                    result = json.load(f)
                print('%s/%s: из кэша' % (area, layer))
            else:
                q = '[out:json][timeout:180][bbox:%f,%f,%f,%f];(%s);out body geom;' % (
                    bbox + (LAYERS[layer]['query'],))
                print('%s/%s: запрос…' % (area, layer))
                result = overpass(q)
                if cache:
                    os.makedirs(args.cache_dir, exist_ok=True)
                    with open(cache, 'w', encoding='utf-8') as f:
                        json.dump(result, f)
                time.sleep(3)  # Overpass отсюда легко уходит в "too busy"
            feats = build_features(layer, result['elements'])
            print('  %d фич' % len(feats))
            collected[layer].extend(feats)

    for layer, feats in collected.items():
        added, total = merge(os.path.join(DATA_DIR, '%s.geojson' % layer), feats, args.replace)
        print('data/%s.geojson: +%d, всего %d' % (layer, added, total))


if __name__ == '__main__':
    main()
