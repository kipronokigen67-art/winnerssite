import {
    analyzeDigitCondition,
    calculateDigitFrequencies,
    getLastDigit,
    type AnalysisTick,
} from '../analysis-engine';
import { isMarketTickFresh } from '../deriv-market-data';

const ticksForDigits = (digits: number[]): AnalysisTick[] =>
    digits.map((digit, index) => ({ epoch: 1_700_000_000 + index, quote: digit }));

describe('market-analysis statistics', () => {
    it('calculates observed frequencies from the supplied history', () => {
        const ticks = ticksForDigits(Array.from({ length: 100 }, (_, index) => index % 10));

        expect(calculateDigitFrequencies(ticks, 100, 1)).toMatchObject({
            counts: Array(10).fill(10),
            percentages: Array(10).fill(10),
            sampleSize: 100,
            latestDigit: 9,
        });
    });

    it('uses the same valid-tick sample for digit counts and signal validation', () => {
        const ticks = [...ticksForDigits(Array.from({ length: 100 }, (_, index) => index % 10)), {
            epoch: 1_700_000_100,
            quote: 'not-a-quote',
        }];

        expect(calculateDigitFrequencies(ticks, 100, 1).sampleSize).toBe(100);
        expect(analyzeDigitCondition(ticks, 100, 'DIGITMATCH', 5, 1).sampleSize).toBe(100);
    });

    it('returns an empty sample when the requested sample size is zero or invalid', () => {
        const ticks = ticksForDigits([1, 2, 3]);

        expect(calculateDigitFrequencies(ticks, 0)).toMatchObject({
            counts: Array(10).fill(0),
            percentages: Array(10).fill(0),
            sampleSize: 0,
            latestDigit: null,
            sampleStart: null,
            sampleEnd: null,
        });
        expect(calculateDigitFrequencies(ticks, Number.NaN).sampleSize).toBe(0);
    });

    it('uses the quote precision supplied by the active symbol', () => {
        expect(getLastDigit('123.450', 0.01)).toBe(5);
    });

    it('generates a stable descriptive signal from actual sample observations', () => {
        const digits = Array.from({ length: 1000 }, (_, index) => (index % 5 === 0 ? 5 : (index % 9) + 1));
        const report = analyzeDigitCondition(ticksForDigits(digits), 1000, 'DIGITMATCH', 5, 1, 1_700_001_000_000);

        expect(report.status).toBe('Signal generated');
        expect(report.sampleSize).toBe(1000);
        expect(report.observedPercent).toBeGreaterThan(report.baselinePercent ?? 100);
        expect(report.evidenceStrength).toBeGreaterThan(0);
        expect(report.message).toContain('descriptive watch signal');
    });

    it('does not issue a signal for a uniform sample or insufficient history', () => {
        const now = 1_700_001_000_000;
        const uniformTicks = ticksForDigits(Array.from({ length: 1000 }, (_, index) => index % 10));
        const uniformReport = analyzeDigitCondition(uniformTicks, 1000, 'DIGITMATCH', 5, 1, now);
        const insufficientReport = analyzeDigitCondition(uniformTicks.slice(0, 99), 1000, 'DIGITMATCH', 5, 1);

        expect(uniformReport.status).toBe('No signal');
        expect(insufficientReport.status).toBe('Unable to validate');
        expect(insufficientReport.message).toContain('At least 100 valid ticks');
    });

    it('refuses to validate otherwise sufficient data when the sample is stale', () => {
        const now = 1_700_001_000_000;
        const digits = Array.from({ length: 1000 }, (_, index) => (index % 5 === 0 ? 5 : (index % 9) + 1));
        const report = analyzeDigitCondition(
            ticksForDigits(digits),
            1000,
            'DIGITMATCH',
            5,
            1,
            now + 60_000
        );

        expect(report.status).toBe('Unable to validate');
        expect(report.message).toContain('stale');
    });

    it('rejects unsupported digit contracts and impossible barriers', () => {
        const ticks = ticksForDigits(Array.from({ length: 200 }, (_, index) => index % 10));

        expect(analyzeDigitCondition(ticks, 200, 'CALL', undefined, 1).message).toContain(
            'does not support the selected digit contract'
        );
        expect(analyzeDigitCondition(ticks, 200, 'DIGITOVER', 9, 1).message).toContain(
            'barrier is not valid'
        );
    });

    it('marks data stale when disconnected, old, or implausibly in the future', () => {
        const now = 1_700_000_000_000;

        expect(isMarketTickFresh(now / 1000, now, 'connected')).toBe(true);
        expect(isMarketTickFresh(now / 1000 - 31, now, 'connected')).toBe(false);
        expect(isMarketTickFresh(now / 1000, now, 'reconnecting')).toBe(false);
        expect(isMarketTickFresh(now / 1000 + 6, now, 'connected')).toBe(false);
    });
});
