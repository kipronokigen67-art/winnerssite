import { useEffect, useState } from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { isDemoAccount } from '@/utils/account-helpers';
import { DerivLightBotBuilderIcon } from '@deriv/quill-icons/Illustration';
import {
    Over2Under7Bot,
    type NativeBotApi,
    type NativeBotConfig,
    type NativeBotSnapshot,
} from '@/services/native-bots/over2-under7-bot';
import './native-bot-panel.scss';

type BotMarket = { symbol: string; display_name: string; pip?: number; exchange_is_open?: number | boolean };

type BotSettings = Pick<
    NativeBotConfig,
    | 'stake'
    | 'maxStake'
    | 'sessionLossLimit'
    | 'takeProfitLimit'
    | 'maxTrades'
    | 'maxAnalysisSeconds'
    | 'maxSessionSeconds'
    | 'historyLookback'
    | 'recoveryMultiplier'
>;

const DEFAULT_SETTINGS: BotSettings = {
    stake: 1,
    maxStake: 5,
    sessionLossLimit: 20,
    takeProfitLimit: 10,
    maxTrades: 10,
    maxAnalysisSeconds: 30,
    maxSessionSeconds: 1800,
    historyLookback: 100,
    recoveryMultiplier: 2,
};

const INITIAL_SNAPSHOT: NativeBotSnapshot = {
    state: 'Idle',
    strategy: 'DIGITOVER',
    recoveryActive: false,
    stake: 0,
    tradeNumber: 0,
    totalProfit: 0,
    analysisElapsedMs: 0,
    analysisRemainingMs: 0,
    sessionElapsedMs: 0,
    ticksObserved: 0,
    lastTick: null,
    activeContractId: null,
    lastResult: null,
    error: '',
    availableContracts: [],
};

const formatDuration = (milliseconds: number) => {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    return `${Math.floor(totalSeconds / 60).toString().padStart(2, '0')}:${(totalSeconds % 60).toString().padStart(2, '0')}`;
};

const NativeBotPanel = () => {
    const { isAuthorized, connectionStatus, accountList, activeLoginid } = useApiBase();
    const { client } = useStore() ?? {};
    const [markets, setMarkets] = useState<BotMarket[]>([]);
    const [symbol, setSymbol] = useState('');
    const [marketLoading, setMarketLoading] = useState(false);
    const [accountId, setAccountId] = useState('');
    const [settings, setSettings] = useState<BotSettings>(DEFAULT_SETTINGS);
    const [allowRealMoney, setAllowRealMoney] = useState(false);
    const [snapshot, setSnapshot] = useState<NativeBotSnapshot>(INITIAL_SNAPSHOT);
    const [panelError, setPanelError] = useState('');
    const [isStarting, setIsStarting] = useState(false);
    const [bot, setBot] = useState<Over2Under7Bot | null>(null);
    const active = ['Analyzing', 'Ready', 'Buying', 'Open'].includes(snapshot.state);

    useEffect(() => {
        if (!isAuthorized || connectionStatus !== 'opened' || !api_base.api) {
            setMarkets([]);
            setSymbol('');
            return;
        }
        let cancelled = false;
        setMarketLoading(true);
        setPanelError('');
        api_base.api
            .send({ active_symbols: 'brief' })
            .then((response: Record<string, any>) => {
                if (cancelled) return;
                if (response?.error) throw new Error(`${response.error.code}: ${response.error.message}`);
                const activeMarkets = (Array.isArray(response?.active_symbols) ? response.active_symbols : [])
                    .filter((market: Record<string, any>) => market.symbol && market.display_name)
                    .filter((market: BotMarket) => market.exchange_is_open !== 0 && market.exchange_is_open !== false)
                    .map((market: BotMarket) => ({
                        symbol: market.symbol,
                        display_name: market.display_name,
                        pip: market.pip,
                        exchange_is_open: market.exchange_is_open,
                    }));
                setMarkets(activeMarkets);
                setSymbol(current => activeMarkets.some(market => market.symbol === current) ? current : (activeMarkets[0]?.symbol ?? ''));
                if (activeMarkets.length === 0) setPanelError('Deriv returned no currently open markets.');
            })
            .catch((error: unknown) => {
                if (!cancelled) setPanelError(error instanceof Error ? error.message : 'Could not load Deriv markets.');
            })
            .finally(() => {
                if (!cancelled) setMarketLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [connectionStatus, isAuthorized]);

    useEffect(() => {
        return () => bot?.stop();
    }, [bot]);

    const selectedAccount = accountList.find(account => account.loginid === accountId);
    const selectedAccountIsDemo = !!selectedAccount && isDemoAccount(selectedAccount.loginid);
    const apiIsOpen = connectionStatus === 'opened' && api_base.api?.connection?.readyState === 1;
    const startEnabled =
        isAuthorized &&
        apiIsOpen &&
        !!selectedAccount &&
        accountId === activeLoginid &&
        !!symbol &&
        !active &&
        !isStarting &&
        (!bot || bot.canStartAnotherSession());

    const handleAccountChange = (nextAccountId: string) => {
        setAccountId(nextAccountId);
        setAllowRealMoney(false);
        if (!nextAccountId || nextAccountId === activeLoginid) return;
        localStorage.setItem('active_loginid', nextAccountId);
        (client as { checkAndRegenerateWebSocket?: () => void } | undefined)?.checkAndRegenerateWebSocket?.();
    };

    const updateSetting = (key: keyof BotSettings, value: string) => {
        setSettings(current => ({ ...current, [key]: Number(value) }));
    };

    const handleStart = async () => {
        if (!startEnabled || !selectedAccount || !api_base.api) return;
        setPanelError('');
        setIsStarting(true);
        setSnapshot(INITIAL_SNAPSHOT);
        const socket = api_base.api;
        const adapter: NativeBotApi = {
            authorized: isAuthorized,
            activeLoginId: activeLoginid,
            connection: socket.connection,
            send: request => socket.send(request),
            onMessage: () => socket.onMessage(),
        };
        const runner = new Over2Under7Bot(adapter, setSnapshot);
        setBot(runner);
        const config: NativeBotConfig = {
            ...settings,
            symbol,
            currency: selectedAccount.currency,
            accountId: selectedAccount.loginid,
            accountType: selectedAccountIsDemo ? 'demo' : 'real',
            allowRealMoney,
        };
        try {
            await runner.start(config);
        } catch (error) {
            setPanelError(error instanceof Error ? error.message : 'Could not start the bot.');
        } finally {
            setIsStarting(false);
        }
    };

    const handleStop = () => bot?.stop();

    return (
        <section aria-labelledby='native-bot-heading' className='native-bot-panel'>
            <header className='native-bot-panel__header'>
                <div className='native-bot-panel__robot' aria-hidden='true'>
                    <DerivLightBotBuilderIcon height='48px' width='48px' />
                </div>
                <div className='native-bot-panel__title'>
                    <p className='native-bot-panel__eyebrow'>WINNERS NATIVE BOT</p>
                    <h2 id='native-bot-heading'>Over 2 → Under 7 recovery</h2>
                    <p>Waits for a live digit condition and changes to Under 7 only after a confirmed loss.</p>
                </div>
                <span className={`native-bot-panel__status native-bot-panel__status--${snapshot.state.toLowerCase().replace(/ /g, '-')}`}>
                    <span aria-hidden='true' />
                    {snapshot.state}
                </span>
            </header>

            <div className='native-bot-panel__body'>
                <div className='native-bot-panel__controls'>
                    <label className='native-bot-panel__field'>
                        <span>Deriv account</span>
                        <select disabled={!isAuthorized || active || isStarting} value={accountId} onChange={event => handleAccountChange(event.target.value)}>
                            <option value=''>Select an authorized account</option>
                            {accountList.map(account => (
                                <option key={account.loginid} value={account.loginid}>
                                    {isDemoAccount(account.loginid) ? 'Demo' : 'Real'} · {account.loginid}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='native-bot-panel__field'>
                        <span>Market / symbol</span>
                        <select disabled={!markets.length || active || isStarting} value={symbol} onChange={event => setSymbol(event.target.value)}>
                            {!markets.length && <option value=''>{marketLoading ? 'Loading markets…' : 'No open markets'}</option>}
                            {markets.map(market => <option key={market.symbol} value={market.symbol}>{market.display_name} · {market.symbol}</option>)}
                        </select>
                    </label>
                    <label className='native-bot-panel__field'>
                        <span>Initial stake</span>
                        <input disabled={active || isStarting} min='0.35' step='0.01' type='number' value={settings.stake} onChange={event => updateSetting('stake', event.target.value)} />
                    </label>
                    <label className='native-bot-panel__field'>
                        <span>Maximum stake</span>
                        <input disabled={active || isStarting} min='0.35' step='0.01' type='number' value={settings.maxStake} onChange={event => updateSetting('maxStake', event.target.value)} />
                    </label>
                    <label className='native-bot-panel__field'>
                        <span>Recovery multiplier</span>
                        <input disabled={active || isStarting} min='1' max='5' step='0.1' type='number' value={settings.recoveryMultiplier} onChange={event => updateSetting('recoveryMultiplier', event.target.value)} />
                    </label>
                    <label className='native-bot-panel__field'>
                        <span>Session loss limit</span>
                        <input disabled={active || isStarting} min='0.35' step='0.01' type='number' value={settings.sessionLossLimit} onChange={event => updateSetting('sessionLossLimit', event.target.value)} />
                    </label>
                    <label className='native-bot-panel__field'>
                        <span>Take-profit limit</span>
                        <input disabled={active || isStarting} min='0.35' step='0.01' type='number' value={settings.takeProfitLimit} onChange={event => updateSetting('takeProfitLimit', event.target.value)} />
                    </label>
                    <label className='native-bot-panel__field'>
                        <span>Maximum trades</span>
                        <input disabled={active || isStarting} min='1' max='1000' step='1' type='number' value={settings.maxTrades} onChange={event => updateSetting('maxTrades', event.target.value)} />
                    </label>
                    <label className='native-bot-panel__field'>
                        <span>Max signal wait (seconds)</span>
                        <input disabled={active || isStarting} min='5' max='600' step='1' type='number' value={settings.maxAnalysisSeconds} onChange={event => updateSetting('maxAnalysisSeconds', event.target.value)} />
                    </label>
                    <label className='native-bot-panel__field'>
                        <span>Max session duration (seconds)</span>
                        <input disabled={active || isStarting} min='30' max='86400' step='1' type='number' value={settings.maxSessionSeconds} onChange={event => updateSetting('maxSessionSeconds', event.target.value)} />
                    </label>
                    <label className='native-bot-panel__field'>
                        <span>Initial lookback (ticks)</span>
                        <input disabled={active || isStarting} min='10' max='500' step='10' type='number' value={settings.historyLookback} onChange={event => updateSetting('historyLookback', event.target.value)} />
                    </label>
                </div>

                {accountId && accountId !== activeLoginid && (
                    <p className='native-bot-panel__account-wait' role='status'>Waiting for the selected account to authorize on Deriv.</p>
                )}

                {selectedAccount && !selectedAccountIsDemo && (
                    <label className='native-bot-panel__real-confirm'>
                        <input checked={allowRealMoney} disabled={active || isStarting} onChange={event => setAllowRealMoney(event.target.checked)} type='checkbox' />
                        <span>I explicitly authorize real-money trading on {selectedAccount.loginid}.</span>
                    </label>
                )}

                <div className='native-bot-panel__actions'>
                    <button className='native-bot-panel__start' disabled={!startEnabled || (!!selectedAccount && !selectedAccountIsDemo && !allowRealMoney)} onClick={handleStart} type='button'>
                        {isStarting ? 'Connecting…' : 'Start Bot'}
                    </button>
                    <button className='native-bot-panel__stop' disabled={!active} onClick={handleStop} type='button'>Stop Bot</button>
                    <span className='native-bot-panel__connection'>
                        Deriv: {apiIsOpen && isAuthorized ? 'Authorized and connected' : 'Not connected'}
                    </span>
                </div>

                {(panelError || snapshot.error) && <p className='native-bot-panel__error' role='alert'>{panelError || snapshot.error}</p>}
                {bot?.hasUnresolvedExecution() && !active && !isStarting && (
                    <div className='native-bot-panel__unresolved' role='alert'>
                        <p>
                            A purchase or open contract needs manual verification. Check Deriv account activity before allowing another
                            session.
                        </p>
                        <button onClick={() => bot.confirmNoUnresolvedTrade()} type='button'>
                            I verified there is no unresolved trade
                        </button>
                    </div>
                )}

                <div className='native-bot-panel__telemetry' aria-live='polite'>
                    <div><span>Strategy</span><strong>{snapshot.strategy === 'DIGITOVER' ? 'Over 2' : 'Under 7'}{snapshot.recoveryActive ? ' · Recovery' : ''}</strong></div>
                    <div><span>Stake</span><strong>{selectedAccount?.currency ? `${snapshot.stake || settings.stake} ${selectedAccount.currency}` : '—'}</strong></div>
                    <div><span>Trade count</span><strong>{snapshot.tradeNumber} / {settings.maxTrades}</strong></div>
                    <div><span>Confirmed P/L</span><strong>{snapshot.totalProfit.toFixed(2)} {selectedAccount?.currency ?? ''}</strong></div>
                    <div><span>Analysis elapsed</span><strong>{formatDuration(snapshot.analysisElapsedMs)}</strong></div>
                    <div><span>Signal time left</span><strong>{formatDuration(snapshot.analysisRemainingMs)}</strong></div>
                    <div><span>Session elapsed</span><strong>{formatDuration(snapshot.sessionElapsedMs)}</strong></div>
                    <div><span>Ticks observed</span><strong>{snapshot.ticksObserved}</strong></div>
                    <div><span>Open contract</span><strong>{snapshot.activeContractId ?? '—'}</strong></div>
                    <div>
                        <span>Supported contracts on this market</span>
                        <strong>
                            {snapshot.availableContracts.length
                                ? snapshot.availableContracts.map(type => (type === 'DIGITOVER' ? 'Over' : 'Under')).join(' / ')
                                : 'Checking market availability'}
                        </strong>
                    </div>
                </div>

                <div className='native-bot-panel__result'>
                    <span>Last confirmed contract result</span>
                    {snapshot.lastResult ? (
                        <strong className={snapshot.lastResult.status === 'won' ? 'is-win' : 'is-loss'}>
                            {snapshot.lastResult.status.toUpperCase()} · {snapshot.lastResult.contractType} · {snapshot.lastResult.profit > 0 ? '+' : ''}{snapshot.lastResult.profit.toFixed(2)} {selectedAccount?.currency ?? ''}
                            {typeof snapshot.lastResult.balanceAfter === 'number' ? ` · Balance ${snapshot.lastResult.balanceAfter.toFixed(2)} ${selectedAccount?.currency ?? ''}` : ''}
                        </strong>
                    ) : <strong>None yet</strong>}
                </div>
            </div>
            <p className='native-bot-panel__disclaimer'>Digit conditions are not predictive. Trading can lose the full stake; recovery sizing can increase losses. Demo-first testing is strongly recommended.</p>
        </section>
    );
};

export default NativeBotPanel;
