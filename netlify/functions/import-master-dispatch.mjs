import { importAllDispatches } from './_dispatch-import.mjs';

export default async () => {
  const results = await importAllDispatches();
  return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json' } });
};

// Netlify cron uses UTC. Running at both offsets keeps the 9:40 AM Toronto
// import working across daylight-saving changes; duplicate emails are skipped.
export const config = { schedule: '40 13,14 * * 1-5' };
