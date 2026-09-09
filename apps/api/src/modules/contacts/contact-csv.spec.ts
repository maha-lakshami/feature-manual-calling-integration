import { csvCell, MAX_CONTACT_IMPORT_BYTES, MAX_CONTACT_IMPORT_ROWS, parseContactCsv } from './contact-csv';

describe('contact CSV boundaries', () => {
  it('parses a valid small CSV', () => {
    expect(parseContactCsv('fullName,phone\nAlice,9876543210').rows[0]?.values.fullname).toBe('Alice');
  });

  it('supports quoted commas', () => {
    expect(parseContactCsv('fullName,email\n"Doe, Jane",jane@example.com').rows[0]?.values.fullname).toBe('Doe, Jane');
  });

  it('supports embedded escaped quotes', () => {
    expect(parseContactCsv('fullName,email\n"Jane ""JJ"" Doe",jane@example.com').rows[0]?.values.fullname).toBe('Jane "JJ" Doe');
  });

  it('preserves Unicode and ignores blank rows', () => {
    const parsed = parseContactCsv('\uFEFFfullName,email\nप्रियंका,priya@example.com\n\n');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.values.fullname).toBe('प्रियंका');
  });

  it('rejects malformed unterminated quotes', () => {
    expect(() => parseContactCsv('fullName,email\n"Alice,alice@example.com')).toThrow('Unterminated');
  });

  it('rejects missing and duplicate headers', () => {
    expect(() => parseContactCsv('phone\n9876543210')).toThrow('fullName');
    expect(() => parseContactCsv('fullName,email,email\nAlice,a@b.com,a@b.com')).toThrow('unique');
  });

  it('enforces row and byte limits', () => {
    const rows = Array.from({ length: MAX_CONTACT_IMPORT_ROWS + 1 }, (_, index) => `Name ${index},a${index}@x.test`);
    expect(() => parseContactCsv(`fullName,email\n${rows.join('\n')}`)).toThrow('5000 rows');
    expect(() => parseContactCsv(`fullName,email\n${'x'.repeat(MAX_CONTACT_IMPORT_BYTES)}`)).toThrow('bytes');
  });

  it.each(['=2+2', '+cmd', '-1+1', '@SUM(A1)', '\tformula', '\rformula'])(
    'neutralises formula-leading cell %p',
    (value) => expect(csvCell(value)).toMatch(/^"?'/),
  );

  it('quotes commas, quotes and newlines for export', () => {
    expect(csvCell('Doe, "Jane"\nNext')).toBe('"Doe, ""Jane""\nNext"');
  });
});
