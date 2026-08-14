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

async function importMessage(integration, token, messageId, processedWorkOrders = new Set()) {
  const emailResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, { headers: { authorization: `Bearer ${token}` } });
  const email = await emailResponse.json();
  if (!emailResponse.ok) throw new Error(email.error?.message || 'Could not open the dispatch email.');
  const attachment = parts(email.payload).find(part => part.filename?.toLowerCase().endsWith('.pdf') && part.body?.attachmentId);
  if (!attachment) return { imported: 0, updated: 0 };
  const rawResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachment.body.attachmentId}`, { headers: { authorization: `Bearer ${token}` } });
  const raw = await rawResponse.json();
  if (!rawResponse.ok) throw new Error(raw.error?.message || 'Could not download the dispatch PDF.');
  const extracted = parseDispatch((await pdf(decode(raw.data))).text).filter(job => !processedWorkOrders.has(job.workOrder));
  extracted.forEach(job => processedWorkOrders.add(job.workOrder));
  if (!extracted.length) return { imported: 0, updated: 0 };
  const client = admin(), workOrders = extracted.map(job => job.workOrder);
  const { data: existing, error: readError } = await client.from('jobs').select('id,work_order,job_date,address,phone,equipment,appointment_start,appointment_end,work_type').eq('company_id', integration.company_id).in('work_order', workOrders);
  if (readError) throw readError;
  const existingByWorkOrder = new Map((existing || []).map(job => [job.work_order, job]));
  const fresh = extracted.filter(job => !existingByWorkOrder.has(job.workOrder)).map(job => ({ company_id: integration.company_id, created_by: integration.connected_by, source: job.source, work_order: job.workOrder, job_date: job.date, status: job.status, work_type: job.workType, customer_name: job.customer, phone: job.phone || null, address: job.address || null, equipment: job.equipment || null, notes: job.notes, extras: [], appointment_start: job.appointmentStart, appointment_end: job.appointmentEnd }));
  if (fresh.length) { const { error } = await client.from('jobs').insert(fresh); if (error) throw error; }
  // This runs only when a signed-in user presses the Gmail check button.
  // It repairs schedule/contact details without changing field-work records.
  let updated = 0;
  for (const importedJob of extracted) {
    const stored = existingByWorkOrder.get(importedJob.workOrder); if (!stored) continue;
    const patch = {};
    if (importedJob.date && stored.job_date !== importedJob.date) patch.job_date = importedJob.date;
    if (importedJob.appointmentStart && stored.appointment_start !== importedJob.appointmentStart) patch.appointment_start = importedJob.appointmentStart;
    if (importedJob.appointmentEnd && stored.appointment_end !== importedJob.appointmentEnd) patch.appointment_end = importedJob.appointmentEnd;
    if (!stored.address && importedJob.address) patch.address = importedJob.address;
    if (!stored.phone && importedJob.phone) patch.phone = importedJob.phone;
    if (!stored.equipment && importedJob.equipment) patch.equipment = importedJob.equipment;
    if ((!stored.work_type || stored.work_type === 'Custom / Other') && importedJob.workType) patch.work_type = importedJob.workType;
    if (!Object.keys(patch).length) continue;
    const { error } = await client.from('jobs').update(patch).eq('id', stored.id); if (error) throw error; updated++;
  }
  return { imported: fresh.length, updated, found: extracted.length };
}

export async function importIntegration(integration) {
  const token = await gmailToken(integration.refresh_token), query = env('DISPATCH_GMAIL_QUERY');
  // The user starts this scan from Settings. Existing work orders are skipped.
  const listResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(query)}`, { headers: { authorization: `Bearer ${token}` } });
  const list = await listResponse.json(); if (!listResponse.ok) throw new Error(list.error?.message || 'Could not search Gmail.');
  const messages = list.messages || []; if (!messages.length) return { imported: 0, updated: 0, skipped: true, message: 'No matching Master Dispatch email was found.' };
  let imported = 0, updated = 0, found = 0;
  const processedWorkOrders = new Set();
  // Gmail returns newest messages first. Once a work order is found, older
  // dispatch copies are deliberately ignored so they cannot roll it back.
  for (const message of messages) { try { const result = await importMessage(integration, token, message.id, processedWorkOrders); imported += result.imported; updated += result.updated; found += result.found || 0; } catch (error) { console.error('Dispatch message import failed:', message.id, error); } }
  const { error: updateError } = await admin().from('gmail_integrations').update({ last_message_id: messages[0].id, last_import_at: new Date().toISOString() }).eq('company_id', integration.company_id);
  if (updateError) throw updateError;
  const parts = []; if (found) parts.push(`Found ${found} scheduled job${found === 1 ? '' : 's'}.`); if (imported) parts.push(`Imported ${imported} new job${imported === 1 ? '' : 's'}.`); if (updated) parts.push(`Refreshed schedule or missing details on ${updated} existing job${updated === 1 ? '' : 's'}.`);
  return { imported, updated, skipped: !imported && !updated, message: parts.join(' ') || 'The recent Master Dispatch emails are already up to date.' };
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
