const root = document.documentElement;
const page = document.body.dataset.page || 'docs';
const menuButton = document.querySelector('.menu-button');
const scrim = document.querySelector('.scrim');
const navLinks = [...document.querySelectorAll('.sidebar nav a')];
const searchable = [...document.querySelectorAll('.searchable')];
const search = document.querySelector('#docs-search');
const status = document.querySelector('.search-status');

// Release notes live on releases.html. Old links to index.html#whats-new-0-40-0 (and any other
// version) land there; #whats-new stays the latest on index.html. A link on releases.html to a
// docs section (#mcp, #updates) goes back to index.html.
// (tests/docsSite.test.ts runs hashRedirectTarget on its own: keep it pure.)
function hashRedirectTarget(currentPage, id, existsHere) {
  if (!id || existsHere) return null;
  if (currentPage === 'docs') return /^whats-new-\d/.test(id) ? `releases.html#${id}` : null;
  return `index.html#${id}`;
}
function redirectHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  const target = hashRedirectTarget(page, id, Boolean(id && document.getElementById(id)));
  if (target) location.replace(target);
}
redirectHash();
window.addEventListener('hashchange', redirectHash);

function closeMenu() { root.classList.remove('menu-open'); menuButton.setAttribute('aria-expanded', 'false'); }
menuButton.addEventListener('click', () => { const open = root.classList.toggle('menu-open'); menuButton.setAttribute('aria-expanded', String(open)); });
scrim.addEventListener('click', closeMenu);
navLinks.forEach((link) => link.addEventListener('click', closeMenu));

document.querySelectorAll('pre').forEach((block) => {
  const button = document.createElement('button');
  button.className = 'copy-button'; button.type = 'button'; button.textContent = 'Copy';
  button.addEventListener('click', async () => { await navigator.clipboard.writeText(block.querySelector('code').innerText); button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1400); });
  block.append(button);
});

// Search filters this page's sections and counts matches on the other page (docs ↔ release notes),
// with a link that opens it with the same query.
const other = page === 'releases' ? { href: 'index.html', label: 'the docs' } : { href: 'releases.html', label: 'release notes' };
let otherSections = null;
async function loadOther() {
  if (otherSections) return otherSections;
  try {
    const response = await fetch(other.href);
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    otherSections = [...doc.querySelectorAll('.searchable')].map((section) => `${section.dataset.search || ''} ${section.textContent}`.toLowerCase());
  } catch { otherSections = []; }
  return otherSections;
}
const matches = (text, query) => query.split(/\s+/).every((word) => text.includes(word));

async function runSearch() {
  const query = search.value.trim().toLowerCase(); let shown = 0;
  searchable.forEach((section) => { const match = !query || matches(`${section.dataset.search || ''} ${section.innerText}`.toLowerCase(), query); section.classList.toggle('hidden', !match); if (match) shown += 1; });
  status.textContent = query ? `${shown} section${shown === 1 ? '' : 's'} found on this page` : '';
  if (!query) return;
  const elsewhere = (await loadOther()).filter((text) => matches(text, query)).length;
  if (search.value.trim().toLowerCase() !== query || !elsewhere) return;
  const link = document.createElement('a');
  link.href = `${other.href}?q=${encodeURIComponent(search.value.trim())}`;
  link.textContent = `${elsewhere} in ${other.label} →`;
  status.append(' · ', link);
}
search.addEventListener('input', runSearch);
const initial = new URLSearchParams(location.search).get('q');
if (initial) { search.value = initial; runSearch(); }

const observer = new IntersectionObserver((entries) => {
  const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (!visible) return;
  navLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`));
}, { rootMargin: '-20% 0px -65% 0px', threshold: [0, .25, .5] });
searchable.forEach((section) => observer.observe(section));
