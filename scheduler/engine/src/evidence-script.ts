/**
 * The script that reads a page's structure inside headless Chrome, so no HTML is parsed with patterns. It walks the rendered DOM and
 * writes one block per run of visible text, with what the structure says about it: the nearest heading, whether it sits in a table
 * (and under which row and column labels), a list or a repeated card (and the card's title), whether it is site chrome, whether it
 * sits in something labelled as a demo, whether it belongs to a strip of short figures, and the language it is marked with.
 * Scripts of the page itself are blocked by the page's content security policy (see evidence-extract.ts); only this one runs.
 */
export const EVIDENCE_ELEMENT_ID = 'evidence-blocks';

export const EVIDENCE_SCRIPT = String.raw`
(function () {
  var out = { done: false, errors: [], title: document.title || '', lang: document.documentElement.getAttribute('lang') || '', blocks: [], truncated: false, externalStyles: document.querySelectorAll('link[rel~=stylesheet]').length, variantSwitch: false };
  var MAX_BLOCKS = 1500;
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1, HEAD: 1, OBJECT: 1, EMBED: 1, SELECT: 1, OPTION: 1, TEXTAREA: 1 };
  var DEMO = /(^|[^a-z])(demo|mock|mockup|sample|preview|example|placeholder|screenshot|illustration|bubble|transcript|phone-frame|device-frame)([^a-z]|$)/i;
  var seq = 0;

  function clean(text) { return String(text).replace(/\s+/g, ' ').trim(); }
  function hidden(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    var cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  }
  function inline(el) {
    var d = getComputedStyle(el).display;
    return d === 'inline' || d === 'contents' || d === 'inline-block' || d === 'inline-flex' || d === 'ruby';
  }
  function isHeading(el) { return /^H[1-6]$/.test(el.tagName); }

  function chromeOf(el) {
    var nav = el.closest('nav,[role=navigation]');
    if (nav) return 'nav';
    if (el.closest('aside,[role=complementary]')) return 'aside';
    var inContent = el.closest('main,article,section,[role=main]');
    if (!inContent) {
      if (el.closest('header,[role=banner]')) return 'header';
      if (el.closest('footer,[role=contentinfo]')) return 'footer';
    }
    return '';
  }

  function demoContext(el) {
    for (var n = el, depth = 0; n && n !== document.body && depth < 12; n = n.parentElement, depth += 1) {
      var probe = (n.getAttribute('id') || '') + ' ' + (n.getAttribute('class') || '') + ' ' + (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('data-testid') || '');
      if (DEMO.test(probe)) return true;
      // A picture of an interface is not clickable: the page's own style switches pointer events off on it.
      if (getComputedStyle(n).pointerEvents === 'none') return true;
    }
    return false;
  }

  function cardOf(el) {
    for (var n = el, depth = 0; n && n.parentElement && n !== document.body && depth < 6; n = n.parentElement, depth += 1) {
      var parent = n.parentElement;
      var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === n.tagName && c.className === n.className; });
      if (same.length < 2) continue;
      var heading = n.querySelector('h1,h2,h3,h4,h5,h6');
      if (!heading || !n.className || /^(LI|TR|TD|SECTION|MAIN|ARTICLE)$/.test(n.tagName)) continue;
      if (!parent.__group) { seq += 1; parent.__group = 'group' + seq; }
      if (!n.__card) { seq += 1; n.__card = 'card' + seq; }
      return { id: n.__card, group: parent.__group, title: clean(heading.textContent) };
    }
    return null;
  }

  function tableOf(cell) {
    var row = cell.parentElement;
    var table = cell.closest('table');
    if (!row || !table) return null;
    var rowLabel = '', colLabel = '';
    var first = row.cells && row.cells[0];
    if (first && first !== cell && first.tagName === 'TH') rowLabel = clean(first.textContent);
    var headRow = table.tHead && table.tHead.rows[0] ? table.tHead.rows[0] : (table.rows[0] && table.rows[0] !== row && Array.prototype.every.call(table.rows[0].cells, function (c) { return c.tagName === 'TH'; }) ? table.rows[0] : null);
    if (headRow && headRow !== row && headRow.cells[cell.cellIndex]) colLabel = clean(headRow.cells[cell.cellIndex].textContent);
    return { rowLabel: rowLabel, colLabel: colLabel, header: cell.tagName === 'TH' && (!headRow || headRow === row || cell === first) };
  }

  function linkOnly(el, text) {
    var link = el.closest('a,button,[role=button]');
    if (!link && el.children.length === 1 && el.firstElementChild.matches('a,button,[role=button]')) link = el.firstElementChild;
    return !!link && clean(link.textContent) === text;
  }

  function statStrip(el) {
    var parent = el.parentElement;
    if (!parent || parent.children.length < 3) return false;
    var kids = Array.prototype.slice.call(parent.children);
    var short = kids.filter(function (k) { return clean(k.textContent).length <= 60; });
    var withDigit = kids.filter(function (k) { return /\d/.test(k.textContent); });
    return short.length === kids.length && withDigit.length >= 3;
  }

  var heading = { text: '', level: 0 };

  function flush(el, text, asHeading) {
    text = clean(text);
    if (!text) return;
    if (out.blocks.length >= MAX_BLOCKS) { out.truncated = true; return; }
    var cell = el.closest('td,th');
    var table = cell ? tableOf(cell) : null;
    var card = cardOf(el);
    var langEl = el.closest('[lang]');
    var region = table ? 'table' : el.closest('li') ? 'list' : 'prose';
    var block = {
      id: 'b' + out.blocks.length, text: text, tag: el.tagName.toLowerCase(), region: region,
      isHeading: !!asHeading, headingText: asHeading ? '' : heading.text, chrome: chromeOf(el),
      cardId: card ? card.id : '', cardGroup: card ? card.group : '', cardTitle: card ? card.title : '',
      rowLabel: table ? table.rowLabel : '', colLabel: table ? table.colLabel : '', tableHeader: table ? table.header : false,
      linkOnly: linkOnly(el, text), demo: demoContext(el), strip: region === 'prose' ? statStrip(el) : false,
      lang: (langEl ? langEl.getAttribute('lang') : '') || out.lang
    };
    out.blocks.push(block);
  }

  function walk(el) {
    if (SKIP[el.tagName.toUpperCase()] || hidden(el)) return;
    if (isHeading(el)) {
      var text = clean(el.textContent);
      heading = { text: text, level: Number(el.tagName.charAt(1)) };
      flush(el, text, true);
      return;
    }
    var buffer = '';
    Array.prototype.forEach.call(el.childNodes, function (node) {
      if (node.nodeType === 3) { buffer += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      if (SKIP[node.tagName.toUpperCase()] || hidden(node)) return;
      if (node.tagName === 'BR') { buffer += ' '; return; }
      if (inline(node) && !node.querySelector('h1,h2,h3,h4,h5,h6,p,div,li,table,section,article,ul,ol')) { buffer += ' ' + node.textContent + ' '; return; }
      flush(el, buffer, false);
      buffer = '';
      walk(node);
    });
    flush(el, buffer, false);
  }

  var SWITCH = /(monthly|yearly|annual|annually|billed (monthly|yearly|annually))/i;
  Array.prototype.forEach.call(document.querySelectorAll('[role=switch],[role=tab],input[type=checkbox],input[type=radio],button'), function (el) {
    var probe = (el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('value') || '') + ' ' + (el.getAttribute('id') || '');
    if (SWITCH.test(probe)) out.variantSwitch = true;
  });

  try {
    walk(document.body);
    out.done = true;
  } catch (e) {
    out.errors.push(String(e && e.message ? e.message : e));
  }
  var holder = document.createElement('script');
  holder.type = 'application/json';
  holder.id = '${EVIDENCE_ELEMENT_ID}';
  holder.textContent = JSON.stringify(out).replace(/</g, '\\u003c').replace(/&/g, '\\u0026');
  document.documentElement.appendChild(holder);
})();
`;
