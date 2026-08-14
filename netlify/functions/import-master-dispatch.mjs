// Automatic Gmail importing has been disabled. Dispatch PDFs are imported only
// when a signed-in user chooses "Check Gmail for Master Dispatch" in Settings.
export default async () => new Response(JSON.stringify({ disabled: true, message: 'Automatic dispatch importing is disabled. Use Settings to check Gmail manually.' }), { headers: { 'content-type': 'application/json' } });
