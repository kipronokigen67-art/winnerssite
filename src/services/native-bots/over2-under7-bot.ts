export type NativeBotState =
    | 'Idle'
    | 'Analyzing'
    | 'Ready'
    | 'Buying'
    | 'Open'
    | 'Won'
    | 'Lost'
    | 'Stopped'
    | 'Timed out'
    | 'Rejected'
    | 'Disconnected'
    | 'Error';

export type DigitContractType = 'DIGITOVER' | 'DIGITUNDER';

export type NativeBotConfig = {
    symbol: string;
    currency: string;
    accountId: string;
    accountType: 'demo' | 'real';
    allowRealMoney: boolean;
    stake: number;
    maxStake: number;
    sessionLossLimit: number;
    takeProfitLimit: number;
    maxTrades: number;
    maxAnalysisSeconds: number;
    maxSessionSeconds: number;
    historyLookback: number;
    recoveryMultiplier: number;
};

export type NativeBotTick = { epoch: number; quote: number; symbol: string };

export type NativeBotResult = {
    contractId: number;
    contractType: DigitContractType;
    profit: number;
    status: 'won' | 'lost';
    buyPrice?: number;
    balanceAfter?: number;
};

export type NativeBotSnapshot = {
    state: NativeBotState;
    strategy: DigitContractType;
    recoveryActive: boolean;
    stake: number;
    tradeNumber: number;
    totalProfit: number;
    analysisElapsedMs: number;
    analysisRemainingMs: number;
    sessionElapsedMs: number;
    ticksObserved: number;
    lastTick: NativeBotTick | null;
    activeContractId: number | null;
    lastResult: NativeBotResult | null;
    error: string;
    availableContracts: DigitContractType[];
};

export type NativeBotApi = {
    authorized: boolean;
    activeLoginId: string;
    connection: {
        readyState: number;
        addEventListener: (event: string, listener: () => void) => void;
        removeEventListener: (event: string, listener: () => void) => void;
    };
    send: (request: Record<string, unknown>) => Promise<Record<string, any>>;
    onMessage: () => {
        subscribe: (listener: (message: unknown) => void) => { unsubscribe: () => void };
    };
};

const REQUEST_TIMEOUT_MS = 12_000;
const ANALYSIS_UPDATE_MS = 250;
const MAX_HISTORY_LOOKBACK = 500;
const OPEN_SOCKET = 1;

class NativeBotApiError extends Error {}

export const getLastDigit = (quote: number, pip: number): number => {
    const precision = Math.max(0, Math.min(10, Math.floor(pip)));
    const scaled = Math.round(quote * 10 ** precision + Number.EPSILON);
    return Math.abs(scaled) % 10;
};

const asFiniteNumber = (value: unknown): number | undefined => {
    if (value === null || value === undefined || value === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
};

export const validateNativeBotConfig = (config: NativeBotConfig): string | null => {
    if (!config.symbol.trim() || !config.currency.trim() || !config.accountId.trim()) {
        return 'Select a market and an active account before starting.';
    }
    if (config.accountType === 'real' && !config.allowRealMoney) {
        return 'Explicit real-money authorization is required before starting.';
    }
    if (!Number.isFinite(config.stake) || config.stake <= 0) return 'Stake must be greater than zero.';
    if (!Number.isFinite(config.maxStake) || config.maxStake < config.stake) {
        return 'Maximum stake must be at least the initial stake.';
    }
    if (!Number.isFinite(config.sessionLossLimit) || config.sessionLossLimit <= 0) {
        return 'Session loss limit must be greater than zero.';
    }
    if (!Number.isFinite(config.takeProfitLimit) || config.takeProfitLimit <= 0) {
        return 'Take-profit limit must be greater than zero.';
    }
    if (!Number.isInteger(config.maxTrades) || config.maxTrades < 1 || config.maxTrades > 1000) {
        return 'Maximum trades must be between 1 and 1,000.';
    }
    if (!Number.isFinite(config.maxAnalysisSeconds) || config.maxAnalysisSeconds < 5 || config.maxAnalysisSeconds > 600) {
        return 'Maximum analysis time must be between 5 and 600 seconds.';
    }
    if (!Number.isFinite(config.maxSessionSeconds) || config.maxSessionSeconds < 30 || config.maxSessionSeconds > 86_400) {
        return 'Maximum session duration must be between 30 seconds and 24 hours.';
    }
    if (!Number.isInteger(config.historyLookback) || config.historyLookback < 10 || config.historyLookback > MAX_HISTORY_LOOKBACK) {
        return `History lookback must be between 10 and ${MAX_HISTORY_LOOKBACK} ticks.`;
    }
    if (!Number.isFinite(config.recoveryMultiplier) || config.recoveryMultiplier < 1 || config.recoveryMultiplier > 5) {
        return 'Recovery multiplier must be between 1 and 5.';
    }
    return null;
};

const responseError = (response: Record<string, any>, fallback: string) => {
    const error = response?.error;
    if (!error) return null;
    return new NativeBotApiError(`${error.code ? `${error.code}: ` : ''}${error.message || fallback}`);
};

const asTick = (value: unknown): NativeBotTick | null => {
    if (!value || typeof value !== 'object') return null;
    const tick = value as Record<string, unknown>;
    const epoch = asFiniteNumber(tick.epoch);
    const quote = asFiniteNumber(tick.quote);
    if (typeof tick.symbol !== 'string' || epoch === undefined || quote === undefined) return null;
    return { epoch, quote, symbol: tick.symbol };
};

export class Over2Under7Bot {
    private api: NativeBotApi;
    private onUpdate: (snapshot: NativeBotSnapshot) => void;
    private config: NativeBotConfig | null = null;
    private snapshot: NativeBotSnapshot = this.createInitialSnapshot();
    private startedAt = 0;
    private analysisStartedAt = 0;
    private analysisDeadline = 0;
    private sessionDeadline = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private messageSubscription: { unsubscribe: () => void } | null = null;
    private tickSubscriptionId = '';
    private contractSubscriptionId = '';
    private activeContractId: number | null = null;
    private buyRequestSent = false;
    private purchaseOutcomeUnknown = false;
    private purchaseInFlight = false;
    private stopped = true;
    private pip = 2;
    private lastTickKey = '';
    private lastBalance: number | undefined;
    private readonly handleSocketClose: () => void;

    constructor(api: NativeBotApi, onUpdate: (snapshot: NativeBotSnapshot) => void) {
        this.api = api;
        this.onUpdate = onUpdate;
        this.handleSocketClose = () => {
            if (this.buyRequestSent) this.purchaseOutcomeUnknown = true;
            this.fail('Disconnected', 'Deriv connection closed. Restart the bot manually after reconnecting.');
        };
    }

    getSnapshot = (): NativeBotSnapshot => ({ ...this.snapshot });

    canStartAnotherSession = () =>
        !this.purchaseInFlight && !this.buyRequestSent && !this.purchaseOutcomeUnknown && this.activeContractId === null;

    hasUnresolvedExecution = () => this.purchaseOutcomeUnknown || this.activeContractId !== null;

    confirmNoUnresolvedTrade = () => {
        if (this.purchaseInFlight || this.buyRequestSent) return;
        this.purchaseOutcomeUnknown = false;
        this.activeContractId = null;
        this.snapshot.activeContractId = null;
        this.cleanup();
        this.publish();
    };

    async start(config: NativeBotConfig): Promise<void> {
        if (this.isActive()) throw new Error('This bot is already running.');
        const configError = validateNativeBotConfig(config);
        if (configError) throw new Error(configError);
        if (!this.api.authorized) throw new Error('Connect and authorize a Deriv account before starting this bot.');
        if (this.api.activeLoginId !== config.accountId) throw new Error('The selected account is not active on the authorized Deriv connection.');
        if (this.api.connection.readyState !== OPEN_SOCKET) throw new Error('Deriv connection is not open.');

        this.config = { ...config };
        this.stopped = false;
        this.purchaseInFlight = false;
        this.activeContractId = null;
        this.buyRequestSent = false;
        this.lastTickKey = '';
        this.lastBalance = undefined;
        this.startedAt = Date.now();
        this.analysisStartedAt = this.startedAt;
        this.analysisDeadline = this.startedAt + config.maxAnalysisSeconds * 1000;
        this.sessionDeadline = this.startedAt + config.maxSessionSeconds * 1000;
        this.snapshot = {
            ...this.createInitialSnapshot(),
            state: 'Analyzing',
            strategy: 'DIGITOVER',
            stake: config.stake,
        };
        this.api.connection.addEventListener('close', this.handleSocketClose);
        this.messageSubscription = this.api.onMessage().subscribe(this.handleMessage);
        this.timer = setInterval(this.updateClock, ANALYSIS_UPDATE_MS);
        this.publish();

        try {
            await this.loadMarketAndSubscribe();
        } catch (error) {
            if (!this.stopped) this.fail('Error', this.errorMessage(error, 'Could not initialize the bot.'));
        }
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.snapshot.state = 'Stopped';
        this.snapshot.error = this.activeContractId
            ? 'Stopped. The open contract will be monitored to its confirmed result; no further trades will be placed.'
            : '';
        this.clearTimer();
        this.forgetSubscription(this.tickSubscriptionId);
        this.tickSubscriptionId = '';
        if (this.activeContractId === null && !this.buyRequestSent) this.cleanup();
        this.publish();
    }

    private createInitialSnapshot(): NativeBotSnapshot {
        return {
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
    }

    private isActive() {
        return !this.stopped && !['Idle', 'Stopped', 'Timed out', 'Rejected', 'Disconnected', 'Error'].includes(this.snapshot.state);
    }

    private async loadMarketAndSubscribe() {
        const config = this.requireConfig();
        const symbolsResponse = await this.request({ active_symbols: 'brief' });
        if (!this.isActive()) return;
        const symbol = symbolsResponse.active_symbols?.find((item: Record<string, any>) => item.symbol === config.symbol);
        if (!symbol) throw new Error('The selected symbol is no longer available from Deriv.');
        if (symbol.exchange_is_open === 0 || symbol.exchange_is_open === false) {
            throw new Error('The selected market is closed. Choose an open market.');
        }
        this.pip = Number(symbol.pip) || 2;

        const contractsResponse = await this.request({ contracts_for: config.symbol });
        if (!this.isActive()) return;
        const available = contractsResponse.contracts_for?.available;
        if (!Array.isArray(available)) throw new Error('Deriv returned no contract availability for this symbol.');
        const availableTypes = new Set(
            available.map((contract: Record<string, any>) => contract.contract_type).filter((type: unknown) => typeof type === 'string')
        );
        this.snapshot.availableContracts = (['DIGITOVER', 'DIGITUNDER'] as const).filter(type => availableTypes.has(type));
        if (!availableTypes.has('DIGITOVER') || !availableTypes.has('DIGITUNDER')) {
            throw new Error('This symbol does not currently support both Over and Under digit contracts.');
        }
        this.publish();

        const historyResponse = await this.request({
            ticks_history: config.symbol,
            count: config.historyLookback,
            end: 'latest',
            style: 'ticks',
        });
        if (!this.isActive()) return;
        const prices = historyResponse.history?.prices;
        const times = historyResponse.history?.times;
        if (!Array.isArray(prices) || !Array.isArray(times) || prices.length !== times.length) {
            throw new Error('Deriv returned incomplete initial tick history.');
        }
        this.snapshot.ticksObserved = prices.length;
        if (prices.length > 0) {
            this.snapshot.lastTick = asTick({
                epoch: times[times.length - 1],
                quote: prices[prices.length - 1],
                symbol: config.symbol,
            });
        }
        this.publish();
        if (!this.isActive()) return;

        const tickResponse = await this.request({ ticks: config.symbol, subscribe: 1 });
        const subscriptionId = tickResponse.subscription?.id;
        if (typeof subscriptionId !== 'string' || !subscriptionId) {
            throw new Error('Deriv did not confirm the live tick subscription.');
        }
        this.tickSubscriptionId = subscriptionId;
        this.handleTick(tickResponse.tick);
    }

    private readonly handleMessage = (message: unknown) => {
        if (!message || typeof message !== 'object' || !('data' in message)) return;
        const data = message.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return;
        const apiMessage = data as Record<string, any>;

        if (!this.stopped && apiMessage.msg_type === 'tick' && apiMessage.tick?.symbol === this.config?.symbol) {
            this.handleTick(apiMessage.tick);
            return;
        }

        if (apiMessage.msg_type === 'proposal_open_contract' && this.activeContractId !== null) {
            const contract = apiMessage.proposal_open_contract;
            if (Number(contract?.contract_id) === this.activeContractId) {
                this.handleContractUpdate(contract, apiMessage.subscription?.id);
            }
            return;
        }

        const confirmedBalance = asFiniteNumber(apiMessage.balance?.balance);
        if (!this.stopped && apiMessage.msg_type === 'balance' && confirmedBalance !== undefined) {
            this.lastBalance = confirmedBalance;
            if (this.snapshot.lastResult) this.snapshot.lastResult = { ...this.snapshot.lastResult, balanceAfter: this.lastBalance };
            this.publish();
        }
    };

    private handleTick(value: unknown) {
        if (!this.isActive() || this.snapshot.state !== 'Analyzing' || this.purchaseInFlight) return;
        const tick = asTick(value);
        if (!tick || tick.symbol !== this.config?.symbol) return;
        const key = `${tick.epoch}:${tick.quote}`;
        if (key === this.lastTickKey) return;
        this.lastTickKey = key;
        this.snapshot.ticksObserved += 1;
        this.snapshot.lastTick = tick;
        this.publish();

        const digit = getLastDigit(tick.quote, this.pip);
        const qualifies = this.snapshot.strategy === 'DIGITOVER' ? digit > 2 : digit < 7;
        if (qualifies) {
            this.snapshot.state = 'Ready';
            this.publish();
            void this.placeTrade();
        }
    }

    private async placeTrade() {
        if (!this.isActive() || this.snapshot.state !== 'Ready' || this.purchaseInFlight || !this.config) return;
        const contractType = this.snapshot.strategy;
        const configError = validateNativeBotConfig(this.config);
        if (configError) {
            this.fail('Error', configError);
            return;
        }
        if (!this.api.authorized || this.api.activeLoginId !== this.config.accountId) {
            this.fail('Disconnected', 'The selected Deriv account is no longer authorized. Restart manually after reconnecting.');
            return;
        }
        if (this.api.connection.readyState !== OPEN_SOCKET) {
            this.fail('Disconnected', 'Deriv connection is not open. Restart the bot manually after reconnecting.');
            return;
        }
        if (!this.snapshot.availableContracts.includes(contractType)) {
            this.fail('Error', `Deriv no longer reports ${contractType} as available for this market.`);
            return;
        }
        if (this.snapshot.stake > this.config.maxStake) {
            this.finish('Stopped', 'The next stake would exceed the configured maximum stake.');
            return;
        }
        if (this.snapshot.totalProfit <= -this.config.sessionLossLimit) {
            this.finish('Stopped', 'Session loss limit reached.');
            return;
        }
        if (this.snapshot.totalProfit >= this.config.takeProfitLimit) {
            this.finish('Stopped', 'Take-profit limit reached.');
            return;
        }
        if (this.snapshot.tradeNumber >= this.config.maxTrades) {
            this.finish('Stopped', 'Maximum trade count reached.');
            return;
        }
        if (Date.now() >= this.sessionDeadline) {
            this.finish('Stopped', 'Maximum session duration reached.');
            return;
        }
        this.purchaseInFlight = true;
        const barrier = contractType === 'DIGITOVER' ? '2' : '7';
        const stake = this.snapshot.stake;
        this.snapshot.state = 'Buying';
        this.snapshot.error = '';
        this.publish();

        try {
            const proposalResponse = await this.request({
                proposal: 1,
                amount: stake,
                basis: 'stake',
                contract_type: contractType,
                currency: this.config.currency,
                duration: 1,
                duration_unit: 't',
                barrier,
                underlying_symbol: this.config.symbol,
            });
            if (!this.isActive()) return;
            const proposal = proposalResponse.proposal;
            const askPrice = asFiniteNumber(proposal?.ask_price);
            if (!proposal?.id || askPrice === undefined || askPrice <= 0) {
                throw new Error('Deriv did not return a valid proposal.');
            }
            if (!this.isActive()) return;
            if (Date.now() >= this.sessionDeadline) {
                this.finish('Stopped', 'Maximum session duration reached before purchase.');
                return;
            }
            if (askPrice > this.config.maxStake) {
                throw new Error('The proposal exceeds the configured maximum stake; no purchase was sent.');
            }

            this.buyRequestSent = true;
            const buyResponse = await this.request({ buy: proposal.id, price: askPrice });
            const buy = buyResponse.buy;
            const contractId = asFiniteNumber(buy?.contract_id);
            const buyPrice = asFiniteNumber(buy?.buy_price);
            if (contractId === undefined || contractId <= 0 || buyPrice === undefined || buyPrice <= 0) {
                throw new Error('Deriv did not confirm the contract purchase.');
            }
            this.buyRequestSent = false;
            this.activeContractId = contractId;
            this.snapshot.activeContractId = this.activeContractId;
            this.snapshot.tradeNumber += 1;
            this.snapshot.state = this.stopped ? 'Stopped' : 'Open';
            this.snapshot.error = this.stopped
                ? 'Stopped. Monitoring the confirmed contract result; no further trades will be placed.'
                : '';
            this.publish();

            const contractResponse = await this.request({
                proposal_open_contract: 1,
                contract_id: this.activeContractId,
                subscribe: 1,
            });
            this.contractSubscriptionId = String(contractResponse.subscription?.id ?? '');
            if (contractResponse.proposal_open_contract) {
                this.handleContractUpdate(contractResponse.proposal_open_contract, this.contractSubscriptionId);
            }
        } catch (error) {
            if (this.buyRequestSent) {
                this.buyRequestSent = false;
                if (error instanceof NativeBotApiError) {
                    this.fail('Rejected', this.errorMessage(error, 'Deriv rejected the purchase.'));
                } else {
                    this.purchaseOutcomeUnknown = true;
                    this.fail(
                        'Error',
                        `Purchase outcome could not be confirmed. No retry was sent. Check account activity before restarting. ${this.errorMessage(error, 'Deriv request failed.')}`
                    );
                }
            } else if (this.activeContractId !== null) {
                this.fail(
                    'Error',
                    `Contract ${this.activeContractId} was purchased, but result monitoring failed: ${this.errorMessage(error, 'Deriv request failed.')}`
                );
            } else if (!this.stopped) {
                this.fail('Rejected', this.errorMessage(error, 'Deriv rejected the proposal or purchase.'));
            }
        } finally {
            this.purchaseInFlight = false;
            this.publish();
        }
    }

    private handleContractUpdate(contract: Record<string, any>, subscriptionId?: string) {
        if (this.activeContractId === null || Number(contract.contract_id) !== this.activeContractId) return;
        if (subscriptionId && !this.contractSubscriptionId) this.contractSubscriptionId = subscriptionId;
        const status = contract.status;
        const isConfirmed = contract.is_sold === 1 || contract.is_sold === true || status === 'won' || status === 'lost';
        const profit = asFiniteNumber(contract.profit);
        if (!isConfirmed || (status !== 'won' && status !== 'lost') || profit === undefined) {
            if (status === 'open') {
                if (!this.stopped) this.snapshot.state = 'Open';
                this.publish();
            }
            return;
        }

        const buyPrice = asFiniteNumber(contract.buy_price);
        const balanceAfter = asFiniteNumber(contract.balance_after);
        const result: NativeBotResult = {
            contractId: this.activeContractId,
            contractType: this.snapshot.strategy,
            profit,
            status,
            ...(buyPrice === undefined ? {} : { buyPrice }),
            ...(balanceAfter === undefined ? {} : { balanceAfter }),
        };
        this.snapshot.lastResult = result;
        this.snapshot.totalProfit += result.profit;
        this.snapshot.state = status === 'won' ? 'Won' : 'Lost';
        this.activeContractId = null;
        this.snapshot.activeContractId = null;
        this.forgetSubscription(this.contractSubscriptionId);
        this.contractSubscriptionId = '';
        this.publish();

        if (this.stopped) {
            this.cleanup();
            return;
        }
        if (this.snapshot.totalProfit <= -this.config!.sessionLossLimit) {
            this.finish('Stopped', 'Session loss limit reached.');
            return;
        }
        if (this.snapshot.totalProfit >= this.config!.takeProfitLimit) {
            this.finish('Stopped', 'Take-profit limit reached.');
            return;
        }
        if (this.snapshot.tradeNumber >= this.config!.maxTrades) {
            this.finish('Stopped', 'Maximum trade count reached.');
            return;
        }

        if (status === 'lost') {
            this.snapshot.recoveryActive = true;
            this.snapshot.strategy = 'DIGITUNDER';
            const nextStake = this.snapshot.stake * this.config!.recoveryMultiplier;
            if (nextStake > this.config!.maxStake) {
                this.finish('Stopped', 'Recovery stake would exceed the configured maximum stake.');
                return;
            }
            this.snapshot.stake = nextStake;
        } else {
            this.snapshot.recoveryActive = false;
            this.snapshot.strategy = 'DIGITOVER';
            this.snapshot.stake = this.config!.stake;
        }
        this.beginNextAnalysis();
    }

    private beginNextAnalysis() {
        if (this.stopped) return;
        const now = Date.now();
        this.analysisStartedAt = now;
        this.analysisDeadline = now + this.config!.maxAnalysisSeconds * 1000;
        this.snapshot.state = 'Analyzing';
        this.snapshot.analysisElapsedMs = 0;
        this.snapshot.analysisRemainingMs = this.config!.maxAnalysisSeconds * 1000;
        this.snapshot.error = '';
        this.publish();
    }

    private readonly updateClock = () => {
        if (this.stopped || !this.config) return;
        const now = Date.now();
        this.snapshot.sessionElapsedMs = now - this.startedAt;
        if (this.snapshot.state === 'Analyzing') {
            this.snapshot.analysisElapsedMs = now - this.analysisStartedAt;
            this.snapshot.analysisRemainingMs = Math.max(0, this.analysisDeadline - now);
            if (now >= this.analysisDeadline) {
                this.finish('Timed out', 'Timed out — no qualifying signal.');
                return;
            }
        }
        if (now >= this.sessionDeadline) {
            this.finish('Stopped', 'Maximum session duration reached.');
            return;
        }
        this.publish();
    };

    private async request(payload: Record<string, unknown>): Promise<Record<string, any>> {
        const response = await new Promise<Record<string, any>>((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('Deriv request timed out. No retry was sent; confirm account activity before restarting.')),
                REQUEST_TIMEOUT_MS
            );
            Promise.resolve()
                .then(() => this.api.send(payload))
                .then(result => {
                    clearTimeout(timeout);
                    resolve(result);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
        });
        const error = responseError(response, 'Deriv request failed.');
        if (error) throw error;
        return response;
    }

    private fail(state: 'Rejected' | 'Disconnected' | 'Error', error: string) {
        this.stopped = true;
        this.snapshot.state = state;
        this.snapshot.error = error;
        this.clearTimer();
        this.cleanup();
        this.publish();
    }

    private finish(state: 'Stopped' | 'Timed out', message: string) {
        this.stopped = true;
        this.snapshot.state = state;
        this.snapshot.error = message;
        this.clearTimer();
        if (this.activeContractId === null && !this.buyRequestSent) {
            this.cleanup();
        } else {
            this.forgetSubscription(this.tickSubscriptionId);
            this.tickSubscriptionId = '';
        }
        this.publish();
    }

    private cleanup() {
        this.messageSubscription?.unsubscribe();
        this.messageSubscription = null;
        this.api.connection.removeEventListener('close', this.handleSocketClose);
        this.forgetSubscription(this.tickSubscriptionId);
        this.forgetSubscription(this.contractSubscriptionId);
        this.tickSubscriptionId = '';
        this.contractSubscriptionId = '';
    }

    private forgetSubscription(id: string) {
        if (!id || this.api.connection.readyState !== OPEN_SOCKET) return;
        void this.api
            .send({ forget: id })
            .then(response => {
                const error = responseError(response, 'Subscription cleanup failed.');
                if (error) throw error;
            })
            .catch(error => console.error(`Could not forget Deriv subscription ${id}:`, error));
    }

    private clearTimer() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private publish() {
        this.onUpdate(this.getSnapshot());
    }

    private requireConfig() {
        if (!this.config) throw new Error('Bot configuration is unavailable.');
        return this.config;
    }

    private errorMessage(error: unknown, fallback: string) {
        return error instanceof Error ? error.message : fallback;
    }
}
