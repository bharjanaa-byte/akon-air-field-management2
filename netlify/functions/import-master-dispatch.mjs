import { importAllDispatches } from './_dispatch-import.mjs';

export default async () => {
  const results = await importAllDispatches();
  return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json' } });
};

// Netlify cron uses UTC. Running at both offsets keeps the 9:40 AM Toronto
// import working across daylight-saving changes; duplicate emails are skipped.
// Retry during the Toronto workday. Gmail delivery can be late, while the
// importer safely skips a dispatch that has already been processed.
export const config = { schedule: '*/15 13-19 * * 1-5' };
