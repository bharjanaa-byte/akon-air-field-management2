import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required server setting: ${name}`);
  return value;
};

export const admin = () => createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false }
});

export async function authenticatedMembership(request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Sign in is required.');
  const response = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error('Your sign-in session has expired.');
  const user = await response.json();
  const { data, error } = await admin().from('company_members')
    .select('company_id, user_id').eq('user_id', user.id).maybeSingle();
  if (error || !data) throw new Error('This account is not part of the Akon Air workspace.');
  return { user, membership: data };
}

const sign = (value) => createHmac('sha256', env('OAUTH_STATE_SECRET')).update(value).digest('base64url');
export function makeState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, createdAt: Date.now() })).toString('base64url');
  return `${body}.${sign(body)}`;
}
export function readState(value) {
  const [body, signature] = String(value || '').split('.');
  if (!body || !signature) throw new Error('Invalid Google connection request.');
  const expected = Buffer.from(sign(body));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error('Invalid Google connection request.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (Date.now() - payload.createdAt > 15 * 60 * 1000) throw new Error('Google connection request expired. Please try again.');
  return payload;
}

export const siteUrl = (request) => process.env.URL || new URL(request.url).origin;
export const callbackUrl = (request) => `${siteUrl(request)}/.netlify/functions/gmail-oauth-callback`;
export const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export function parseDispatch(text) {
  // GoLime's PDF exports columns in reading order.  In that output "WO-" and
  // the numeric work-order code are often separated by the whole job row, so
  // do not assume they are adjacent.
  const source = String(text || '').replace(/\s+/g, ' ').trim().replace(/Meeting\s*\(\s*\d+\s*\)\s+WO-\s*(\d{5,})/gi, 'WO-$1 __MEETING__ ');
  // A dispatch may put the six-digit work order immediately after WO- or in
  // the later External Work Order Number column.  Splitting at every WO-
  // marker supports both layouts and keeps every scheduled job separate.
  const chunks = source.split(/(?=(?:(?:Installation\s+Appointment|Meeting)\s*\(\s*\d+\s*\)\s+)?WO-\s*)/i)
    .filter(part => /WO-\s*/i.test(part));
  const month = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  const isoDate = (value) => {
    const match = value.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
    if (!match) return '';
    const index = month[match[1].toLowerCase()];
    if (index === undefined) return '';
    return `${match[3]}-${String(index + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  };
  const timeStamp = (value) => {
    const day = isoDate(value);
    const clock = value.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!day || !clock) return null;
    let hour = Number(clock[1]) % 12;
    if (clock[3].toUpperCase() === 'PM') hour += 12;
    return `${day}T${String(hour).padStart(2, '0')}:${clock[2]}:00`;
  };
  return chunks.map((segment) => {
    const postal = segment.match(/\b([A-Z]\d[A-Z][ -]?\d[A-Z]\d)\b/i);
    const afterPostal = postal ? segment.slice((postal.index || 0) + postal[0].length) : '';
    const workOrderCode = afterPostal.match(/\b(\d{6})\b/)?.[1] || segment.match(/WO-\s*(\d{5,})/i)?.[1] || '';
    const workOrder = workOrderCode ? `WO-${workOrderCode}` : '';
    const times = [...segment.matchAll(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep(?:t)?|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)/gi)].map(match => match[0]);
    const phoneMatch = segment.match(/\+?1?[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{4}/);
    const phone = phoneMatch ? `+${phoneMatch[0].replace(/\D/g, '').replace(/^1?/, '1')}` : '';
    const phoneAt = phoneMatch ? phoneMatch.index : -1;
    const postalAt = postal?.index ?? -1;
    const address = phoneAt >= 0 && postalAt > phoneAt ? segment.slice(phoneAt + phoneMatch[0].length, postalAt).replace(/\s+/g, ' ').replace(/^[-,:]+|[-,:]+$/g, '').trim() : '';
    // Stop at the numeric work-order column rather than at the notes column.
    // This keeps city names while deliberately ignoring work-order notes.
    const citySource = afterPostal.split(/\b\d{6}\b/)[0].trim();
    const city = citySource.match(/^([A-Z][a-z.]+(?:[ -][A-Z][a-z.]+){0,2})/)?.[1] || '';
    const assetStart = times[1] ? segment.indexOf(times[1]) + times[1].length : (times[0] ? segment.indexOf(times[0]) + times[0].length : 0);
    const equipment = phoneAt > assetStart ? segment.slice(assetStart, phoneAt).trim() : '';
    const isMeeting = /__MEETING__/i.test(segment);
    const warehouseMeeting = /273\s+Bowes\s+R(?:oa)?d/i.test(address);
    const workType = isMeeting ? 'Meeting' : /Air Conditioner/i.test(equipment) ? 'Air Conditioner' : /Tankless/i.test(equipment) ? 'Tankless (Replacement)' : /Furnace|Air Handler/i.test(equipment) ? 'Furnace / Air Handler' : /Water Heater|WHGS|Bradford White|PV50/i.test(equipment) ? 'Conventional Water Heater' : 'Custom / Other';
    return {
      workOrder, date: isoDate(times[0] || ''), appointmentStart: timeStamp(times[0] || ''), appointmentEnd: timeStamp(times[1] || ''),
      source: 'goline', status: 'Assigned', workType, customer: isMeeting ? 'GoLime meeting' : 'GoLime customer', phone,
      address: warehouseMeeting ? 'GoLime Warehouse, 273 Bowes Road, Vaughan, ON L4K 1H8' : [address, city, postal?.[1]?.replace(/\s/g, '').toUpperCase()].filter(Boolean).join(', '), equipment,
      notes: `Imported automatically from GoLime Master Dispatch. Scheduled ${times[0] || ''}${times[1] ? ` to ${times[1]}` : ''}.`, extras: []
    };
  }).filter(job => job.workOrder && job.date);
}
