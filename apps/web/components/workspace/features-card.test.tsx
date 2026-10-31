import {
  FEATURE_IDS,
  type FeatureId,
  type WorkspaceFeatures,
} from '@indx-workspace/contracts/features';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { FeaturesCard, FeaturesList } from './features-card';
import { FeaturesConfirmDialog } from './features-confirm-dialog';
import { featuresStrings } from './features-messages';

/**
 * The card's markup, one state at a time. Focus, the dialog's keyboard contract, and the save and
 * refresh are effects a static render cannot run; `tests/browser/workspace-features.spec.mjs`
 * covers them.
 */
const en = featuresStrings('en');
const ja = featuresStrings('ja');

function features(notInstalled: readonly FeatureId[] = []): WorkspaceFeatures {
  return {
    features: FEATURE_IDS.map((id) => ({
      id,
      installed: !notInstalled.includes(id),
      enabled: !notInstalled.includes(id),
    })),
  };
}

function list(readOnly: boolean, state = features()): string {
  return renderToStaticMarkup(<FeaturesList features={state} strings={en} readOnly={readOnly} />);
}

/** The `<button role="switch">` of one feature, as markup. */
function toggleOf(html: string, id: FeatureId): string {
  const match = new RegExp(`<button[^>]*data-feature="${id}"[^>]*>`, 'u').exec(html);
  if (match === null) throw new Error(`no toggle for ${id}`);
  return match[0];
}

describe('FeaturesList', () => {
  it('renders one row and one switch per feature, eleven in all', () => {
    const html = list(false);
    expect(html.match(/data-feature-row=/gu)).toHaveLength(FEATURE_IDS.length);
    expect(html.match(/role="switch"/gu)).toHaveLength(11);
    expect(html).toContain('aria-label="Features of this workspace"');
    for (const id of FEATURE_IDS) expect(html).toContain(`>${en.labels[id]}</span>`);
  });

  it('disables the Runs switch with its reason, tied to it by aria-describedby', () => {
    const html = list(false);
    const runs = toggleOf(html, 'runs');
    expect(runs).toContain('aria-disabled="true"');
    expect(runs).toContain('aria-checked="true"');
    expect(runs).toContain('aria-describedby="feature-runs-reason"');
    expect(html).toContain('id="feature-runs-reason"');
    expect(html).toContain('Needed by Evaluations, Triggers');
    expect(html).toContain('Needed by: Evaluations, Triggers');
  });

  it('disables the Chat switch while Surfaces is on, naming Surfaces', () => {
    const html = list(false);
    expect(toggleOf(html, 'chat')).toContain('aria-disabled="true"');
    expect(html).toMatch(/id="feature-chat-reason"[^>]*>Needed by Surfaces</u);
    expect(html).toContain('Needs: Chat');
  });

  it('leaves a free switch enabled, and shows a not-installed feature off and disabled', () => {
    const html = list(false, features(['builder']));
    expect(toggleOf(html, 'files')).not.toContain('aria-disabled');
    expect(toggleOf(html, 'files')).not.toContain('aria-describedby');
    const builder = toggleOf(html, 'builder');
    expect(builder).toContain('aria-checked="false"');
    expect(builder).toContain('aria-disabled="true"');
    expect(html).toContain('Not installed in this deployment');
  });

  it('is read-only for anyone but an Owner', () => {
    const html = list(true);
    expect(html).toContain('Only a workspace Owner can change these.');
    for (const id of FEATURE_IDS) expect(toggleOf(html, id)).toContain('aria-disabled="true"');
  });

  it('shows a refusal in an alert region, in the words given', () => {
    const html = renderToStaticMarkup(
      <FeaturesList
        features={features()}
        strings={en}
        readOnly={false}
        banner={en.refusals.feature_in_use}
      />,
    );
    expect(html).toMatch(/role="alert"[^>]*><p[^>]*>Another feature that is on needs this one/u);
  });

  it('speaks Japanese', () => {
    const html = renderToStaticMarkup(
      <FeaturesList features={features()} strings={ja} readOnly={false} />,
    );
    expect(html).toContain('評価、トリガー が必要としています');
  });
});

describe('FeaturesCard', () => {
  it('is the #features section of Settings, loading until the list answers', () => {
    const html = renderToStaticMarkup(
      <FeaturesCard workspaceId="ws-a" isOwner={true} locale="en" />,
    );
    expect(html).toContain('id="features"');
    expect(html).toContain('aria-labelledby="workspace-features-heading"');
    expect(html).toContain('>Features</h2>');
    expect(html).toContain('Loading features…');
  });
});

describe('FeaturesConfirmDialog', () => {
  const noop = () => undefined;

  function dialog(feature: FeatureId, failure: string | null = null): string {
    return renderToStaticMarkup(
      <FeaturesConfirmDialog
        feature={feature}
        strings={en}
        busy={false}
        failure={failure}
        onCancel={noop}
        onConfirm={noop}
      />,
    );
  }

  it('is a labelled modal dialog that names the feature and the entries that disappear', () => {
    const html = dialog('files');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="features-confirm-dialog-title"');
    expect(html).toContain('Switch Files off?');
    expect(html).toContain(
      'These navigation entries disappear for everyone in this workspace: Files.',
    );
    expect(html).toContain('Data is kept.');
    expect(html).toContain('>Switch Files off</button>');
    expect(html).toContain('>Cancel</button>');
  });

  it('names Shared links for sharing, and says so when no entry disappears', () => {
    expect(dialog('sharing')).toContain('in this workspace: Shared links.');
    expect(dialog('builder')).toContain('No navigation entry disappears.');
    expect(dialog('builder')).toContain('Data is kept.');
  });

  it('shows a failed save as an alert', () => {
    expect(dialog('files', en.unavailable)).toMatch(/role="alert">The change could not be saved/u);
  });
});
