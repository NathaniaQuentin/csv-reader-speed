// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// answer {columns, rows, errors} for the case's input {text, header}, but reads
// the text with native index scans and slices instead of one character at a time.
//
// How it stays identical: the reading rules are csv-reader's own — BOM dropped,
// records end at LF or CRLF, empty lines are no records, a lone CR outside quotes
// is dropped with a stray_cr error, a quoted field runs to its un-doubled closing
// quote ("" inside is one quote, CR/LF inside read as LF, text after the closing
// quote appended as quote_junk, a never-closing quote is literal and re-read as
// unquoted with unterminated_quote), quotes inside unquoted fields are literal,
// fields stay strings, records are padded (short_row) or cut (long_row) to the
// first record's width, and every error carries the line its record starts on
// and the record's index in rows (null for the header).
//
// How it is faster: most records hold no quote at all, so each record is first
// checked for a quote before its line break. A quote-free record is parsed with
// one slice and one split, plus a single stray-CR sweep. Only records that do
// hold a quote go through the field-by-field reader, and even there every field
// is taken as slices between the next comma, CR or LF found by indexOf, never
// built up character by character.

/** How a field ended. */
const END = 0;
const COMMA = 1;
const LINE_BREAK = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = len > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  // Once indexOf reports no quote (or no CR) from here on, none can appear
  // later in the text, so the scan is never repeated for later records.
  let noMoreQuotes = false;
  let noMoreCR = false;

  // The record being read: the line it starts on and its index in rows.
  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted field from pos, starting from `first` ('' for a plain
  // field, the quoted value when reading quote junk). Returns the field's
  // value and records how it ended in fEnded and how many characters it
  // kept in fAdded. A CR not followed by LF is dropped with a stray_cr
  // error and the field goes on; a CR followed by LF, or an LF, ends the
  // record. One global scan finds the nearest of comma, CR or LF, so no
  // delimiter scan ever runs past the field it ends. No array or result
  // object is built per field: the common case returns one slice directly.
  const SPECIAL = /[,\r\n]/g;
  let fEnded = END;
  let fAdded = 0;
  function readUnquoted(first) {
    let value = first;
    let added = 0;
    for (;;) {
      SPECIAL.lastIndex = pos;
      const m = SPECIAL.exec(text);
      if (m === null) {
        if (pos < len) {
          const tail = text.slice(pos);
          value = value === '' ? tail : value + tail;
          added += len - pos;
          pos = len;
        }
        fEnded = END;
        break;
      }
      const i = m.index;
      const ch = text.charCodeAt(i);
      if (ch === 13 && text.charCodeAt(i + 1) !== 10) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        const piece = text.slice(pos, i);
        value = value === '' ? piece : value + piece;
        added += i - pos;
        pos = i + 1;
        continue;
      }
      const piece = text.slice(pos, i);
      value = value === '' ? piece : value + piece;
      added += i - pos;
      if (ch === 44) {
        pos = i + 1;
        fEnded = COMMA;
      } else if (ch === 13) {
        pos = i + 2;
        line += 1;
        fEnded = LINE_BREAK;
      } else {
        pos = i + 1;
        line += 1;
        fEnded = LINE_BREAK;
      }
      break;
    }
    fAdded = added;
    return value;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote, skipping doubled quotes.
    let i = pos + 1;
    let close = -1;
    for (;;) {
      const j = text.indexOf('"', i);
      if (j === -1) break;
      if (text.charCodeAt(j + 1) === 34) {
        i = j + 2;
        continue;
      }
      close = j;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted, from the line the quote opened on.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    const content = text.slice(open + 1, close);
    const hasCR = content.indexOf('\r') !== -1;
    const hasDQ = content.indexOf('"') !== -1;
    // Each LF and each lone CR inside the quotes is one more line.
    let lineInc = 0;
    if (hasCR || content.indexOf('\n') !== -1) {
      const m = content.match(/\r(?!\n)|\n/g);
      lineInc = m === null ? 0 : m.length;
    }
    let value;
    if (!hasCR && !hasDQ) {
      value = content;
    } else {
      value = content.replace(/""|\r\n|\r/g, (m) => (m === '""' ? '"' : '\n'));
    }
    line += lineInc;
    pos = close + 1;
    if (pos >= len) {
      fEnded = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fEnded = COMMA;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fEnded = LINE_BREAK;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fEnded = LINE_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break; any character kept there is quote_junk.
    const v = readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return v;
  }

  // Reads one record that holds a quote, field by field.
  function readRecordSlow() {
    const fields = [];
    let quoted = false;
    let ended;
    do {
      quoted = text.charCodeAt(pos) === 34;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
      ended = fEnded;
    } while (ended === COMMA);
    return { fields, quoted };
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const nl = text.indexOf('\n', pos);
    let q = -1;
    if (!noMoreQuotes) {
      q = text.indexOf('"', pos);
      if (q === -1) noMoreQuotes = true;
    }
    const hasQuote = q !== -1 && (nl === -1 || q < nl);

    let fields;
    let quoted = false;
    if (!hasQuote) {
      // Quote-free record: one slice, one split, one stray-CR sweep.
      const end = nl === -1 ? len : nl;
      let segEnd = end;
      if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) segEnd = end - 1;
      let seg = text.slice(pos, segEnd);
      if (!noMoreCR) {
        const r = text.indexOf('\r', pos);
        if (r === -1) {
          noMoreCR = true;
        } else if (r < segEnd) {
          let n = 0;
          let k = -1;
          while ((k = seg.indexOf('\r', k + 1)) !== -1) n += 1;
          for (let i = 0; i < n; i += 1) {
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          }
          seg = seg.replace(/\r/g, '');
        }
      }
      fields = seg.split(',');
      pos = nl === -1 ? len : nl + 1;
      if (nl !== -1) line += 1;
    } else {
      const rec = readRecordSlow();
      fields = rec.fields;
      quoted = rec.quoted;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
