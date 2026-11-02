import pdf from 'pdf-parse';
import { admin, env } from './_shared.mjs';

// Payment remittances are deliberately kept separate from Master Dispatch.
// Importing one only creates a review entry; it never changes a job status or
// marks a work order as paid.
const PAYMENT_SENDER = 'dhara@golime.com';

const gmailToken = async (refreshToken) => {
  const body = new URLSearchParams({
    client_id: env('GMAIL_CLIENT_ID'),
    client_secret: env('GMAIL_CLIENT_SECRET'),
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'Could not refresh Gmail access. Reconnect Gmail and try again.');
  return data.access_token;
};

const allParts = (node) => [node, ...(node?.parts || []).flatMap(allParts)];
const decode = (value) => Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const header = (email, name) => (email?.payload?.headers || []).find(item => String(item.name).toLowerCase() === name.toLowerCase())?.value || '';
const money = (value) => Number(String(value || '').replace(/[$,]/g, '')) || 0;
const workOrder = (value) => String(value || '').match(/\d{5,}/)?.[0] || '';

function parsePaymentPdf(buffer, fileName, messageId, receivedAt) {
  return pdf(buffer).then(({ text: rawText }) => {
    const text = String(rawText || '').replace(/\r/g, '');
    // A legitimate remittance has both payment language and at least one work
    // order. This prevents an unrelated attachment from reaching Payments.
    if (!/(?:invoice|remittance|payment)/i.test(text) || !/WO\s*[-#:]?\s*\d{5,}/i.test(text)) return null;
    // Dhara's remittances reuse the same attachment filename.  Never use that
    // filename as the invoice identity, otherwise the first import makes every
    // later weekly remittance look like a duplicate.
    const printedInvoice = text.match(/INVOICE\s*(?:#|NO\.?|NUMBER)?\s*[:#]?\s*([A-Z0-9-]+)/i)?.[1];
    const fallbackInvoice = `remittance-${String(receivedAt || '').slice(0, 10) || 'undated'}-${String(messageId || '').slice(-8)}`;
    const invoiceNumber = printedInvoice || fallbackInvoice;
    const invoiceDate = text.match(/DATE\s*[:#]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/i)?.[1] || '';
    const week = text.match(/Week\s*\d+\s*\([^\n)]+\)/i)?.[0] || '';
    const datePattern = '((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+\\d{1,2},\\s+\\d{4})';
    // GoLime's exported invoice sometimes leaves Price or Extra blank, and it
    // can wrap equipment under the preceding work order. Read a row from its
    // date/work-order anchor and use the final monetary value as the paid
    // total. This handles one-, two-, and three-column amount rows alike.
    const rowStart = new RegExp(`${datePattern}\\s+(WO\\s*[-#:]?\\s*\\d{5,})\\s*([\\s\\S]*?)(?=${datePattern}\\s+WO\\s*[-#:]?\\s*\\d{5,}|(?:SUBTOTAL|HST|TOTAL)\\b|$)`, 'gi');
    const moneyPattern = /-?\d{1,3}(?:,\d{3})*\.\d{2}/g;
    const rows = [];
    for (const match of text.matchAll(rowStart)) {
      const parsedDate = new Date(match[1]);
      rows.push({
        workOrder: `WO-${workOrder(match[2])}`,
        date: Number.isNaN(parsedDate.getTime()) ? '' : parsedDate.toISOString().slice(0, 10),
        details: String(match[3] || '').replace(/\s+/g, ' ').trim()
      });
    }
    const lines = rows.map(row => {
      const values = [...row.details.matchAll(moneyPattern)].map(match => money(match[0]));
      const amount = values.at(-1) || 0;
      const extra = values.length >= 3 ? values.at(-2) : (values.length === 2 ? values[0] : 0);
      const price = values.length >= 3 ? values.at(-3) : amount - extra;
      const description = row.details.replace(moneyPattern, '').replace(/\s+/g, ' ').trim() || 'GoLime payment';
      return { workOrder: row.workOrder, date: row.date, description, price, extra, amount, kind: /travel/i.test(description) ? 'travel' : /extra|labor/i.test(description) ? 'extra' : 'job' };
    }).filter(line => workOrder(line.workOrder) && line.amount !== 0);
    if (!lines.length) return null;
    return {
      id: `gmail-payment-${messageId}`,
      gmailMessageId: messageId,
      source: 'gmail',
      sender: PAYMENT_SENDER,
      receivedAt,
      invoiceNumber,
      invoiceDate,
      week,
      total: money(text.match(/TOTAL\s*\$?\s*([\d,]+\.\d{2})/i)?.[1]),
      lines,
      results: [],
      comparisonReady: false,
      fileName,
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  });
}

async function emailAndAttachment(token, messageId) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, { headers: { authorization: `Bearer ${token}` } });
  const email = await response.json();
  if (!response.ok) throw new Error(email.error?.message || 'Could not open a GoLime payment email.');
  const from = header(email, 'from').toLowerCase();
  if (!from.includes(PAYMENT_SENDER)) return null;
  const attachment = allParts(email.payload).find(part =>
    part.body?.attachmentId && (String(part.mimeType || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(part.filename || ''))
  );
  if (!attachment) return null;
  const rawResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachment.body.attachmentId}`, { headers: { authorization: `Bearer ${token}` } });
  const raw = await rawResponse.json();
  if (!rawResponse.ok) throw new Error(raw.error?.message || 'Could not download a GoLime payment PDF.');
  return {
    messageId,
    receivedAt: email.internalDate ? new Date(Number(email.internalDate)).toISOString() : new Date().toISOString(),
    fileName: attachment.filename,
    buffer: decode(raw.data)
  };
}

export async function importPaymentInvoices(integration) {
  const client = admin();
  const { data: ledger, error: ledgerError } = await client.from('payment_ledgers').select('invoices,followups').eq('company_id', integration.company_id).maybeSingle();
  if (ledgerError) throw new Error(ledgerError.code === '42P01' ? 'Payment ledger setup is required before GoLime payment emails can import.' : ledgerError.message);
  const existing = Array.isArray(ledger?.invoices) ? ledger.invoices : [];
  const seenMessages = new Set(existing.map(item => String(item?.gmailMessageId || '')).filter(Boolean));
  const token = await gmailToken(integration.refresh_token);
  // Do not require filename:pdf here.  Gmail occasionally indexes the same
  // remittance as application/pdf without exposing a filename search hit.
  const query = `from:${PAYMENT_SENDER} has:attachment`;
  // Gmail permits 500 results per search page. Payment notices are low-volume,
  // so this brings in the full practical history without touching unrelated mail.
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&q=${encodeURIComponent(query)}`, { headers: { authorization: `Bearer ${token}` } });
  const list = await response.json();
  if (!response.ok) throw new Error(list.error?.message || 'Could not search GoLime payment emails.');
  let checked = 0, skipped = 0, unreadable = 0, failures = 0;
  const imported = [];
  for (const message of list.messages || []) {
    if (seenMessages.has(message.id)) { skipped++; continue; }
    try {
      const attachment = await emailAndAttachment(token, message.id);
      if (!attachment) { skipped++; continue; }
      checked++;
      const invoice = await parsePaymentPdf(attachment.buffer, attachment.fileName, attachment.messageId, attachment.receivedAt);
      if (!invoice) { unreadable++; continue; }
      imported.push(invoice);
      seenMessages.add(message.id);
    } catch (error) {
      console.error('Payment email was skipped:', message.id, error.message);
      failures++;
    }
  }
  if (imported.length) {
    const { error } = await client.from('payment_ledgers').upsert({
      company_id: integration.company_id,
      invoices: [...imported, ...existing],
      followups: Array.isArray(ledger?.followups) ? ledger.followups : [],
      updated_at: new Date().toISOString(),
      updated_by: integration.connected_by
    }, { onConflict: 'company_id' });
    if (error) throw new Error(error.message || 'Could not save the GoLime payment invoice.');
  }
  return {
    imported: imported.length,
    checked,
    skipped,
    unreadable,
    failures,
    invoices: imported,
    message: imported.length
      ? `Imported ${imported.length} GoLime payment invoice${imported.length === 1 ? '' : 's'} from Dhara Patel. Review the matches before sending a follow-up.`
      : `No new GoLime payment invoices were saved. Checked ${checked} new email${checked === 1 ? '' : 's'}; ${unreadable} attachment${unreadable === 1 ? '' : 's'} could not be read and ${failures} email${failures === 1 ? '' : 's'} failed. Reconnect Gmail only if an error is shown.`
  };
}

export async function importCompanyPaymentInvoices(companyId) {
  const { data: integration, error } = await admin().from('gmail_integrations').select('*').eq('company_id', companyId).maybeSingle();
  if (error) throw error;
  if (!integration) throw new Error('No Gmail mailbox is connected yet. Use Connect Gmail first.');
  return importPaymentInvoices(integration);
}

export async function importAllPaymentInvoices() {
  const { data: integrations, error } = await admin().from('gmail_integrations').select('*');
  if (error) throw error;
  const results = [];
  for (const integration of integrations || []) {
    try { results.push({ companyId: integration.company_id, ...(await importPaymentInvoices(integration)) }); }
    catch (error) { console.error('GoLime payment import failed:', error.message); results.push({ companyId: integration.company_id, error: error.message }); }
  }
  return results;
}
