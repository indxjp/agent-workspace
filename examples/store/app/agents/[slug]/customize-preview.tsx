'use client';
/**
 * The "Install & customize" tab: the controls the entry offers and the preview they draw, which
 * changes as a visitor types. It ends with "Talk to us about this setup", which opens the enquiry
 * form with the entry and the chosen setup filled in.
 */
import { useState } from 'react';

import { entryView, type CatalogEntry, type CustomizeControl } from '../../../catalog/index.ts';
import {
  choicesOf,
  controlName,
  defaultSetup,
  enquiryHref,
  previewOf,
  SETUP_VALUE_MAX,
  type Setup,
} from '../../customize';
import { pick, type Lang } from '../../lang';
import { tr } from '../../text';

export function CustomizePreview({
  entry,
  lang,
}: {
  readonly entry: CatalogEntry;
  readonly lang: Lang;
}) {
  const t = tr(lang);
  const [setup, setSetup] = useState<Setup>(() => defaultSetup(entry, lang));
  const preview = previewOf(entry, setup, lang);
  const change = (control: CustomizeControl, value: string) => {
    setSetup((current) => ({ ...current, [control]: value }));
  };
  return (
    <div className="store-customize">
      <form
        className="aw-app-form"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        {entryView(entry).customize.map((control) => {
          const choices = choicesOf(entry, control);
          return (
            <label key={control} className="aw-app-field">
              <span className="aw-app-label">{controlName(control, lang)}</span>
              {choices === null ? (
                <input
                  type="text"
                  name={control}
                  maxLength={SETUP_VALUE_MAX}
                  value={setup[control] ?? ''}
                  onChange={(event) => {
                    change(control, event.target.value);
                  }}
                />
              ) : (
                <select
                  name={control}
                  value={setup[control] ?? ''}
                  onChange={(event) => {
                    change(control, event.target.value);
                  }}
                >
                  {choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {pick(choice.label, lang)}
                    </option>
                  ))}
                </select>
              )}
            </label>
          );
        })}
      </form>
      <section
        aria-labelledby="preview-title"
        className="aw-app-card"
        data-testid="customize-preview"
      >
        <h3 id="preview-title">{t('プレビュー', 'Preview')}</h3>
        <p data-testid="preview-reply">{preview.reply}</p>
        <dl>
          {preview.facts.map((fact) => (
            <div key={fact.name.en}>
              <dt>{pick(fact.name, lang)}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <p>
        <a className="aw-app-button aw-app-primary" href={enquiryHref(entry, setup)}>
          {t('この内容で相談する', 'Talk to us about this setup')}
        </a>
      </p>
    </div>
  );
}
