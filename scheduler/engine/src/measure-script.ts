/**
 * The script a poster page runs in headless Chrome when it is measured. It waits for fonts and images, finds the largest
 * font size inside each text element's range that fits its slot (no horizontal or vertical overflow, line count within
 * its limit), then reports the real geometry: solved sizes, collisions between content elements, content outside the safe
 * margins, glyphs no font could draw, loaded fonts and images. The report is written into the page as JSON and found by the
 * renderer in the dumped DOM. A page that never writes it has not been measured, whatever Chrome's exit code says.
 */
export const REPORT_ELEMENT_ID = 'fit-report';

export const SOLVER_SCRIPT = String.raw`
(function () {
  var report = { done: false, errors: [], fontSource: document.documentElement.getAttribute('data-font-source') || 'unknown', fonts: { status: 'unknown', faces: [] }, images: [], elements: [], collisions: [], outside: [], missingGlyphs: [] };
  var margin = Number(document.body.getAttribute('data-margin') || 32);
  var clearance = Number(document.body.getAttribute('data-clearance') || 8);
  var canvas = Number(document.body.getAttribute('data-canvas') || 1080);

  function lineCount(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var tops = Array.prototype.map.call(range.getClientRects(), function (r) { return r.top; }).sort(function (a, b) { return a - b; });
    var size = parseFloat(getComputedStyle(el).fontSize) || 16;
    var lines = 0, last = -1e9;
    tops.forEach(function (t) { if (t - last > size * 0.4) { lines += 1; last = t; } });
    return lines;
  }

  function contentRect(el) {
    // Horizontal extent from the glyphs themselves; vertical extent from the laid-out block, whose line boxes are what the layout planned for.
    var block = el.getBoundingClientRect();
    var range = document.createRange();
    range.selectNodeContents(el);
    var rects = Array.prototype.filter.call(range.getClientRects(), function (r) { return r.width > 0 && r.height > 0; });
    if (!rects.length) return { x: block.left, y: block.top, w: block.width, h: block.height };
    var x0 = Math.min.apply(null, rects.map(function (r) { return r.left; }));
    var x1 = Math.max.apply(null, rects.map(function (r) { return r.right; }));
    return { x: x0, y: block.top, w: x1 - x0, h: block.height };
  }

  function solve(el) {
    var max = Number(el.getAttribute('data-fit-max')), min = Number(el.getAttribute('data-fit-min'));
    var maxLines = Number(el.getAttribute('data-max-lines') || 0);
    var slotW = Number(el.getAttribute('data-slot-w')), slotH = Number(el.getAttribute('data-slot-h'));
    function measure(size) {
      el.style.fontSize = size + 'px';
      var lines = lineCount(el);
      var height = el.getBoundingClientRect().height;
      var fits = el.scrollWidth <= slotW + 1 && height <= slotH + 0.5 && (maxLines === 0 || lines <= maxLines);
      return { lines: lines, height: height, fits: fits };
    }
    // A preferred line count is tried first (the largest size that stays within it); only when no size does is the full limit used.
    var preferLines = Number(el.getAttribute('data-prefer-lines') || 0), limit = maxLines;
    function search() {
      var lo = min, hi = Math.max(max, min), found = null;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (measure(mid).fits) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return found;
    }
    var best = null;
    if (preferLines > 0 && (maxLines === 0 || preferLines < maxLines)) { maxLines = preferLines; best = search(); maxLines = limit; }
    if (best === null) best = search();
    var size = best === null ? min : best;
    var m = measure(size);
    return { slot: el.getAttribute('data-slot'), role: el.getAttribute('data-role'), layer: el.getAttribute('data-layer') || 'text', fontSize: size, min: min, max: max, lines: m.lines, maxLines: maxLines, height: m.height, slotH: slotH, slotW: slotW, fits: best !== null, rect: contentRect(el) };
  }

  function overlaps(a, b, gap) {
    return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
  }

  function finish() {
    var s = document.createElement('script');
    s.id = '${REPORT_ELEMENT_ID}';
    s.type = 'application/json';
    s.textContent = JSON.stringify(report).replace(/</g, '\\u003c');
    document.head.appendChild(s);
    document.documentElement.setAttribute('data-measured', '1');
  }

  function run() {
    try {
      Array.prototype.forEach.call(document.querySelectorAll('[data-fit]'), function (el) { report.elements.push(solve(el)); });
      Array.prototype.forEach.call(document.querySelectorAll('[data-layer="brand"]'), function (el) {
        var inner = el.querySelector('img,svg');
        var r = (inner || el).getBoundingClientRect();
        var named = el.getAttribute('data-fit') === null;
        if (named) report.elements.push({ slot: el.getAttribute('data-slot'), role: 'logo', layer: 'brand', fontSize: 0, min: 0, max: 0, lines: 0, maxLines: 0, height: r.height, slotH: 0, slotW: 0, fits: true, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
      });
      var content = report.elements.filter(function (e) { return e.rect.w > 0 && e.rect.h > 0; });
      content.forEach(function (e) {
        if (e.rect.x < margin - 0.5 || e.rect.y < margin - 0.5 || e.rect.x + e.rect.w > canvas - margin + 0.5 || e.rect.y + e.rect.h > canvas - margin + 0.5) report.outside.push(e.slot);
      });
      for (var i = 0; i < content.length; i++) {
        for (var j = i + 1; j < content.length; j++) {
          if (overlaps(content[i].rect, content[j].rect, clearance)) report.collisions.push([content[i].slot, content[j].slot]);
        }
      }
      var text = Array.prototype.map.call(document.querySelectorAll('[data-fit],[data-layer="brand"]'), function (el) { return el.textContent || ''; }).join('');
      var surface = document.createElement('canvas');
      surface.width = 64; surface.height = 64;
      var ctx = surface.getContext('2d', { willReadFrequently: true });
      ctx.font = '40px ' + getComputedStyle(document.body).fontFamily;
      ctx.textBaseline = 'alphabetic';
      function ink(ch) {
        ctx.clearRect(0, 0, 64, 64);
        ctx.fillText(ch, 8, 48);
        return Array.prototype.join.call(ctx.getImageData(0, 0, 64, 64).data, ',');
      }
      var reference = ink(String.fromCodePoint(0x10ffff));
      var seen = {};
      Array.from(text).forEach(function (ch) {
        var cp = ch.codePointAt(0);
        if (seen[ch] || /\s/.test(ch) || /\p{M}/u.test(ch) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202e)) return;
        seen[ch] = true;
        if (ink(ch) === reference) report.missingGlyphs.push(ch);
      });
      report.fonts.status = document.fonts ? document.fonts.status : 'unsupported';
      report.fonts.faces = document.fonts ? Array.from(document.fonts).map(function (f) { return { family: f.family, status: f.status }; }) : [];
      report.done = true;
    } catch (error) {
      report.errors.push(String(error && error.message ? error.message : error));
    }
    finish();
  }

  var images = Array.prototype.slice.call(document.querySelectorAll('img'));
  var waits = images.map(function (img) { return img.complete ? Promise.resolve() : new Promise(function (resolve) { img.onload = resolve; img.onerror = resolve; }); });
  var fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  Promise.all(waits.concat([fontsReady])).then(function () {
    report.images = images.map(function (img) { return { slot: img.getAttribute('data-slot') || '', ok: img.complete && img.naturalWidth > 0 }; });
    run();
  }).catch(function (error) { report.errors.push(String(error)); finish(); });
})();
`;
