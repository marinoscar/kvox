import { DEFAULT_GRAPH_CALIBRATION, resolveGraphCalibration } from './graph-calibration.js';

describe('resolveGraphCalibration (#681)', () => {
  it('is the OpenAI baseline the graph was tuned with', () => {
    expect(DEFAULT_GRAPH_CALIBRATION).toEqual({ vectorFloor: 0.75, itemCosine: 0.8, itemSameConfidentCosine: 0.92 });
    expect(resolveGraphCalibration()).toEqual(DEFAULT_GRAPH_CALIBRATION);
    expect(resolveGraphCalibration(null)).toEqual(DEFAULT_GRAPH_CALIBRATION);
  });

  it('returns a copy, never the shared frozen default', () => {
    expect(resolveGraphCalibration()).not.toBe(DEFAULT_GRAPH_CALIBRATION);
  });

  it('takes a complete, sane calibration as is', () => {
    const own = { vectorFloor: 0.83, itemCosine: 0.87, itemSameConfidentCosine: 0.95 };
    expect(resolveGraphCalibration(own)).toEqual(own);
  });

  it.each([
    ['a missing field', { vectorFloor: 0.8, itemCosine: 0.8 }],
    ['a value of 1 or more', { vectorFloor: 1, itemCosine: 0.8, itemSameConfidentCosine: 0.9 }],
    ['NaN', { vectorFloor: Number.NaN, itemCosine: 0.8, itemSameConfidentCosine: 0.9 }],
    ['a confident cosine below the candidate cosine', { vectorFloor: 0.8, itemCosine: 0.9, itemSameConfidentCosine: 0.8 }],
  ])('falls back to the baseline on %s', (_label, reported) => {
    expect(resolveGraphCalibration(reported)).toEqual(DEFAULT_GRAPH_CALIBRATION);
  });
});
