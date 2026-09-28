'use client';

import { importProductsAction } from './actions';
import { ActionForm, Submit } from './ui';

export type ImportCandidate = {
  slug: string;
  name: string;
  pitch: string | null;
  stage: string;
  /** Past the design document: ticked by default. */
  active: boolean;
};

/**
 * Tracker products that are not on the board yet. One submit adds the ticked
 * ones as projects, named from their epics; copy, image and links are edited
 * afterwards like any other project.
 */
export function ImportPanel({ candidates }: { candidates: ImportCandidate[] }) {
  if (candidates.length === 0) return null;
  const active = candidates.filter((c) => c.active).length;

  return (
    <section className="manage-section">
      <div className="manage-section-head">
        <h2>Not on the board yet</h2>
        <span className="manage-sub">
          {candidates.length} in the tracker, {active} past the design stage
        </span>
      </div>

      <ActionForm action={importProductsAction} className="manage-form">
        <ul className="manage-list manage-import">
          {candidates.map((c) => (
            <li key={c.slug}>
              <label className="manage-row manage-import-row">
                <input type="checkbox" name="slug" value={c.slug} defaultChecked={c.active} />
                <span className="manage-row-main">
                  <span className="manage-row-name">{c.name}</span>
                  {c.pitch && <span className="manage-row-desc">{c.pitch}</span>}
                </span>
                <span className="manage-row-actions">
                  <span className="manage-badge manage-badge-linked">
                    {c.slug} · {c.stage}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="manage-dialog-foot">
          <Submit label="Add ticked products" pendingLabel="Adding…" />
        </div>
      </ActionForm>
    </section>
  );
}
