import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { expect, it } from 'vitest';

import { answerBlock, estimate } from './skills/cost-model/scripts/estimate.mjs';
import { ESTIMATE_SCRIPT, lastJsonBlock, RATES, SPECS } from './quotation.fixture.test-support.ts';

export function defineCostModelCases(): void {
  it('the cost model reproduces the hand-computed prices', () => {
    // SS400 200×100×3.2, 4×φ10, 2 bends, 50 pcs:
    //   64 cm³ × 7.85 = 0.5024 kg × ¥150 ÷ 0.8 = 94.2 → ¥94
    //   (600 + 4π·10 = 725.66 mm) 0.72566 m × ¥80 = 58.05 → ¥58;  2 × ¥40 = ¥80;  ¥6000 ÷ 50 = ¥120
    //   cost ¥352 × 1.25 = ¥440 → unit ¥440, total ¥22,000
    expect(estimate(SPECS.bracket, RATES['SS400'])).toMatchObject({
      perPiece: { material: 94, cutting: 58, bending: 80, setup: 120, cost: 352 },
      unitPrice: 440,
      total: 22000,
      basis: { massKg: 0.502, cuttingLengthM: 0.726, cuttingYenPerMeter: 80 },
    });
    // SUS304 300×150×2, 6×φ6, 4 bends, 30 pcs:
    //   90 cm³ × 7.93 = 0.7137 kg × ¥620 ÷ 0.75 = 589.99 → ¥590
    //   (900 + 6π·6 = 1013.10 mm) × ¥110/m = 111.44 → ¥111;  4 × ¥60 = ¥240;  ¥9000 ÷ 30 = ¥300
    //   cost ¥1,241 × 1.25 = 1551.25 → unit ¥1,560 (10円切り上げ), total ¥46,800
    expect(estimate(SPECS.cover, RATES['SUS304'])).toMatchObject({
      perPiece: { material: 590, cutting: 111, bending: 240, setup: 300, cost: 1241 },
      unitPrice: 1560,
      total: 46800,
    });
    // A5052 120×80×5, 4×φ5.5, no bend, 7 pcs (t5 takes the t6 cutting tier):
    //   48 cm³ × 2.68 = 0.12864 kg × ¥900 ÷ 0.8 = 144.72 → ¥145
    //   (400 + 4π·5.5 = 469.12 mm) × ¥100/m = 46.91 → ¥47;  ¥0;  ¥5000 ÷ 7 = 714.29 → ¥715 (切り上げ)
    //   cost ¥907 × 1.3 = 1179.1 → unit ¥1,180, total ¥8,260
    expect(estimate(SPECS.plate, RATES['A5052'])).toMatchObject({
      perPiece: { material: 145, cutting: 47, bending: 0, setup: 715, cost: 907 },
      unitPrice: 1180,
      total: 8260,
    });

    // Half up at exactly .5, despite floating point: 100×50×2.1 mm at 1 g/cm³ and ¥1000/kg is
    // 10.5 g → ¥10.5 → ¥11.
    const unitRate = {
      ...RATES['SS400'],
      densityGPerCm3: 1,
      pricePerKg: 1000,
      yield: 1,
    };
    const half = { ...SPECS.bracket, lengthMm: 100, widthMm: 50, thicknessMm: 2.1 };
    expect(estimate(half, unitRate).perPiece.material).toBe(11);
  });

  it('the cost model refuses what it cannot price, and its command line prints the breakdown', () => {
    expect(() => estimate({ ...SPECS.bracket, thicknessMm: 16 }, RATES['SS400'])).toThrow(
      /no cutting rate for SS400 t16/u,
    );
    expect(() => estimate(SPECS.bracket, RATES['SUS304'])).toThrow(/rate.material is SUS304/u);
    expect(() => estimate({ ...SPECS.bracket, holeDiameterMm: undefined }, RATES['SS400'])).toThrow(
      /holeDiameterMm/u,
    );
    expect(() => estimate({ ...SPECS.bracket, quantity: 0 }, RATES['SS400'])).toThrow(/quantity/u);

    const run = spawnSync(process.execPath, [ESTIMATE_SCRIPT], {
      input: JSON.stringify({ spec: SPECS.cover, rate: RATES['SUS304'] }),
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      unitPrice: 1560,
      total: 46800,
      taxIncluded: false,
    });

    const refused = spawnSync(process.execPath, [ESTIMATE_SCRIPT], {
      input: JSON.stringify({ spec: { ...SPECS.cover, material: 'SPCC' }, rate: RATES['SUS304'] }),
      encoding: 'utf8',
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('estimate refused: spec.material');
  });

  it('the quote command prints the answer block the eval strings are matched against', () => {
    const quote = (spec: unknown, rate: unknown, ...more: string[]): SpawnSyncReturns<string> =>
      spawnSync(
        process.execPath,
        [
          ESTIMATE_SCRIPT,
          'quote',
          '--spec',
          JSON.stringify(spec),
          '--rate',
          JSON.stringify(rate),
          ...more,
        ],
        { encoding: 'utf8' },
      );

    const none = quote(SPECS.plate, RATES['A5052']);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('類似実績なし');
    expect(none.stdout).toContain('"unitPrice": 1180');
    expect(none.stdout).toBe(`${answerBlock(SPECS.plate, RATES['A5052'])}\n`);
    expect(lastJsonBlock(none.stdout)).toMatchObject({ similarOrders: [] });

    const orders = quote(SPECS.bracket, RATES['SS400'], '--orders', 'SO-2024-0412,SO-2025-0108');
    expect(orders.status).toBe(0);
    expect(orders.stdout).toContain('"unitPrice": 440');
    expect(orders.stdout).not.toContain('類似実績なし');
    expect(lastJsonBlock(orders.stdout)).toMatchObject({
      similarOrders: ['SO-2024-0412', 'SO-2025-0108'],
    });
    // A list written with spaces still names both orders.
    const spaced = quote(SPECS.bracket, RATES['SS400'], '--orders', 'SO-2024-0412, SO-2025-0108');
    expect(lastJsonBlock(spaced.stdout)).toMatchObject({
      similarOrders: ['SO-2024-0412', 'SO-2025-0108'],
    });

    const refused = quote({ ...SPECS.cover, material: 'SPCC' }, RATES['SUS304']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('estimate refused: spec.material');

    expect(
      spawnSync(process.execPath, [ESTIMATE_SCRIPT, 'quote'], { encoding: 'utf8' }).status,
    ).toBe(2);
  });
}
