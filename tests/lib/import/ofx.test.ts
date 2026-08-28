import { describe, it, expect } from 'vitest';
import { parseOfx, looksLikeOfx } from '@/lib/import/ofx';

/** OFX 1.x: SGML, no closing tags on leaves, a colon-delimited header block before <OFX>. */
const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>CAD
<BANKACCTFROM><BANKID>000000000<ACCTID>0000000<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260801<DTEND>20260831
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260803120000<TRNAMT>-42.10<FITID>FIT-0001<NAME>GROCERY STORE</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260812120000<TRNAMT>-180.00<FITID>FIT-0002<NAME>CITY TAX OFFICE<MEMO>installment</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260815120000<TRNAMT>2100.00<FITID>FIT-0003<NAME>PAYROLL DEPOSIT</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

/** OFX 2.x: well-formed XML, every leaf closed, an XML declaration and an <?OFX?> processing instruction. */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <BANKMSGSRSV1><STMTTRNRS><STMTRS>
    <CURDEF>CAD</CURDEF>
    <BANKACCTFROM><BANKID>000000000</BANKID><ACCTID>0000000</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
    <BANKTRANLIST>
      <DTSTART>20260801</DTSTART><DTEND>20260831</DTEND>
      <STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260803120000</DTPOSTED><TRNAMT>-42.10</TRNAMT><FITID>FIT-0001</FITID><NAME>GROCERY STORE</NAME></STMTTRN>
      <STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260812120000</DTPOSTED><TRNAMT>-180.00</TRNAMT><FITID>FIT-0002</FITID><NAME>CITY TAX OFFICE</NAME><MEMO>installment</MEMO></STMTTRN>
      <STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260815120000</DTPOSTED><TRNAMT>2100.00</TRNAMT><FITID>FIT-0003</FITID><NAME>PAYROLL DEPOSIT</NAME></STMTTRN>
    </BANKTRANLIST>
  </STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe('parseOfx (ruling R9)', () => {
  it('reads the SGML dialect', () => {
    const result = parseOfx(Buffer.from(SGML, 'utf8'));
    expect(result.dialect).toBe('sgml');
    expect(result.currency).toBe('CAD');
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      rawDate: '20260803',
      date: '2026-08-03',
      rawDescription: 'GROCERY STORE',
      amountCents: -4210,
      externalId: 'FIT-0001',
      balanceCents: null,
    });
    expect(result.rows[2]?.amountCents).toBe(210000);
  });

  it('reads the XML dialect to the same rows', () => {
    const sgml = parseOfx(Buffer.from(SGML, 'utf8'));
    const xml = parseOfx(Buffer.from(XML, 'utf8'));
    expect(xml.dialect).toBe('xml');
    expect(xml.rows.map(({ rowIndex, cells, ...rest }) => rest))
      .toEqual(sgml.rows.map(({ rowIndex, cells, ...rest }) => rest));
  });

  it('joins NAME and MEMO when both are present', () => {
    expect(parseOfx(Buffer.from(SGML, 'utf8')).rows[1]?.rawDescription).toBe('CITY TAX OFFICE installment');
  });

  it('detects the date order from the first and last parsed row', () => {
    expect(parseOfx(Buffer.from(SGML, 'utf8')).dateOrder).toBe('oldest_first');
  });

  it('returns no rows and does not throw for a file with no transactions', () => {
    const empty = SGML.replace(/<STMTTRN>[\s\S]*?<\/STMTTRN>\n?/g, '');
    const result = parseOfx(Buffer.from(empty, 'utf8'));
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('reports a transaction with an unreadable date as a row error, not a throw', () => {
    const broken = SGML.replace('<DTPOSTED>20260803120000', '<DTPOSTED>not-a-date');
    const result = parseOfx(Buffer.from(broken, 'utf8'));
    expect(result.rows).toHaveLength(2);
    expect(result.errors[0]?.reason).toBe('unparseable date');
  });

  it('looksLikeOfx keys on the extension and on the OFX marker, never on the extension alone', () => {
    expect(looksLikeOfx('statement.ofx', Buffer.from(SGML, 'utf8'))).toBe(true);
    expect(looksLikeOfx('statement.qfx', Buffer.from(XML, 'utf8'))).toBe(true);
    expect(looksLikeOfx('statement.csv', Buffer.from('a,b,c\n1,2,3', 'utf8'))).toBe(false);
    expect(looksLikeOfx('statement.ofx', Buffer.from('a,b,c\n1,2,3', 'utf8'))).toBe(false);
  });
});
