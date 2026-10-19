import type { AnalysisTick } from './analysis-engine';

export type MarketDataStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type MarketSymbol = {
    symbol: string;
    display_name: string;
    market?: string;
    submarket?: string;
    pip?: number;
};

export type MarketTick = AnalysisTick & {
    symbol: string;
};

type ApiMessage = {
    active_symbols?: unknown[];
    contracts_for?: { available?: unknown[] };
    error?: { code?: string; message?: string };
    history?: { prices?: Array<number | string>; times?: number[] };
    msg_type?: string;
    req_id?: number;
    subscription?: { id?: string };
    tick?: { epoch?: number; quote?: number | string; symbol?: string };
};

type PendingRequest = {
    reject: (error: Error) => void;
    resolve: (message: ApiMessage) => void;
    timeout: ReturnType<typeof setTimeout>;
};

type TickSubscription = {
    id?: string;
    references: number;
    request: Promise<void>;
};

const DIGIT_CONTRACTS = new Set(['DIGITDIFF', 'DIGITEVEN', 'DIGITMATCH', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER']);
const WS_URL = 'wss://ws.derivws.com/websockets/v3';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export const isMarketTickFresh = (
    tickEpoch: number,
    now: number,
    status: MarketDataStatus,
    staleAfterMs = 30_000
) => {
    const age = now - tickEpoch * 1000;
    return status === 'connected' && Number.isFinite(tickEpoch) && age >= -5000 && age <= staleAfterMs;
};

const getApiError = (message: ApiMessage) =>
    new Error(`${message.error?.code ? `${message.error.code}: ` : ''}${message.error?.message || 'Deriv API error'}`);

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const getVolatilitySymbols = (values: unknown[]): MarketSymbol[] =>
    values.flatMap(value => {
        const symbolData = asRecord(value);
        if (!symbolData || typeof symbolData.symbol !== 'string' || typeof symbolData.display_name !== 'string') {
            return [];
        }

        const metadata = [
            symbolData.display_name,
            symbolData.market,
            symbolData.market_display_name,
            symbolData.submarket,
            symbolData.submarket_display_name,
        ]
            .filter((field): field is string => typeof field === 'string')
            .join(' ')
            .toLowerCase();
        if (!metadata.includes('volatility')) return [];

        return [
            {
                symbol: symbolData.symbol,
                display_name: symbolData.display_name,
                market: typeof symbolData.market === 'string' ? symbolData.market : undefined,
                submarket: typeof symbolData.submarket === 'string' ? symbolData.submarket : undefined,
                pip: typeof symbolData.pip === 'number' ? symbolData.pip : Number(symbolData.pip) || undefined,
            },
        ];
    });

export class DerivMarketDataClient {
    private socket: WebSocket | null = null;
    private stopped = false;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private nextRequestId = 1;
    private readonly pendingRequests = new Map<number, PendingRequest>();
    private readonly contractsCache = new Map<string, Promise<string[]>>();
    private readonly tickSubscriptions = new Map<string, TickSubscription>();

    constructor(
        private readonly appId: string,
        private readonly onStatus: (status: MarketDataStatus) => void,
        private readonly onTick: (tick: MarketTick) => void,
        private readonly createSocket: (url: string) => WebSocket = url => new WebSocket(url)
    ) {}

    connect() {
        if (this.stopped || this.socket) return;
        if (!this.appId.trim()) {
            this.onStatus('disconnected');
            return;
        }

        this.onStatus(this.reconnectAttempt ? 'reconnecting' : 'connecting');
        const url = new URL(WS_URL);
        url.searchParams.set('app_id', this.appId);
        const socket = this.createSocket(url.toString());
        this.socket = socket;

        socket.addEventListener('open', this.handleOpen);
        socket.addEventListener('message', this.handleMessage);
        socket.addEventListener('close', this.handleClose);
        socket.addEventListener('error', this.handleError);
    }

    disconnect() {
        this.stopped = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.rejectPendingRequests(new Error('Market-data connection closed.'));
        const socket = this.socket;
        this.socket = null;
        this.tickSubscriptions.clear();
        if (socket) {
            socket.removeEventListener('open', this.handleOpen);
            socket.removeEventListener('message', this.handleMessage);
            socket.removeEventListener('close', this.handleClose);
            socket.removeEventListener('error', this.handleError);
            socket.close();
        }
        this.onStatus('disconnected');
    }

    async getSymbols(): Promise<MarketSymbol[]> {
        const response = await this.request({ active_symbols: 'brief' });
        if (!Array.isArray(response.active_symbols)) throw new Error('Deriv returned no active-symbol list.');
        return getVolatilitySymbols(response.active_symbols);
    }

    getDigitContracts(symbol: string): Promise<string[]> {
        const cached = this.contractsCache.get(symbol);
        if (cached) return cached;

        const request = this.request({ contracts_for: symbol }).then(response => {
            const available = response.contracts_for?.available;
            if (!Array.isArray(available)) throw new Error('Deriv returned no available contract list.');
            return [
                ...new Set(
                    available.flatMap(contract => {
                        const record = asRecord(contract);
                        return typeof record?.contract_type === 'string' &&
                            DIGIT_CONTRACTS.has(record.contract_type)
                            ? [record.contract_type]
                            : [];
                    })
                ),
            ];
        });
        this.contractsCache.set(symbol, request);
        request.catch(() => this.contractsCache.delete(symbol));
        return request;
    }

    async getHistory(symbol: string, count: number): Promise<AnalysisTick[]> {
        const requestedCount = Math.max(1, Math.min(1000, Math.floor(count)));
        const response = await this.request({
            ticks_history: symbol,
            count: requestedCount,
            end: 'latest',
            style: 'ticks',
        });
        const prices = response.history?.prices;
        const times = response.history?.times;
        if (!Array.isArray(prices) || !Array.isArray(times) || prices.length !== times.length) {
            throw new Error('Deriv returned incomplete tick-history data.');
        }

        return prices.flatMap((quote, index) => {
            const epoch = Number(times[index]);
            if (!Number.isFinite(epoch) || !Number.isFinite(Number(quote))) return [];
            return [{ epoch, quote }];
        });
    }

    async subscribeTicks(symbol: string): Promise<() => void> {
        let subscription = this.tickSubscriptions.get(symbol);
        if (subscription) {
            subscription.references += 1;
        } else {
            subscription = {
                references: 1,
                request: this.request({ ticks: symbol, subscribe: 1 }).then(response => {
                    const id = response.subscription?.id;
                    if (!id) throw new Error('Deriv did not return a tick-subscription identifier.');
                    const current = this.tickSubscriptions.get(symbol);
                    if (current === subscription) current.id = id;
                }),
            };
            this.tickSubscriptions.set(symbol, subscription);
        }

        const activeSubscription = subscription;
        try {
            await activeSubscription.request;
        } catch (error) {
            if (this.tickSubscriptions.get(symbol) === activeSubscription) {
                this.tickSubscriptions.delete(symbol);
            }
            throw error;
        }

        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (this.tickSubscriptions.get(symbol) !== activeSubscription) return;
            activeSubscription.references -= 1;
            if (activeSubscription.references > 0) return;
            this.tickSubscriptions.delete(symbol);
            if (activeSubscription.id && this.socket?.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ forget: activeSubscription.id }));
            }
        };
    }

    private readonly handleOpen = () => {
        this.reconnectAttempt = 0;
        this.onStatus('connected');
    };

    private readonly handleMessage = (event: MessageEvent<string>) => {
        let message: ApiMessage;
        try {
            message = JSON.parse(event.data) as ApiMessage;
        } catch {
            return;
        }

        if (message.req_id !== undefined) {
            const pending = this.pendingRequests.get(message.req_id);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(message.req_id);
                if (message.error) pending.reject(getApiError(message));
                else pending.resolve(message);
            }
        }

        if (message.msg_type === 'tick' && message.tick) {
            const { epoch, quote, symbol } = message.tick;
            if (typeof symbol === 'string' && Number.isFinite(Number(epoch)) && Number.isFinite(Number(quote))) {
                this.onTick({ symbol, epoch: Number(epoch), quote: quote as number | string });
            }
        }
    };

    private readonly handleClose = () => {
        this.socket = null;
        this.tickSubscriptions.clear();
        this.rejectPendingRequests(new Error('Deriv market-data connection was interrupted.'));
        if (this.stopped) return;
        this.onStatus('reconnecting');
        this.scheduleReconnect();
    };

    private readonly handleError = () => {
        this.socket?.close();
    };

    private scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        const delay = Math.min(1000 * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private request(payload: Record<string, unknown>): Promise<ApiMessage> {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('Deriv market-data connection is not open.'));
        }

        const reqId = this.nextRequestId++;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(reqId);
                reject(new Error('Deriv market-data request timed out.'));
            }, REQUEST_TIMEOUT_MS);
            this.pendingRequests.set(reqId, { resolve, reject, timeout });
            try {
                socket.send(JSON.stringify({ ...payload, req_id: reqId }));
            } catch (error) {
                clearTimeout(timeout);
                this.pendingRequests.delete(reqId);
                reject(error instanceof Error ? error : new Error('Could not send the Deriv market-data request.'));
            }
        });
    }

    private rejectPendingRequests(error: Error) {
        this.pendingRequests.forEach(({ reject, timeout }) => {
            clearTimeout(timeout);
            reject(error);
        });
        this.pendingRequests.clear();
    }
}
