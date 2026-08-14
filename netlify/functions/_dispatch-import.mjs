import pdf from 'pdf-parse';
import { admin, env, parseDispatch } from './_shared.mjs';

const gmailToken = async (refreshToken) => {
  const body = new URLSearchParams({ client_id: env('GMAIL_CLIENT_ID'), client_secret: env('GMAIL_CLIENT_SECRET'), refresh_token: refreshToken, grant_type: 'refresh_token' });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'Could not refresh Gmail access. Reconnect Gmail and try again.');
  return data.access_token;
};

const parts = (node) => [node, ...(node.parts || []).flatMap(parts)];
const decode = (value) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const torontoToday = () => {
  const fields = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
  return [fields.year, fields.month, fields.day].join('-');
};

async function importMessage(integration, token, messageId) {
  const emailResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, { headers: { authorization: `Bearer ${token}` } });
  const email = await emailResponse.json();
  if (!emailResponse.ok) throw new Error(email.error?.message || 'Could not open the dispatch email.');
  const attachment = parts(email.payload).find(part => part.filename?.toLowerCase().endsWith('.pdf') && part.body?.attachmentId);
  if (!attachment) return { imported: 0, updated: 0 };
  const rawResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachment.body.attachmentId}`, { headers: { authorization: `Bearer ${token}` } });
  const raw = await rawResponse.json();
  if (!rawResponse.ok) throw new Error(raw.error?.message || 'Could not download the dispatch PDF.');
  const dispatchText = (await pdf(decode(raw.data))).text;
  if (!/Master\s+Dispatch\s+Schedule/i.test(dispatchText)) return { imported: 0, updated: 0, found: 0, ignored: 0, notDispatch: true };
  const allExtracted = parseDispatch(dispatchText);
  // A dispatch for today's work must still be imported after midnight. Older
  // dispatches are used only to repair missing details on existing records.
  const extracted = allExtracted.filter(job => job.date >= torontoToday());
  // Old and same-day dispatches cannot create new jobs, but they can safely
  // fill missing address, phone, time, equipment, and meeting details.
  const client = admin();
  const { data: existing, error: readError } = await client.from('jobs').select('id,work_order,address,phone,equipment,work_type,customer_name,appointment_start,appointment_end,notes').eq('company_id', integration.company_id);
  if (readError) throw readError;
  const workOrderKey = value => String(value || '').match(/\d{5,}/)?.[0] || String(value || '').trim();
  const missing = value => !String(value || '').trim() || /^(?:-|n\/?a|address not available)$/i.test(String(value).trim());
  // A prior version could create duplicate cloud records for one work order.
  // Keep every matching record here so a dispatch can repair all of them.
  const existingByWorkOrder = new Map();
  for (const record of existing || []) { const key = workOrderKey(record.work_order); existingByWorkOrder.set(key, [...(existingByWorkOrder.get(key) || []), record]); }
  const savedFor = job => existingByWorkOrder.get(workOrderKey(job.workOrder)) || [];
  const importedRecords = extracted.filter(job => !savedFor(job).length);
  const fresh = importedRecords.map(job => ({ company_id: integration.company_id, created_by: integration.connected_by, source: job.source, work_order: job.workOrder, job_date: job.date, status: job.status, work_type: job.workType, customer_name: job.customer, phone: job.phone || null, address: job.address || null, equipment: job.equipment || null, notes: job.notes, extras: [], appointment_start: job.appointmentStart, appointment_end: job.appointmentEnd }));
  if (fresh.length) { const { error } = await client.from('jobs').insert(fresh); if (error) throw error; }
  const repairs = allExtracted.flatMap(job => savedFor(job).map(existing => ({ job, existing }))).filter(({ job, existing }) => { const imported = /^Imported automatically from GoLime Master Dispatch\./i.test(existing?.notes || ''); return imported && job.address || missing(existing.address) && job.address || missing(existing.phone) && job.phone || missing(existing.equipment) && job.equipment || !existing.appointment_start && job.appointmentStart || !existing.appointment_end && job.appointmentEnd || job.workType === 'Meeting' && existing.work_type !== 'Meeting' });
  for (const { job, existing: saved } of repairs) {
    const update = {};
    const imported = /^Imported automatically from GoLime Master Dispatch\./i.test(saved.notes || '');
    if ((imported || missing(saved.address)) && job.address) update.address = job.address;
    if ((imported || missing(saved.phone)) && job.phone) update.phone = job.phone;
    if ((imported || missing(saved.equipment)) && job.equipment) update.equipment = job.equipment;
    if (!saved.appointment_start && job.appointmentStart) update.appointment_start = job.appointmentStart;
    if (!saved.appointment_end && job.appointmentEnd) update.appointment_end = job.appointmentEnd;
    if (job.workType === 'Meeting' && saved.work_type !== 'Meeting') { update.work_type = 'Meeting'; update.customer_name = 'GoLime meeting'; }
    if (Object.keys(update).length) { const { error } = await client.from('jobs').update(update).eq('id', saved.id); if (error) throw error; }
  }
  // Gmail is intentionally add-only. It must never move, edit, or overwrite
  // a job the team has already saved in the field app.
  // Return every current/future record, not only newly inserted ones. The app
  // uses these details to immediately repair an older phone-only card with the
  // same work order, while preserving its photos and extras.
  return { imported: fresh.length, updated: repairs.length, found: extracted.length, existing: extracted.length - fresh.length, ignored: allExtracted.length - extracted.length, records: extracted };
}

export async function importIntegration(integration) {
  const token = await gmailToken(integration.refresh_token);
  // Search recent PDFs broadly, then confirm the PDF itself is a GoLime Master
  // Dispatch. This is safer than depending on an email subject that can vary.
  const query = 'has:attachment filename:pdf newer_than:30d';
  const listResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30&q='+encodeURIComponent(query), { headers: { authorization: 'Bearer '+token } });
  const list = await listResponse.json(); if (!listResponse.ok) throw new Error(list.error?.message || 'Could not search Gmail.');
  const messages = list.messages || []; if (!messages.length) return { imported: 0, updated: 0, skipped: true, message: 'No matching Master Dispatch email was found.' };
  let imported = 0, updated = 0, found = 0, existing = 0, ignored = 0, checked = 0, selectedMessage = null, records = [];
  for (const message of messages) {
    try {
      const result = await importMessage(integration, token, message.id);
      if (result.notDispatch) continue;
      checked++;
      ignored += result.ignored || 0;
      updated += result.updated || 0;
      if (!result.found) continue;
      imported += result.imported || 0;
      found += result.found || 0;
      existing += result.existing || 0;
      records.push(...(result.records || []));
      selectedMessage ||= message;
    } catch (error) { console.error('Dispatch message import failed:', message.id, error); }
  }
  const { error: updateError } = await admin().from('gmail_integrations').update({ last_message_id: selectedMessage?.id || messages[0].id, last_import_at: new Date().toISOString() }).eq('company_id', integration.company_id);
  if (updateError) throw updateError;
  const parts = []; if (checked) parts.push('Checked '+checked+' Master Dispatch PDF'+(checked === 1 ? '' : 's')+'.'); if (found) parts.push('Next dispatch contains '+found+' future job'+(found === 1 ? '' : 's')+'.'); if (imported) parts.push('Imported '+imported+' new job'+(imported === 1 ? '' : 's')+'.'); if (updated) parts.push('Updated '+updated+' existing job'+(updated === 1 ? '' : 's')+' with missing dispatch details.'); if (existing) parts.push(existing+' existing work order'+(existing === 1 ? ' was' : 's were')+' left unchanged.'); if (ignored) parts.push('Skipped '+ignored+' job'+(ignored === 1 ? '' : 's')+' dated today or earlier.');
  return { imported, updated, records, skipped: !imported && !updated, message: parts.join(' ') || 'No dispatch jobs were found.' };
}
export async function importCompanyDispatch(companyId) {
  const { data: integration, error } = await admin().from('gmail_integrations').select('*').eq('company_id', companyId).maybeSingle();
  if (error) throw error;
  if (!integration) throw new Error('No Gmail mailbox is connected yet. Use Connect Gmail first.');
  return importIntegration(integration);
}

export async function importAllDispatches() {
  const { data: integrations, error } = await admin().from('gmail_integrations').select('*');
  if (error) throw error;
  const results = [];
  for (const integration of integrations || []) {
    try { results.push({ companyId: integration.company_id, ...(await importIntegration(integration)) }); }
    catch (error) { console.error(`Dispatch import failed for ${integration.company_id}:`, error); results.push({ companyId: integration.company_id, error: error.message }); }
  }
  return results;
}
