import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    analyzeDigitCondition,
    calculateDigitFrequencies,
    resolveSignalStatus,
    type AnalysisReport,
    type AnalysisTick,
    type SignalStatus,
} from '@/services/market-analysis/analysis-engine';
import {
    DerivMarketDataClient,
    isMarketTickFresh,
    mergeMarketTicks,
    mergeMarketTicksForSymbol,
    type MarketDataStatus,
    type MarketSymbol,
    type MarketTick,
} from '@/services/market-analysis/deriv-market-data';
import './market-analysis.scss';

type SignalRecord = {
    id: string;
    symbol: string;
    displayName: string;
    contractType: string;
    barrier?: number;
    report: AnalysisReport;
    status: SignalStatus;
};

const HISTORY_STORAGE_KEY = 'winnerssite.market-analysis.signal-history.v1';
const HISTORY_LIMIT = 30;
const STALE_AFTER_MS = 30_000;
const SIGNAL_EXPIRY_MS = 30 * 60_000;
const SAMPLE_SIZES = [100, 250, 500, 1000];

const asAnalysisTicks = (ticks: MarketTick[]): AnalysisTick[] => ticks.map(({ epoch, quote }) => ({ epoch, quote }));

const readSignalHistory = (): SignalRecord[] => {
    try {
        const storedHistory = localStorage.getItem(HISTORY_STORAGE_KEY);
        if (!storedHistory) return [];
        const parsed = JSON.parse(storedHistory);
        return Array.isArray(parsed)
            ? parsed.filter(
                  (record): record is SignalRecord =>
                      record &&
                      typeof record.id === 'string' &&
                      typeof record.symbol === 'string' &&
                      typeof record.contractType === 'string' &&
                      typeof record.report?.generatedAt === 'number'
              )
            : [];
    } catch (error) {
        console.error('Could not read saved market-analysis history:', error);
        return [];
    }
};

const isBarrierContract = (contractType: string) =>
    ['DIGITDIFF', 'DIGITMATCH', 'DIGITOVER', 'DIGITUNDER'].includes(contractType);

const getStatusLabel = (status: MarketDataStatus) => {
    switch (status) {
        case 'connected':
            return 'Live connection';
        case 'connecting':
            return 'Connecting';
        case 'reconnecting':
            return 'Reconnecting';
        case 'disconnected':
            return 'Disconnected';
    }
};

const MarketAnalysisPage = () => {
    const appId = process.env.NEXT_PUBLIC_DERIV_APP_ID ?? '';
    const [client, setClient] = useState<DerivMarketDataClient | null>(null);
    const [connectionStatus, setConnectionStatus] = useState<MarketDataStatus>('connecting');
    const [symbols, setSymbols] = useState<MarketSymbol[]>([]);
    const [selectedSymbol, setSelectedSymbol] = useState('');
    const [contractTypes, setContractTypes] = useState<string[]>([]);
    const [selectedContract, setSelectedContract] = useState('');
    const [barrier, setBarrier] = useState(5);
    const [sampleSize, setSampleSize] = useState(1000);
    const [ticks, setTicks] = useState<MarketTick[]>([]);
    const ticksRef = useRef(ticks);
    ticksRef.current = ticks;
    const [isLoading, setIsLoading] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isAnalysing, setIsAnalysing] = useState(false);
    const [error, setError] = useState('');
    const [clock, setClock] = useState(Date.now());
    const [signalHistory, setSignalHistory] = useState<SignalRecord[]>(readSignalHistory);
    const [storageError, setStorageError] = useState('');
    const selectedSymbolRef = useRef(selectedSymbol);
    selectedSymbolRef.current = selectedSymbol;
    const connectionStatusRef = useRef(connectionStatus);
    connectionStatusRef.current = connectionStatus;

    const marketSymbol = symbols.find(({ symbol }) => symbol === selectedSymbol);
    const latestTick = ticks[ticks.length - 1];
    const isFresh = latestTick !== undefined && isMarketTickFresh(latestTick.epoch, clock, connectionStatus, STALE_AFTER_MS);
    const currentReport = signalHistory.find(
        record =>
            record.symbol === selectedSymbol &&
            record.contractType === selectedContract &&
            record.barrier === (isBarrierContract(selectedContract) ? barrier : undefined)
    );
    const frequencies = useMemo(
        () => calculateDigitFrequencies(asAnalysisTicks(ticks), sampleSize, marketSymbol?.pip),
        [ticks, sampleSize, marketSymbol?.pip]
    );

    useEffect(() => {
        if (!appId.trim()) {
            setConnectionStatus('disconnected');
            setError('Public market data requires the Deriv application ID configured for this site. No account token is needed.');
            return;
        }

        const marketDataClient = new DerivMarketDataClient(
            appId,
            setConnectionStatus,
            tick => {
                if (tick.symbol !== selectedSymbolRef.current) return;
                setTicks(previous => mergeMarketTicks(previous, [tick]));
                setClock(Date.now());
            }
        );
        setClient(marketDataClient);
        marketDataClient.connect();

        return () => {
            marketDataClient.disconnect();
        };
    }, [appId]);

    useEffect(() => {
        if (!client || connectionStatus !== 'connected') return;
        let cancelled = false;
        client
            .getSymbols()
            .then(availableSymbols => {
                if (cancelled) return;
                setSymbols(availableSymbols);
                setSelectedSymbol(current =>
                    availableSymbols.some(symbol => symbol.symbol === current) ? current : (availableSymbols[0]?.symbol ?? '')
                );
                if (availableSymbols.length === 0) {
                    setError('Deriv returned no active volatility indices for this connection.');
                } else {
                    setError('');
                }
            })
            .catch(requestError => {
                if (!cancelled) setError(requestError instanceof Error ? requestError.message : 'Unable to load Deriv symbols.');
            });
        return () => {
            cancelled = true;
        };
    }, [client, connectionStatus]);

    useEffect(() => {
        if (!client || connectionStatus !== 'connected' || !selectedSymbol) return;
        let cancelled = false;
        let releaseTicks: (() => void) | undefined;
        setTicks([]);
        setContractTypes([]);
        setSelectedContract('');
        setError('');
        setIsLoading(true);

        const loadMarket = async () => {
            try {
                const [availableContracts, history] = await Promise.all([
                    client.getDigitContracts(selectedSymbol),
                    client.getHistory(selectedSymbol, 1000),
                ]);
                if (cancelled) return;

                setContractTypes(availableContracts);
                setSelectedContract(current =>
                    availableContracts.includes(current) ? current : (availableContracts[0] ?? '')
                );
                setTicks(previous =>
                    mergeMarketTicks(
                        previous,
                        history.map(tick => ({ ...tick, symbol: selectedSymbol }))
                    )
                );
                if (availableContracts.length === 0) {
                    setError('This symbol has no digit contract types available from Deriv.');
                }
            } catch (requestError) {
                if (!cancelled) {
                    setError(requestError instanceof Error ? requestError.message : 'Unable to load market data.');
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };

        void loadMarket();
        client
            .subscribeTicks(selectedSymbol)
            .then(release => {
                if (cancelled) release();
                else releaseTicks = release;
            })
            .catch(requestError => {
                if (!cancelled) {
                    setError(requestError instanceof Error ? requestError.message : 'Unable to subscribe to live ticks.');
                }
            });

        return () => {
            cancelled = true;
            releaseTicks?.();
        };
    }, [client, connectionStatus, selectedSymbol]);

    useEffect(() => {
        const interval = setInterval(() => setClock(Date.now()), 3000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(signalHistory));
            setStorageError('');
        } catch (writeError) {
            console.error('Could not save market-analysis history:', writeError);
            setStorageError('Signal history could not be saved on this device.');
        }
    }, [signalHistory]);

    useEffect(() => {
        if (signalHistory.length === 0) return;
        let hasChanges = false;
        const updatedHistory = signalHistory.map(record => {
            if (record.status === 'Invalidated' || record.status === 'Expired') return record;

            let status: SignalStatus = record.status;
            if (clock - record.report.generatedAt >= SIGNAL_EXPIRY_MS) {
                status = 'Expired';
            } else if (
                record.status === 'Signal generated' &&
                (record.symbol !== selectedSymbol ||
                    record.contractType !== selectedContract ||
                    record.barrier !== (isBarrierContract(selectedContract) ? barrier : undefined))
            ) {
                status = 'Invalidated';
            } else if (record.symbol !== selectedSymbol || !isFresh) {
                status = 'Unable to validate';
            } else {
                const validation = analyzeDigitCondition(
                    asAnalysisTicks(ticks),
                    sampleSize,
                    record.contractType,
                    record.barrier,
                    marketSymbol?.pip,
                    clock,
                    isMarketTickFresh(ticks[ticks.length - 1]?.epoch ?? 0, clock, connectionStatus, STALE_AFTER_MS)
                );
                status = resolveSignalStatus(record.report.status, validation);
            }

            if (status === record.status) return record;
            hasChanges = true;
            return { ...record, status };
        });

        if (hasChanges) setSignalHistory(updatedHistory);
    }, [
        barrier,
        clock,
        connectionStatus,
        isFresh,
        marketSymbol?.pip,
        sampleSize,
        selectedContract,
        selectedSymbol,
        signalHistory,
        ticks,
    ]);

    const handleRefreshData = useCallback(async () => {
        if (!client || !selectedSymbol || connectionStatus !== 'connected') return;
        const requestedSymbol = selectedSymbol;
        setIsRefreshing(true);
        setError('');
        try {
            const history = await client.getHistory(requestedSymbol, 1000);
            if (selectedSymbolRef.current === requestedSymbol) {
                setTicks(previous =>
                    mergeMarketTicksForSymbol(
                        previous,
                        history.map(tick => ({ ...tick, symbol: requestedSymbol })),
                        requestedSymbol
                    )
                );
                setClock(Date.now());
            }
        } catch (requestError) {
            if (selectedSymbolRef.current === requestedSymbol) {
                setError(requestError instanceof Error ? requestError.message : 'Unable to refresh market data.');
            }
        } finally {
            setIsRefreshing(false);
        }
    }, [client, connectionStatus, selectedSymbol]);

    const handleAnalyse = useCallback(async () => {
        if (!client || !selectedSymbol || !selectedContract || !marketSymbol) return;
        const requestedSymbol = selectedSymbol;
        setIsAnalysing(true);
        setError('');
        try {
            const history = await client.getHistory(requestedSymbol, 1000);
            const currentTicks = mergeMarketTicksForSymbol(
                ticksRef.current,
                history.map(tick => ({ ...tick, symbol: requestedSymbol })),
                requestedSymbol
            );
            if (selectedSymbolRef.current === requestedSymbol) {
                setTicks(currentTicks);
                setClock(Date.now());
            }
            const generatedAt = Date.now();
            const report = analyzeDigitCondition(
                asAnalysisTicks(currentTicks),
                sampleSize,
                selectedContract,
                isBarrierContract(selectedContract) ? barrier : undefined,
                marketSymbol.pip,
                generatedAt,
                isMarketTickFresh(
                    currentTicks[currentTicks.length - 1]?.epoch ?? 0,
                    generatedAt,
                    connectionStatusRef.current,
                    STALE_AFTER_MS
                )
            );
            const key = [
                requestedSymbol,
                selectedContract,
                isBarrierContract(selectedContract) ? barrier : 'no-barrier',
                currentTicks[currentTicks.length - 1]?.epoch ?? 'no-tick',
            ].join(':');
            const newRecord: SignalRecord = {
                id: key,
                symbol: requestedSymbol,
                displayName: marketSymbol.display_name,
                contractType: selectedContract,
                barrier: isBarrierContract(selectedContract) ? barrier : undefined,
                report,
                status: report.status,
            };
            setSignalHistory(previous => [newRecord, ...previous.filter(record => record.id !== key)].slice(0, HISTORY_LIMIT));
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : 'Unable to retrieve fresh tick history.');
        } finally {
            setIsAnalysing(false);
        }
    }, [barrier, client, connectionStatus, marketSymbol, sampleSize, selectedContract, selectedSymbol, ticks]);

    const lastUpdateText = latestTick
        ? new Date(latestTick.epoch * 1000).toLocaleTimeString()
        : 'No tick received';

    return (
        <main className='market-analysis'>
            <header className='market-analysis__header'>
                <div>
                    <p className='market-analysis__eyebrow'>Independent market tool</p>
                    <h1>AI Analysis &amp; Signals</h1>
                    <p className='market-analysis__intro'>
                        Explore live Deriv volatility-index ticks and descriptive digit statistics. This tool never places
                        trades or controls your bots. No AI model is connected; results are computed using deterministic
                        statistical tests on the displayed market data.
                    </p>
                </div>
                <div className={`market-analysis__connection market-analysis__connection--${isFresh ? 'live' : 'quiet'}`}>
                    <span aria-hidden='true' className='market-analysis__connection-dot' />
                    <span>{isFresh ? 'Live data' : getStatusLabel(connectionStatus)}</span>
                </div>
            </header>

            <section aria-label='Market controls' className='market-analysis__controls'>
                <label>
                    <span>Volatility index</span>
                    <select
                        disabled={symbols.length === 0}
                        onChange={event => setSelectedSymbol(event.target.value)}
                        value={selectedSymbol}
                    >
                        {symbols.length === 0 && <option value=''>Waiting for available markets</option>}
                        {symbols.map(symbol => (
                            <option key={symbol.symbol} value={symbol.symbol}>
                                {symbol.display_name}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    <span>Available digit contract</span>
                    <select
                        disabled={contractTypes.length === 0}
                        onChange={event => setSelectedContract(event.target.value)}
                        value={selectedContract}
                    >
                        {contractTypes.length === 0 && <option value=''>No digit contracts available</option>}
                        {contractTypes.map(contract => (
                            <option key={contract} value={contract}>
                                {contract}
                            </option>
                        ))}
                    </select>
                </label>
                {isBarrierContract(selectedContract) && (
                    <label className='market-analysis__barrier'>
                        <span>Digit barrier</span>
                        <select value={barrier} onChange={event => setBarrier(Number(event.target.value))}>
                            {Array.from({ length: 10 }, (_, digit) => (
                                <option key={digit} value={digit}>
                                    {digit}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                <label className='market-analysis__sample'>
                    <span>History sample</span>
                    <select value={sampleSize} onChange={event => setSampleSize(Number(event.target.value))}>
                        {SAMPLE_SIZES.map(size => (
                            <option key={size} value={size}>
                                {size.toLocaleString()} ticks
                            </option>
                        ))}
                    </select>
                </label>
            </section>

            {error && (
                <p className='market-analysis__notice market-analysis__notice--error' role='alert'>
                    {error}
                </p>
            )}

            <section aria-label='Latest market data' className='market-analysis__market'>
                <div>
                    <span className='market-analysis__label'>Selected market</span>
                    <strong>{marketSymbol?.display_name ?? 'Waiting for market list'}</strong>
                    <span className='market-analysis__muted'>{selectedSymbol || 'Symbol unavailable'}</span>
                </div>
                <div>
                    <span className='market-analysis__label'>Latest quote</span>
                    <strong>{latestTick ? String(latestTick.quote) : '—'}</strong>
                    <span className='market-analysis__muted'>
                        Latest digit: {frequencies.latestDigit === null ? '—' : frequencies.latestDigit}
                    </span>
                </div>
                <div>
                    <span className='market-analysis__label'>Last tick update</span>
                    <strong>{lastUpdateText}</strong>
                    <span className='market-analysis__muted'>
                        {isFresh ? 'Fresh' : latestTick ? 'Stale — refresh to validate' : 'Waiting for live tick'}
                    </span>
                </div>
            </section>

            <section aria-labelledby='digit-frequency-heading' className='market-analysis__section'>
                <div className='market-analysis__section-heading'>
                    <div>
                        <h2 id='digit-frequency-heading'>Observed digit frequency</h2>
                        <p>
                            {frequencies.sampleSize.toLocaleString()} ticks in sample
                            {frequencies.sampleStart !== null && frequencies.sampleEnd !== null
                                ? ` · ${new Date(frequencies.sampleStart * 1000).toLocaleString()} – ${new Date(frequencies.sampleEnd * 1000).toLocaleString()}`
                                : ''}
                        </p>
                    </div>
                    <span className='market-analysis__muted'>Descriptive history, not future probability</span>
                </div>
                <div className='market-analysis__digits'>
                    {frequencies.counts.map((count, digit) => (
                        <div className='market-analysis__digit' key={digit}>
                            <span aria-label={`Digit ${digit}`} className='market-analysis__digit-circle'>
                                {digit}
                            </span>
                            <strong>{frequencies.percentages[digit].toFixed(1)}%</strong>
                            <span>{count.toLocaleString()} observed</span>
                        </div>
                    ))}
                </div>
                {frequencies.sampleSize < 100 && (
                    <p className='market-analysis__notice'>
                        Insufficient history for statistical signal validation. Waiting for at least 100 actual ticks.
                    </p>
                )}
            </section>

            <section aria-labelledby='analysis-result-heading' className='market-analysis__section'>
                <div className='market-analysis__section-heading'>
                    <div>
                        <h2 id='analysis-result-heading'>Market analysis</h2>
                        <p>Signals describe observed data only; they do not predict outcomes or guarantee profit.</p>
                    </div>
                    <button
                        className='market-analysis__analyse-button market-analysis__refresh-button'
                        disabled={!client || connectionStatus !== 'connected' || isRefreshing || isLoading}
                        onClick={handleRefreshData}
                        type='button'
                    >
                        {isRefreshing ? 'Refreshing…' : 'Refresh data'}
                    </button>
                    <button
                        className='market-analysis__analyse-button'
                        disabled={
                            !selectedContract ||
                            frequencies.sampleSize < 100 ||
                            isAnalysing ||
                            isLoading
                        }
                        onClick={handleAnalyse}
                        type='button'
                    >
                        {isAnalysing ? 'Analysing…' : 'Analyse market'}
                    </button>
                </div>
                <p className='market-analysis__notice'>
                    Analysis type: {selectedContract || 'Select an available digit contract'}.
                    {isBarrierContract(selectedContract) ? ` Barrier ${barrier}.` : ''}
                    {' '}No contract is purchased.
                </p>
                <p className='market-analysis__muted'>
                    Statistical validation compares the observed contract condition with its uniform-digit reference,
                    requires a two-sided z-score of at least 1.96 and consistent results in both sample halves, and also
                    checks the digit distribution (chi-square threshold 16.919). Strength = round(100 × min(1, n / 1,000)
                    × min(1, |z| / 4) × consistency), where consistency is max(0, 1 − the absolute difference between
                    both half-sample rates) when both halves agree with the reference, otherwise 0. Strength is not a
                    probability of profit.
                </p>
                {currentReport && (
                    <div className='market-analysis__result' aria-live='polite'>
                        <div className='market-analysis__result-heading'>
                            <span className={`market-analysis__status market-analysis__status--${currentReport.status.toLowerCase().replace(/ /g, '-')}`}>
                                {currentReport.status}
                            </span>
                            <span>Generated {new Date(currentReport.report.generatedAt).toLocaleString()}</span>
                        </div>
                        <p>{currentReport.report.message}</p>
                        <div className='market-analysis__metrics'>
                            <span>Observed condition: {currentReport.report.observedPercent?.toFixed(1) ?? '—'}%</span>
                            <span>Uniform reference: {currentReport.report.baselinePercent?.toFixed(1) ?? '—'}%</span>
                            <span>Evidence strength: {currentReport.report.evidenceStrength ?? '—'} / 100</span>
                            <span>z-score: {currentReport.report.zScore?.toFixed(2) ?? '—'}</span>
                            <span>χ² digit distribution: {currentReport.report.chiSquare?.toFixed(2) ?? '—'}</span>
                        </div>
                        <p className='market-analysis__invalidation'>
                            Invalidation: {currentReport.report.invalidation}
                        </p>
                        <p className='market-analysis__invalidation'>
                            Expiry: 30 minutes after generation. Live validation requires a tick no older than 30
                            seconds; expired signals cannot be revalidated.
                        </p>
                    </div>
                )}
            </section>

            <section aria-labelledby='signal-history-heading' className='market-analysis__section'>
                <div className='market-analysis__section-heading'>
                    <div>
                        <h2 id='signal-history-heading'>Signal history</h2>
                        <p>Saved on this device. Hypothetical analysis only—not actual contract results.</p>
                    </div>
                </div>
                {storageError && <p className='market-analysis__notice market-analysis__notice--error'>{storageError}</p>}
                {signalHistory.length === 0 ? (
                    <p className='market-analysis__empty'>No analyses recorded yet. Refresh the market data to analyse it.</p>
                ) : (
                    <div className='market-analysis__history'>
                        {signalHistory.map(record => (
                            <article className='market-analysis__history-item' key={record.id}>
                                <div>
                                    <strong>{record.displayName}</strong>
                                    <span>{record.symbol} · {record.contractType}{record.barrier !== undefined ? ` ${record.barrier}` : ''}</span>
                                </div>
                                <p>{record.report.message}</p>
                                <div className='market-analysis__history-meta'>
                                    <span>{new Date(record.report.generatedAt).toLocaleString()}</span>
                                    <span className={`market-analysis__status market-analysis__status--${record.status.toLowerCase().replace(/ /g, '-')}`}>
                                        {record.status}
                                    </span>
                                </div>
                            </article>
                        ))}
                    </div>
                )}
            </section>

            <footer className='market-analysis__disclaimer'>
                Public Deriv market data only. No account token or trading authorization is used. Historical frequencies
                are descriptive statistics, not guaranteed future probabilities. Never risk money you cannot afford to
                lose.
            </footer>
        </main>
    );
};

export default MarketAnalysisPage;
