// Settings panel built from a declarative list, so every option looks and behaves the same:
// tabs -> cards -> rows (switch / slider with live value / segmented choice / swatches / buttons).
// Each item has get() / set(v); the panel never stores state itself.
//   {tab, card, type:'switch'|'slider'|'seg'|'swatch'|'buttons'|'note', id, label, desc, get, set,
//    min, max, step, fmt, options:[[value,label]], buttons:[[label, onClick, cls]], show()}
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

export function buildSettings(root, tabs, items) {
  root.innerHTML = '';
  const head = el('div', 'set-head');
  head.append(el('div', 'set-grip'), el('h2', '', 'Settings'));
  const close = el('button', 'set-close', '✕'); close.setAttribute('aria-label', 'Close settings'); head.append(close);
  const tabBar = el('div', 'set-tabs'); tabBar.setAttribute('role', 'tablist');
  const body = el('div', 'set-body');
  root.append(head, tabBar, body);
  const panes = {}, tabBtns = {}, refreshers = [];
  for (const t of tabs) {
    const b = el('button', 'set-tab', `<span class="ti">${t.icon}</span><span>${t.label}</span>`); b.setAttribute('role', 'tab'); b.dataset.tab = t.id;
    tabBar.append(b); tabBtns[t.id] = b;
    const p = el('div', 'set-pane'); p.dataset.tab = t.id; p.hidden = true; body.append(p); panes[t.id] = p;
    b.addEventListener('click', () => select(t.id));
  }
  const cards = {};
  for (const it of items) {
    const pane = panes[it.tab]; if (!pane) continue;
    const ck = it.tab + '/' + (it.card || '');
    let card = cards[ck];
    if (!card) { card = el('section', 'set-card'); if (it.card) card.append(el('h3', '', it.card)); pane.append(card); cards[ck] = card; }
    const row = el('div', 'set-row set-' + it.type);
    // wide controls (many / long choices, buttons, swatches) go on their own line under the label
    const wide = it.type === 'buttons' || it.type === 'swatch' || (it.type === 'seg' && (it.options.length > 3 || it.options.reduce((n, o) => n + o[1].length, 0) > 22));
    if (wide) row.classList.add('stack');
    const text = el('div', 'set-text');
    if (it.label) text.append(el('div', 'set-label', it.label));
    if (it.desc) text.append(el('div', 'set-desc', it.desc));
    let refresh = () => {};
    if (it.type === 'switch') {
      const lab = el('label', 'switch'); const inp = el('input'); inp.type = 'checkbox'; if (it.id) inp.id = it.id;
      lab.append(inp, el('span', 'knob')); row.append(text, lab);
      inp.addEventListener('change', () => it.set(inp.checked));
      refresh = () => { inp.checked = !!it.get(); };
      row.addEventListener('click', (e) => { if (e.target === row || text.contains(e.target)) { inp.checked = !inp.checked; it.set(inp.checked); } });
    } else if (it.type === 'slider') {
      const top = el('div', 'set-sl-top'); const val = el('span', 'set-val'); top.append(text, val);
      const inp = el('input'); inp.type = 'range'; inp.min = it.min; inp.max = it.max; inp.step = it.step || 0.05; if (it.id) inp.id = it.id;
      row.append(top, inp);
      const show = () => { val.textContent = it.fmt ? it.fmt(+inp.value) : (+inp.value).toFixed(2); inp.style.setProperty('--p', ((inp.value - it.min) / (it.max - it.min) * 100) + '%'); };
      inp.addEventListener('input', () => { it.set(+inp.value); show(); });
      if (it.reset !== undefined) { val.title = 'Double-tap to reset'; val.addEventListener('dblclick', () => { inp.value = it.reset; it.set(it.reset); show(); }); }
      refresh = () => { inp.value = it.get(); show(); };
    } else if (it.type === 'seg') {
      const seg = el('div', 'segctl'); if (it.id) seg.id = it.id;
      const btns = it.options.map(([v, l]) => { const b = el('button', '', l); b.dataset.v = v; b.addEventListener('click', () => { it.set(v); refreshAll(); }); seg.append(b); return b; });
      row.append(text, seg);
      refresh = () => { const cur = String(it.get()); btns.forEach((b) => b.classList.toggle('on', b.dataset.v === cur)); };
    } else if (it.type === 'swatch') {
      const sw = el('div', 'set-swatches'); if (it.id) sw.id = it.id;
      const btns = it.options.map(([v, l]) => {
        const b = el('button', 'swatch' + (v === 'transparent' ? ' clear' : '')); b.title = l; b.setAttribute('aria-label', l); b.dataset.v = v;
        if (v !== 'transparent') b.style.background = v;
        b.addEventListener('click', () => { it.set(v); refreshAll(); }); sw.append(b); return b;
      });
      const name = el('div', 'set-desc');
      row.append(text, sw, name);
      refresh = () => { const cur = it.get(); btns.forEach((b) => b.classList.toggle('on', b.dataset.v === cur)); const o = it.options.find(([v]) => v === cur); name.textContent = o ? o[1] : ''; };
    } else if (it.type === 'buttons') {
      const bs = el('div', 'set-btns');
      for (const [l, fn, cls, id] of it.buttons) { const b = el('button', cls || '', l); if (id) b.id = id; b.addEventListener('click', () => { fn(b); refreshAll(); }); bs.append(b); }
      row.append(text, bs);
    } else if (it.type === 'live') {
      const box = el('div', 'set-live'); row.append(text, box);
      refresh = () => { if (!root.hidden) box.innerHTML = it.html(); };
    } else if (it.type === 'note') {
      row.append(text);
    }
    card.append(row);
    refreshers.push(() => { row.hidden = it.show ? !it.show() : false; refresh(); });
  }
  function refreshAll() { refreshers.forEach((f) => f()); }
  let current = tabs[0].id;
  function select(id) {
    current = id;
    for (const t of tabs) { panes[t.id].hidden = t.id !== id; tabBtns[t.id].classList.toggle('on', t.id === id); tabBtns[t.id].setAttribute('aria-selected', t.id === id); }
    body.scrollTop = 0;
    try { localStorage.setItem('mp-settings-tab', id); } catch {}
  }
  let saved = null; try { saved = localStorage.getItem('mp-settings-tab'); } catch {}
  select(tabs.some((t) => t.id === saved) ? saved : current);
  refreshAll();
  return { refresh: refreshAll, select, close };
}
