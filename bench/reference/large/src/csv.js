'use strict';
/** Split text into records [{line, fields}], skipping empty lines; line is the 1-based start line. */
function parseRecords(text) {
  const out = [];
  let fields = [], cur = '', quoted = false, line = 1, start = 1, has = false;
  const end = () => {
    if (has || fields.length) { fields.push(cur); out.push({ line: start, fields }); }
    fields = []; cur = ''; has = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else { if (c === '\n') line++; cur += c; }
    } else if (c === '"') { quoted = true; has = true; }
    else if (c === ',') { fields.push(cur); cur = ''; has = true; }
    else if (c === '\r' && text[i + 1] === '\n') continue;
    else if (c === '\n') { end(); line++; start = line; }
    else { cur += c; has = true; }
  }
  end();
  return out;
}
/** Parse CSV text into objects keyed by the header line. */
function parseCsv(text) {
  const [head, ...rest] = parseRecords(text);
  if (!head) return [];
  return rest.map(({ line, fields }) => {
    if (fields.length !== head.fields.length) throw new Error(`line ${line}: expected ${head.fields.length} fields, got ${fields.length}`);
    return Object.fromEntries(head.fields.map((h, i) => [h, fields[i]]));
  });
}
/** Turn rows into CSV text without a trailing newline. */
function stringifyCsv(rows, columns) {
  const f = (v) => { const s = v == null ? '' : String(v); return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [columns, ...rows.map((r) => columns.map((c) => r[c]))].map((l) => l.map(f).join(',')).join('\n');
}
module.exports = { parseCsv, stringifyCsv, parseRecords };
