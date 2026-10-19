export type AnalysisTick = {
    epoch: number;
    quote: number | string;
};

export type DigitContractType =
    | 'DIGITDIFF'
    | 'DIGITEVEN'
    | 'DIGITMATCH'
    | 'DIGITODD'
    | 'DIGITOVER'
    | 'DIGITUNDER';

export type DigitFrequencies = {
    counts: number[];
    percentages: number[];
    sampleSize: number;
    latestDigit: number | null;
    sampleStart: number | null;
    sampleEnd: number | null;
};

export type SignalStatus =
    | 'Analysing'
    | 'Signal generated'
    | 'No signal'
    | 'Invalidated'
    | 'Expired'
    | 'Unable to validate';

export type AnalysisReport = {
    status: SignalStatus;
    message: string;
    sampleSize: number;
    observedPercent: number | null;
    baselinePercent: number | null;
    zScore: number | null;
    chiSquare: number | null;
    evidenceStrength: number | null;
    direction: 'above' | 'below' | null;
    generatedAt: number;
    invalidation: string;
};

const MAX_SIGNAL_DATA_AGE_MS = 30_000;

const DIGIT_CONTRACT_TYPES: readonly DigitContractType[] = [
    'DIGITDIFF',
    'DIGITEVEN',
    'DIGITMATCH',
    'DIGITODD',
    'DIGITOVER',
    'DIGITUNDER',
];

export const getLastDigit = (quote: number | string, pipSize?: number): number | null => {
    const numericQuote = Number(quote);
    if (!Number.isFinite(numericQuote)) return null;

    const decimals =
        pipSize && Number.isFinite(pipSize) && pipSize > 0
            ? Math.max(0, Math.min(10, Math.round(-Math.log10(pipSize))))
            : undefined;
    const formattedQuote = decimals === undefined ? String(quote) : numericQuote.toFixed(decimals);
    const decimalPart = formattedQuote.split('.')[1];
    const digits = decimalPart ?? formattedQuote.replace(/\D/g, '');
    const digit = digits[digits.length - 1];

    return digit === undefined ? null : Number(digit);
};

export const calculateDigitFrequencies = (
    ticks: AnalysisTick[],
    sampleSize: number,
    pipSize?: number
): DigitFrequencies => {
    const validTicks = ticks
        .filter(tick => Number.isFinite(tick.epoch) && Number.isFinite(Number(tick.quote)))
        .slice(-Math.max(0, sampleSize));
    const counts = Array.from({ length: 10 }, () => 0);
    const digitTicks = validTicks.flatMap(tick => {
        const digit = getLastDigit(tick.quote, pipSize);
        return digit === null ? [] : [{ digit, epoch: tick.epoch }];
    });

    digitTicks.forEach(({ digit }) => {
        counts[digit] += 1;
    });

    const total = digitTicks.length;

    return {
        counts,
        percentages: counts.map(count => (total ? (count / total) * 100 : 0)),
        sampleSize: total,
        latestDigit: digitTicks[digitTicks.length - 1]?.digit ?? null,
        sampleStart: digitTicks[0]?.epoch ?? null,
        sampleEnd: digitTicks[digitTicks.length - 1]?.epoch ?? null,
    };
};

const isValidBarrier = (contractType: DigitContractType, barrier: number | undefined) => {
    if (contractType === 'DIGITODD' || contractType === 'DIGITEVEN') return true;
    if (barrier === undefined || !Number.isInteger(barrier) || barrier < 0 || barrier > 9) return false;
    if (contractType === 'DIGITOVER') return barrier <= 8;
    if (contractType === 'DIGITUNDER') return barrier >= 1;
    return true;
};

const matchesCondition = (digit: number, contractType: DigitContractType, barrier?: number): boolean => {
    switch (contractType) {
        case 'DIGITDIFF':
            return digit !== barrier;
        case 'DIGITEVEN':
            return digit % 2 === 0;
        case 'DIGITMATCH':
            return digit === barrier;
        case 'DIGITODD':
            return digit % 2 !== 0;
        case 'DIGITOVER':
            return digit > (barrier as number);
        case 'DIGITUNDER':
            return digit < (barrier as number);
    }
};

const expectedRate = (contractType: DigitContractType, barrier?: number) => {
    switch (contractType) {
        case 'DIGITDIFF':
            return 0.9;
        case 'DIGITEVEN':
        case 'DIGITODD':
            return 0.5;
        case 'DIGITMATCH':
            return 0.1;
        case 'DIGITOVER':
            return (9 - (barrier as number)) / 10;
        case 'DIGITUNDER':
            return (barrier as number) / 10;
    }
};

const chiSquareAgainstUniform = (counts: number[], sampleSize: number) =>
    counts.reduce((sum, count) => sum + (count - sampleSize / 10) ** 2 / (sampleSize / 10), 0);

export const analyzeDigitCondition = (
    ticks: AnalysisTick[],
    sampleSize: number,
    contractType: string,
    barrier?: number,
    pipSize?: number,
    generatedAt = Date.now(),
    dataFresh?: boolean
): AnalysisReport => {
    const frequencies = calculateDigitFrequencies(ticks, sampleSize, pipSize);
    const invalidReport = (message: string): AnalysisReport => ({
        status: 'Unable to validate',
        message,
        sampleSize: frequencies.sampleSize,
        observedPercent: null,
        baselinePercent: null,
        zScore: null,
        chiSquare: null,
        evidenceStrength: null,
        direction: null,
        generatedAt,
        invalidation: 'No signal was issued because the available data or selected condition could not be validated.',
    });

    if (!DIGIT_CONTRACT_TYPES.includes(contractType as DigitContractType)) {
        return invalidReport('This symbol does not support the selected digit contract type.');
    }
    if (!isValidBarrier(contractType as DigitContractType, barrier)) {
        return invalidReport('The selected barrier is not valid for this contract type.');
    }
    if (frequencies.sampleSize < 100) {
        return invalidReport(`At least 100 valid ticks are required; ${frequencies.sampleSize} were available.`);
    }
    const latestEpoch = frequencies.sampleEnd;
    const isFresh =
        dataFresh ??
        (latestEpoch !== null &&
            generatedAt - latestEpoch * 1000 >= -5000 &&
            generatedAt - latestEpoch * 1000 <= MAX_SIGNAL_DATA_AGE_MS);
    if (!isFresh) {
        return invalidReport('The latest tick is stale or the market-data connection is not live; refresh before validating this condition.');
    }

    const type = contractType as DigitContractType;
    const digits = ticks
        .filter(tick => Number.isFinite(tick.epoch) && Number.isFinite(Number(tick.quote)))
        .slice(-Math.max(0, sampleSize))
        .flatMap(tick => {
            const digit = getLastDigit(tick.quote, pipSize);
            return digit === null ? [] : [digit];
        });
    const observedCount = digits.filter(digit => matchesCondition(digit, type, barrier)).length;
    const observedRate = observedCount / digits.length;
    const baseline = expectedRate(type, barrier);
    const standardError = Math.sqrt((baseline * (1 - baseline)) / digits.length);
    const zScore = (observedRate - baseline) / standardError;
    const midpoint = Math.floor(digits.length / 2);
    const firstHalfRate = digits.slice(0, midpoint).filter(digit => matchesCondition(digit, type, barrier)).length / midpoint;
    const secondHalfRate =
        digits.slice(midpoint).filter(digit => matchesCondition(digit, type, barrier)).length /
        (digits.length - midpoint);
    const direction: 'above' | 'below' = observedRate >= baseline ? 'above' : 'below';
    const stable =
        (firstHalfRate - baseline) * (secondHalfRate - baseline) > 0 &&
        Math.sign(firstHalfRate - baseline) === Math.sign(secondHalfRate - baseline);
    const chiSquare = chiSquareAgainstUniform(frequencies.counts, frequencies.sampleSize);
    const consistency = stable ? Math.max(0, 1 - Math.abs(firstHalfRate - secondHalfRate)) : 0;
    const sampleAdequacy = Math.min(1, frequencies.sampleSize / 1000);
    const evidenceStrength = Math.round(
        100 * sampleAdequacy * Math.min(1, Math.abs(zScore) / 4) * consistency
    );
    const significant = Math.abs(zScore) >= 1.96 && stable && chiSquare >= 16.919;
    const conditionLabel = barrier === undefined ? type : `${type} ${barrier}`;

    return {
        status: significant ? 'Signal generated' : 'No signal',
        message: significant
            ? `${conditionLabel} occurred ${direction === 'above' ? 'more' : 'less'} often than its uniform-digit reference in this sample (${(observedRate * 100).toFixed(1)}% observed vs ${(baseline * 100).toFixed(1)}% reference). This is a descriptive watch signal, not a forecast or trade recommendation.`
            : `No analytical signal passed the validation checks for ${conditionLabel}. The observed rate was ${(observedRate * 100).toFixed(1)}% against a ${(baseline * 100).toFixed(1)}% uniform-digit reference; the result was not both statistically unusual and consistent across both halves of the sample.`,
        sampleSize: frequencies.sampleSize,
        observedPercent: observedRate * 100,
        baselinePercent: baseline * 100,
        zScore,
        chiSquare,
        evidenceStrength,
        direction,
        generatedAt,
        invalidation:
            'A generated signal is invalidated if the rolling sample loses statistical significance, reverses direction, or fails the stability check. Stale or disconnected market data cannot validate it.',
    };
};
