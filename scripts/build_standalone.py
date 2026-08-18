#!/usr/bin/env python3
"""Собирает всю офлайн-карту в один самодостаточный HTML-файл.

Нужен, когда карту надо открыть без локального сервера (например, отдать
файл человеку или опубликовать как artifact): Leaflet, стили, GeoJSON и
спутниковые тайлы вшиваются в HTML — внешних запросов у страницы нет.

Использование:
    python3 scripts/build_standalone.py [выходной.html] [--max-tile-z N]

Тайлы z17 весят 61 МБ, поэтому по умолчанию вшиваются зумы 10-15
(~10 МБ в base64): при большем приближении Leaflet растягивает z15
(maxNativeZoom). Полная детализация остаётся у обычного запуска ./run.sh.
"""
import base64
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PIXEL = ('data:image/gif;base64,'
         'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')

DATA_FILES = [
    'roads', 'buildings', 'poi', 'landuse',
    'water', 'railway', 'addr_nodes', 'parking',
]


def js_json(obj):
    """JSON, безопасный для вставки внутрь <script>."""
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':')) \
        .replace('</', '<\\/').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')


def collect_tiles(max_z):
    tiles = {}
    for png in sorted((ROOT / 'tiles').rglob('*.png')):
        z, x, y = png.parent.parent.name, png.parent.name, png.stem
        if not z.isdigit() or int(z) > max_z:
            continue
        b64 = base64.b64encode(png.read_bytes()).decode('ascii')
        tiles[f'{z}/{x}/{y}'] = 'data:image/png;base64,' + b64
    return tiles


def build(out_path, max_tile_z):
    data = {f'data/{n}.geojson': json.loads((ROOT / 'data' / f'{n}.geojson').read_text('utf-8'))
            for n in DATA_FILES}
    tiles = collect_tiles(max_tile_z)
    native_z = max((int(k.split('/')[0]) for k in tiles), default=max_tile_z)

    leaflet_css = (ROOT / 'lib' / 'leaflet.css').read_text('utf-8')
    marker = base64.b64encode((ROOT / 'lib' / 'images' / 'marker-icon.png').read_bytes()).decode()
    leaflet_css = leaflet_css.replace('url(images/marker-icon.png)',
                                      f'url(data:image/png;base64,{marker})')
    # Иконки свёрнутого layers-control в сборке не нужны — контрол всегда развёрнут.
    for missing in ('url(images/layers-2x.png)', 'url(images/layers.png)'):
        leaflet_css = leaflet_css.replace(missing, 'none')

    app_js = (ROOT / 'app.js').read_text('utf-8')
    app_js = app_js.replace('const MAX_NATIVE_SAT_ZOOM = 17;',
                            f'const MAX_NATIVE_SAT_ZOOM = {native_z};')
    app_js = app_js.replace("errorTileUrl: 'lib/images/marker-shadow.png',",
                            f"errorTileUrl: '{PIXEL}',")

    html = f"""<title>Карта Снежинска</title>
<style>
{leaflet_css}
{(ROOT / 'style.css').read_text('utf-8')}
/* Страница-обёртка artifact'а красит свой фон: карта занимает весь вьюпорт. */
html, body {{ background: #eef0f1; }}
#map {{ position: fixed; inset: 0; height: 100%; }}
</style>

<div id="map"></div>
<div id="search-box">
  <input id="search-input" type="text" placeholder="Поиск: улица, дом, организация…" autocomplete="off">
  <div id="search-results"></div>
</div>
<div id="loading">Загрузка карты Снежинска…</div>

<script>{(ROOT / 'lib' / 'leaflet.js').read_text('utf-8')}</script>
<script>
// Данные и тайлы вшиты в страницу: сети нет, поэтому fetch и загрузчик
// тайлов Leaflet отвечают из этих таблиц.
const EMBEDDED_DATA = {js_json(data)};
const EMBEDDED_TILES = {js_json(tiles)};
const BLANK_TILE = '{PIXEL}';

window.fetch = function (path) {{
  if (Object.prototype.hasOwnProperty.call(EMBEDDED_DATA, path)) {{
    return Promise.resolve({{ ok: true, json: () => Promise.resolve(EMBEDDED_DATA[path]) }});
  }}
  return Promise.reject(new Error('нет во встроенных данных: ' + path));
}};

L.TileLayer.prototype.getTileUrl = function (coords) {{
  return EMBEDDED_TILES[coords.z + '/' + coords.x + '/' + coords.y] || BLANK_TILE;
}};
</script>
<script>{(ROOT / 'style.js').read_text('utf-8')}</script>
<script>{app_js}</script>
"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, 'utf-8')
    return len(tiles), native_z, out_path.stat().st_size


def main(argv):
    out = ROOT / 'dist' / 'snezhinsk-standalone.html'
    max_tile_z = 15
    args = list(argv)
    if '--max-tile-z' in args:
        i = args.index('--max-tile-z')
        max_tile_z = int(args[i + 1])
        del args[i:i + 2]
    if args:
        out = pathlib.Path(args[0]).resolve()
    n, native_z, size = build(out, max_tile_z)
    print(f'{out}: {size / 1024 / 1024:.1f} МБ, тайлов {n} (до z{native_z})')


if __name__ == '__main__':
    main(sys.argv[1:])
