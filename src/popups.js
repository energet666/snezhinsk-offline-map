// HTML for every popup on the map. Kept apart from the layer code so the
// markup lives in one place and the layers only bind the result.
import { bankFromWebsite, memorialTypeLabel, poiLabel } from './tagstyles.js';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function formatAddress(p) {
  return [p.street, p.housenumber].filter(Boolean).join(', ');
}

// Phone/hours/website block shared by the building-popup org list and the
// standalone-POI popup (see standalonePoiPopupHtml).
function orgDetailsHtml(o) {
  let details = '';
  if (o.phone) details += `<div class="org-detail">☎ ${escapeHtml(o.phone)}</div>`;
  if (o.opening_hours) {
    const days = o.opening_hours.split('; ').map(d => `<div>${escapeHtml(d)}</div>`).join('');
    details += `<div class="org-detail org-hours">🕑<div class="org-hours-days">${days}</div></div>`;
  }
  if (o.website) details += `<div class="org-detail"><a href="${escapeHtml(o.website)}" target="_blank" rel="noopener">${escapeHtml(o.website)}</a></div>`;
  return details;
}

// Building popup: address/name plus the organizations found inside its
// outline. Details (phone/hours/website) start hidden — only the org name
// list shows by default; clicking a name reveals that org's details (wired
// up in layers.js). Returns '' when there is nothing at all to show.
export function buildingPopupHtml(p, orgs) {
  const addr = formatAddress(p);
  if (!p.name && !addr && !orgs.length) return '';
  let html = '';
  if (p.name) html += `<b>${escapeHtml(p.name)}</b><br>`;
  if (addr) html += `${escapeHtml(addr)}<br>`;
  if (orgs.length) {
    html += '<div class="building-orgs">' + orgs.map(o => {
      const cat = poiLabel(o);
      const bank = o.amenity === 'atm' ? bankFromWebsite(o.website) : '';
      const title = o.name || cat || 'организация';
      const subtitle = o.name ? cat : bank;
      const details = orgDetailsHtml(o);
      const clickable = details ? ' org-item-clickable' : '';
      return `<div class="org-item${clickable}">` +
        `<div class="org-name"><b>${escapeHtml(title)}</b>` +
        (subtitle ? ` <span class="org-cat">(${escapeHtml(subtitle)})</span>` : '') +
        '</div>' +
        (details ? `<div class="org-detail-panel" hidden>${details}</div>` : '') +
        '</div>';
    }).join('') + '</div>';
  }
  return html;
}

// Popup for a POI with no enclosing building (e.g. школа 135) — there's no
// polygon to click for details, so the label itself carries the popup.
// Only one organization here, so no need for the building popup's
// click-to-expand list — just show everything.
export function standalonePoiPopupHtml(p) {
  const addr = formatAddress(p);
  let html = '';
  if (p.name) html += `<b>${escapeHtml(p.name)}</b><br>`;
  if (addr) html += `${escapeHtml(addr)}<br>`;
  const cat = poiLabel(p);
  if (cat) html += `<span class="org-cat">${escapeHtml(cat)}</span>`;
  html += orgDetailsHtml(p);
  return html;
}

export function memorialPopupHtml(p) {
  const addr = formatAddress(p);
  let html = `<b>${escapeHtml(p.name)}</b><br>` +
    `<span class="memorial-type">${escapeHtml(memorialTypeLabel(p))}</span>`;
  if (addr) html += `<br>${escapeHtml(addr)}`;
  if (p.inscription && p.inscription !== p.name) html += `<br>«${escapeHtml(p.inscription)}»`;
  if (p.description) html += `<br>${escapeHtml(p.description)}`;
  if (p.artist) html += `<br>скульптор: ${escapeHtml(p.artist)}`;
  html += `<div class="memorial-source">источник: ${escapeHtml(p.source)}</div>`;
  return html;
}

export function parkingPopupHtml(p) {
  const addr = formatAddress(p);
  const title = p.name ? escapeHtml(p.name) : 'Парковка';
  return title + (addr ? '<br>' + escapeHtml(addr) : '');
}
