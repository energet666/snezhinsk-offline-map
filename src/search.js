// Search over streets, addressed buildings, organizations and memorials:
// a flat in-memory index plus the dropdown UI under the search box.
import { FUZZY_PREFIX_LEN, MAX_SEARCH_RESULTS } from './config.js';
import { polygonCentroid } from './geo.js';
import { map } from './map.js';
import { escapeHtml, formatAddress } from './popups.js';
import { memorialTypeLabel, poiLabel } from './tagstyles.js';

let searchIndex = []; // {label, sub, latlng, zoom}

export function buildSearchIndex(data) {
  searchIndex = [];
  const seenStreets = new Set();
  for (const f of data.roads.features) {
    const name = f.properties.name;
    if (!name || seenStreets.has(name)) continue;
    seenStreets.add(name);
    const coords = f.geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)];
    searchIndex.push({ label: `Улица ${name}`, sub: '', latlng: L.latLng(mid[1], mid[0]), zoom: 16 });
  }
  for (const f of data.buildings.features) {
    const p = f.properties;
    if (!p.housenumber) continue;
    const c = polygonCentroid(f.geometry.coordinates);
    const label = p.street ? `${p.street}, ${p.housenumber}` : `Дом ${p.housenumber}`;
    searchIndex.push({ label, sub: p.name || '', latlng: c, zoom: 18 });
  }
  for (const f of data.poi.features) {
    const p = f.properties;
    if (!p.name) continue;
    const c = f.geometry.coordinates;
    searchIndex.push({
      label: p.name,
      sub: [poiLabel(p), formatAddress(p)].filter(Boolean).join(' · '),
      latlng: L.latLng(c[1], c[0]),
      zoom: 18,
    });
  }
  for (const f of data.memorials.features) {
    const p = f.properties;
    const c = f.geometry.coordinates;
    searchIndex.push({
      label: p.name,
      sub: [memorialTypeLabel(p), formatAddress(p)].filter(Boolean).join(' · '),
      latlng: L.latLng(c[1], c[0]),
      zoom: 18,
    });
  }
}

function normalize(s) {
  // Strip punctuation (commas in "Улица, 39", periods in abbreviations)
  // so "Ломинского 39" matches a label written as "Ломинского, 39".
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordMatches(token, words) {
  return words.some(w => w.includes(token) ||
    (token.length >= FUZZY_PREFIX_LEN && w.length >= FUZZY_PREFIX_LEN &&
      w.slice(0, FUZZY_PREFIX_LEN) === token.slice(0, FUZZY_PREFIX_LEN)));
}

export function doSearch(query) {
  const q = normalize(query.trim());
  if (!q) return [];
  const qWords = q.split(' ');
  const exact = [];
  const fuzzy = [];
  for (const item of searchIndex) {
    const hay = normalize(item.label + ' ' + item.sub);
    if (hay.includes(q)) {
      exact.push(item);
      if (exact.length >= MAX_SEARCH_RESULTS) break; // fuzzy hits can't make the list anyway
      continue;
    }
    // "памятник Ленину" has to find a monument named just "Ленин" whose type
    // ("Памятник") lives in the subtitle — match word by word instead of as
    // one string, and tolerate Russian case endings.
    if (qWords.length > 1 || q.length >= FUZZY_PREFIX_LEN) {
      const words = hay.split(' ').filter(Boolean);
      if (qWords.every(t => wordMatches(t, words))) fuzzy.push(item);
    }
  }
  return exact.concat(fuzzy).slice(0, MAX_SEARCH_RESULTS);
}

// ---------- Dropdown UI ----------

export function initSearchUI() {
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');

  let currentResults = [];
  let selectedIndex = -1;
  let typedQuery = ''; // what the user actually typed, restored on Escape

  function selectResult(r) {
    map.setView(r.latlng, r.zoom);
    L.popup().setLatLng(r.latlng).setContent(escapeHtml(r.label)).openOn(map);
    searchResults.style.display = 'none';
    searchInput.value = r.label;
  }

  // `fillInput`: keyboard navigation substitutes the highlighted result's
  // label into the search box (like browser address-bar autocomplete);
  // mouse hover only highlights, since hovering isn't an explicit choice.
  function setSelected(i, fillInput) {
    const items = searchResults.querySelectorAll('.search-result');
    items.forEach(el => el.classList.remove('search-result-active'));
    selectedIndex = i;
    if (i >= 0 && i < items.length) {
      items[i].classList.add('search-result-active');
      items[i].scrollIntoView({ block: 'nearest' });
      if (fillInput) searchInput.value = currentResults[i].label;
    }
  }

  function moveSelection(delta) {
    const len = currentResults.length;
    if (!len) return;
    const next = selectedIndex === -1
      ? (delta > 0 ? 0 : len - 1)
      : (selectedIndex + delta + len) % len;
    setSelected(next, true);
  }

  searchInput.addEventListener('input', () => {
    typedQuery = searchInput.value;
    currentResults = doSearch(typedQuery);
    selectedIndex = -1;
    searchResults.innerHTML = '';
    if (!currentResults.length) {
      searchResults.style.display = 'none';
      return;
    }
    for (const r of currentResults) {
      const div = document.createElement('div');
      div.className = 'search-result';
      div.innerHTML = `<div class="sr-label">${escapeHtml(r.label)}</div>` + (r.sub ? `<div class="sr-sub">${escapeHtml(r.sub)}</div>` : '');
      div.addEventListener('mouseenter', () => setSelected(currentResults.indexOf(r)));
      div.addEventListener('click', () => selectResult(r));
      searchResults.appendChild(div);
    }
    searchResults.style.display = 'block';
  });

  searchInput.addEventListener('keydown', (e) => {
    if (searchResults.style.display === 'none' || !currentResults.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Enter') {
      if (selectedIndex >= 0) {
        e.preventDefault();
        selectResult(currentResults[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      searchResults.style.display = 'none';
      searchInput.value = typedQuery;
    }
  });

  document.addEventListener('click', (e) => {
    if (!searchResults.contains(e.target) && e.target !== searchInput) {
      searchResults.style.display = 'none';
    }
  });
}
