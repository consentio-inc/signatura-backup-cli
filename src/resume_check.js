import { StateDb } from './state_db.js';

/**
 * Whether the run saved in a folder belongs to the workspace the key opens.
 *
 * Nothing on disk names the workspace (the API has no /me, and the key's JWT
 * identifies the key, not the workspace), so the archive itself is the
 * fingerprint: under the run's pinned `created_before`, page 1 of the listing
 * is stable, and a run that got anywhere has those ids stored. If the server
 * lists documents and not one of them is known, the key opens another
 * workspace and resuming would mark every stored document as failed.
 *
 * Deliberately lenient: a run that stored no documents yet (interrupted
 * before page 1 landed) and an empty workspace both resume; a deleted newest
 * document still leaves other known ids on page 1.
 *
 * Returns true when resuming is safe. Throws API errors for the caller to
 * describe.
 */
export async function resumeMatchesWorkspace({ client, destinationRoot }) {
  const db = StateDb.openIn(destinationRoot);
  let createdBeforeIso;
  let stored;
  try {
    createdBeforeIso = db.run.createdBeforeIso;
    stored = db.counts().documentsListed;
    if (stored === 0) return true;
    const page = await client.listDocuments({ page: 1, createdBeforeIso });
    if (page.items.length === 0) return false;
    return db.countKnownDocuments(page.items.map((d) => d.id)) > 0;
  } finally {
    db.close();
  }
}
