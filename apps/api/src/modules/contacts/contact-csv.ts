import { ValidationFailedException } from '../../common/errors/app-exception';

export const MAX_CONTACT_IMPORT_ROWS = 5_000;
export const MAX_CONTACT_IMPORT_BYTES = 5 * 1024 * 1024;
export const CONTACT_IMPORT_BATCH_SIZE = 100;

export interface ParsedContactCsvRow {
  line: number;
  values: Record<string, string>;
  error?: string;
}

export interface ParsedContactCsv {
  headers: string[];
  rows: ParsedContactCsvRow[];
}

const NAME_HEADERS = new Set(['fullname', 'name', 'contactname', 'customername']);
const IDENTITY_HEADERS = new Set(['phone', 'mobile', 'phonenumber', 'mobilenumber', 'email', 'emailaddress']);

export function canonicalHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** RFC 4180-style parser with line-numbered structural failures. */
export function parseContactCsv(text: string): ParsedContactCsv {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTACT_IMPORT_BYTES) {
    throw new ValidationFailedException(`A CSV import is limited to ${MAX_CONTACT_IMPORT_BYTES} bytes`);
  }

  const rawRows: Array<{ line: number; fields: string[] }> = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let rowLine = 1;
  let line = 1;

  const pushRow = () => {
    fields.push(field);
    if (fields.some((value) => value.trim() !== '')) rawRows.push({ line: rowLine, fields });
    fields = [];
    field = '';
    rowLine = line + 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
        if (char === '\n') line += 1;
      }
    } else if (char === '"') {
      if (field.length > 0) throw new ValidationFailedException(`Malformed quote on CSV line ${line}`);
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else if (char === '\n') {
      pushRow();
      line += 1;
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (inQuotes) throw new ValidationFailedException(`Unterminated quoted field beginning on CSV line ${rowLine}`);
  if (field !== '' || fields.length > 0) pushRow();

  const headerRow = rawRows.shift();
  if (!headerRow) throw new ValidationFailedException('The CSV needs a header row');
  const headers = headerRow.fields.map(canonicalHeader);
  if (headers.some((header) => !header)) throw new ValidationFailedException('CSV headers cannot be blank');
  if (new Set(headers).size !== headers.length) throw new ValidationFailedException('CSV headers must be unique');
  if (!headers.some((header) => NAME_HEADERS.has(header))) {
    throw new ValidationFailedException('The CSV needs a fullName column');
  }
  if (!headers.some((header) => IDENTITY_HEADERS.has(header))) {
    throw new ValidationFailedException('The CSV needs a phone or email column');
  }
  if (rawRows.length === 0) throw new ValidationFailedException('The CSV contained no data rows');
  if (rawRows.length > MAX_CONTACT_IMPORT_ROWS) {
    throw new ValidationFailedException(`An import is limited to ${MAX_CONTACT_IMPORT_ROWS} rows`, {
      rows: rawRows.length,
      limit: MAX_CONTACT_IMPORT_ROWS,
    });
  }

  return {
    headers,
    rows: rawRows.map(({ line: rowNumber, fields: rowFields }) => {
      if (rowFields.length > headers.length) {
        return { line: rowNumber, values: {}, error: `row has ${rowFields.length} columns; expected ${headers.length}` };
      }
      const values: Record<string, string> = {};
      headers.forEach((header, index) => {
        values[header] = (rowFields[index] ?? '').trim();
      });
      return { line: rowNumber, values };
    }),
  };
}

/** Neutralise spreadsheet formula execution, then apply CSV quoting. */
export function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
