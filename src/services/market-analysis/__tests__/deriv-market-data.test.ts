import {
    DerivMarketDataClient,
    getVolatilitySymbols,
    mergeMarketTicks,
    mergeMarketTicksForSymbol,
} from '../deriv-market-data';

class FakeSocket {
    readyState = 0;
    sent: Array<Record<string, unknown>> = [];
    private listeners = new Map<string, EventListener[]>();

    addEventListener(type: string, listener: EventListener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: EventListener) {
        this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter(current => current !== listener)
        );
    }

    send(data: string) {
        this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }

    close() {
        this.readyState = 3;
        this.dispatch('close', new Event('close'));
    }

    open() {
        this.readyState = 1;
        this.dispatch('open', new Event('open'));
    }

    serverClose() {
        this.readyState = 3;
        this.dispatch('close', new Event('close'));
    }

    serverError() {
        this.dispatch('error', new Event('error'));
    }

    message(message: Record<string, unknown>) {
        this.dispatch('message', new MessageEvent('message', { data: JSON.stringify(message) }));
    }

    malformedMessage(data: string) {
        this.dispatch('message', new MessageEvent('message', { data }));
    }

    private dispatch(type: string, event: Event) {
        (this.listeners.get(type) ?? []).forEach(listener => listener(event));
    }
}

describe('Deriv public market-data client', () => {
    it('retries when creating the public WebSocket initially throws', () => {
        jest.useFakeTimers();
        let attempts = 0;
        let socket: FakeSocket | undefined;
        const onStatus = jest.fn();
        const onConnectionError = jest.fn();
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const client = new DerivMarketDataClient(onStatus, jest.fn(), () => {
            attempts += 1;
            if (attempts === 1) throw new Error('WebSocket unavailable');
            socket = new FakeSocket();
            return socket as unknown as WebSocket;
        }, onConnectionError);

        client.connect();
        expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
        expect(onConnectionError).toHaveBeenLastCalledWith(
            new Error('Could not create a secure Deriv market-data connection. Check the configured Deriv environment. Retrying in 1s.')
        );
        jest.advanceTimersByTime(1000);

        expect(attempts).toBe(2);
        socket?.open();
        expect(onStatus).toHaveBeenLastCalledWith('connected');
        expect(onConnectionError).toHaveBeenLastCalledWith(null);

        client.disconnect();
        errorSpy.mockRestore();
        jest.useRealTimers();
    });

    it('preserves ticks sharing a timestamp and repeated quotes while merging overlapping history', () => {
        const history = [
            { symbol: 'R_10', epoch: 1_700_000_000, quote: 123.45 },
            { symbol: 'R_10', epoch: 1_700_000_000, quote: 123.46 },
            { symbol: 'R_10', epoch: 1_700_000_000, quote: 123.45 },
        ];

        const merged = mergeMarketTicks([history[0]], history);

        expect(merged).toEqual(history);
    });

    it('keeps stale results from a previously selected market out of the active market sample', () => {
        const existing = [
            { symbol: 'R_10', epoch: 1_700_000_000, quote: 123.45 },
            { symbol: 'R_25', epoch: 1_700_000_001, quote: 456.78 },
        ];
        const incoming = [
            { symbol: 'R_10', epoch: 1_700_000_002, quote: 123.46 },
            { symbol: 'R_25', epoch: 1_700_000_003, quote: 456.79 },
        ];

        expect(mergeMarketTicksForSymbol(existing, incoming, 'R_25')).toEqual([
            existing[1],
            incoming[1],
        ]);
    });

    it('loads live volatility symbols from the public endpoint without an OAuth app ID or authorization', async () => {
        let socket: FakeSocket | undefined;
        const client = new DerivMarketDataClient(jest.fn(), jest.fn(), url => {
            const endpoint = new URL(url);
            expect(endpoint.protocol).toBe('wss:');
            expect(endpoint.hostname).toMatch(/^(staging-)?api\.derivws\.com$/);
            expect(endpoint.pathname).toBe('/trading/v1/options/ws/public');
            expect(endpoint.search).toBe('');
            socket = new FakeSocket();
            return socket as unknown as WebSocket;
        });
        client.connect();
        socket?.open();

        const symbolsRequest = client.getSymbols();
        const request = socket?.sent[0];
        socket?.message({
            msg_type: 'active_symbols',
            req_id: request?.req_id,
            active_symbols: [
                {
                    underlying_symbol_name: 'Volatility 10 Index',
                    market: 'synthetic_index',
                    underlying_symbol: 'R_10',
                    pip_size: 2,
                    subgroup: 'synthetics',
                },
                { underlying_symbol_name: 'EUR/USD', market: 'forex', underlying_symbol: 'frxEURUSD' },
            ],
        });

        await expect(symbolsRequest).resolves.toEqual([
            {
                display_name: 'Volatility 10 Index',
                market: 'synthetic_index',
                symbol: 'R_10',
                pip: 2,
                submarket: 'synthetics',
            },
        ]);
        expect(socket?.sent.every(message => !('authorize' in message) && !('buy' in message))).toBe(true);
        client.disconnect();
    });

    it('does not require a numeric WebSocket app ID when the OAuth client ID is non-numeric', () => {
        const previousAppId = process.env.NEXT_PUBLIC_DERIV_APP_ID;
        process.env.NEXT_PUBLIC_DERIV_APP_ID = 'invalid-legacy-websocket-app-id';
        let socket: FakeSocket | undefined;
        const onStatus = jest.fn();
        const client = new DerivMarketDataClient(onStatus, jest.fn(), url => {
            expect(new URL(url).searchParams.has('app_id')).toBe(false);
            socket = new FakeSocket();
            return socket as unknown as WebSocket;
        });

        try {
            client.connect();
            socket?.open();
            expect(onStatus).toHaveBeenLastCalledWith('connected');
        } finally {
            client.disconnect();
            if (previousAppId === undefined) delete process.env.NEXT_PUBLIC_DERIV_APP_ID;
            else process.env.NEXT_PUBLIC_DERIV_APP_ID = previousAppId;
        }
    });

    it('reads digit contracts and historical ticks using public market-data responses', async () => {
        let socket: FakeSocket | undefined;
        const client = new DerivMarketDataClient(jest.fn(), jest.fn(), () => {
            socket = new FakeSocket();
            return socket as unknown as WebSocket;
        });
        client.connect();
        socket?.open();

        const contractsRequest = client.getDigitContracts('1HZ10V');
        const contractsPayload = socket?.sent[0];
        expect(contractsPayload).toMatchObject({ contracts_for: '1HZ10V' });
        socket?.message({
            msg_type: 'contracts_for',
            req_id: contractsPayload?.req_id as number,
            contracts_for: {
                available: [
                    { contract_type: 'DIGITDIFF' },
                    { contract_type: 'DIGITOVER' },
                    { contract_type: 'CALL' },
                ],
            },
        });
        await expect(contractsRequest).resolves.toEqual(['DIGITDIFF', 'DIGITOVER']);

        const historyRequest = client.getHistory('1HZ10V', 2);
        const historyPayload = socket?.sent[1];
        expect(historyPayload).toMatchObject({
            ticks_history: '1HZ10V',
            count: 2,
            end: 'latest',
            style: 'ticks',
        });
        socket?.message({
            msg_type: 'history',
            req_id: historyPayload?.req_id as number,
            history: { prices: [123.45, 123.46], times: [1_700_000_000, 1_700_000_001] },
        });
        await expect(historyRequest).resolves.toEqual([
            { epoch: 1_700_000_000, quote: 123.45 },
            { epoch: 1_700_000_001, quote: 123.46 },
        ]);
        client.disconnect();
    });

    it('surfaces Deriv API errors instead of waiting for a request timeout', async () => {
        let socket: FakeSocket | undefined;
        const client = new DerivMarketDataClient(jest.fn(), jest.fn(), () => {
            socket = new FakeSocket();
            return socket as unknown as WebSocket;
        });
        client.connect();
        socket?.open();

        const symbolsRequest = client.getSymbols();
        const request = socket?.sent[0];
        socket?.message({
            req_id: request?.req_id as number,
            error: { code: 'InvalidSymbol', message: 'The symbol is not available.' },
        });
        await expect(symbolsRequest).rejects.toThrow('InvalidSymbol: The symbol is not available.');
        client.disconnect();
    });

    it('shares a tick subscription and releases it once', async () => {
        let socket: FakeSocket | undefined;
        const onTick = jest.fn();
        const client = new DerivMarketDataClient(jest.fn(), onTick, () => {
            socket = new FakeSocket();
            return socket as unknown as WebSocket;
        });
        client.connect();
        socket?.open();

        const firstSubscription = client.subscribeTicks('R_10');
        const secondSubscription = client.subscribeTicks('R_10');
        const request = socket?.sent[0];
        socket?.message({
            msg_type: 'tick',
            req_id: request?.req_id,
            subscription: { id: 'ticks-1' },
            tick: { epoch: 1_700_000_000, quote: 123.45, symbol: 'R_10' },
        });

        const [releaseFirst, releaseSecond] = await Promise.all([firstSubscription, secondSubscription]);
        expect(socket?.sent).toHaveLength(1);
        expect(onTick).toHaveBeenCalledWith({ epoch: 1_700_000_000, quote: 123.45, symbol: 'R_10' });

        releaseFirst();
        expect(socket?.sent).toHaveLength(1);
        releaseSecond();
        expect(socket?.sent[1]).toEqual({ forget: 'ticks-1' });
        releaseSecond();
        expect(socket?.sent).toHaveLength(2);
        client.disconnect();
    });

    it('rejects outstanding requests and schedules safe reconnection on disconnect', async () => {
        let socket: FakeSocket | undefined;
        const onStatus = jest.fn();
        const onConnectionError = jest.fn();
        const client = new DerivMarketDataClient(
            onStatus,
            jest.fn(),
            () => {
                socket = new FakeSocket();
                return socket as unknown as WebSocket;
            },
            onConnectionError
        );
        client.connect();
        socket?.open();

        const pendingSymbols = client.getSymbols();
        socket?.serverClose();
        await expect(pendingSymbols).rejects.toThrow('connection was interrupted');
        expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
        expect(onConnectionError).toHaveBeenLastCalledWith(
            new Error('Deriv market-data connection closed unexpectedly. Check network access and retry. Retrying in 1s.')
        );

        client.disconnect();
        expect(onStatus).toHaveBeenLastCalledWith('disconnected');
    });

    it('rejects pending requests when the public feed sends malformed JSON', async () => {
        let socket: FakeSocket | undefined;
        const client = new DerivMarketDataClient(jest.fn(), jest.fn(), () => {
            socket = new FakeSocket();
            return socket as unknown as WebSocket;
        });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        client.connect();
        socket?.open();

        const pendingSymbols = client.getSymbols();
        socket?.malformedMessage('{invalid json');

        await expect(pendingSymbols).rejects.toThrow('Deriv returned an invalid market-data response');
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
        client.disconnect();
    });

    it('reports browser WebSocket failures with a safe network diagnostic', () => {
        jest.useFakeTimers();
        let socket: FakeSocket | undefined;
        const onConnectionError = jest.fn();
        const client = new DerivMarketDataClient(
            jest.fn(),
            jest.fn(),
            () => {
                socket = new FakeSocket();
                return socket as unknown as WebSocket;
            },
            onConnectionError
        );
        client.connect();
        socket?.serverError();

        expect(onConnectionError).toHaveBeenLastCalledWith(
            new Error(
                "The browser could not connect to Deriv's secure public market-data service. Check network access and browser extensions. Retrying in 1s."
            )
        );
        client.disconnect();
        jest.useRealTimers();
    });

    it('filters volatility markets from the dynamically returned active-symbol list', () => {
        expect(
            getVolatilitySymbols([
                { underlying_symbol_name: 'Volatility 25 (1s) Index', underlying_symbol: '1HZ25V' },
                { underlying_symbol_name: 'Boom 500 Index', underlying_symbol: 'BOOM500' },
            ]).map(({ symbol }) => symbol)
        ).toEqual(['1HZ25V']);
    });

    it('stops reconnecting after five retries and reports a useful diagnostic', () => {
        jest.useFakeTimers();
        let socket: FakeSocket | undefined;
        const onStatus = jest.fn();
        const onConnectionError = jest.fn();
        const createSocket = jest.fn(() => {
            socket = new FakeSocket();
            return socket as unknown as WebSocket;
        });
        const client = new DerivMarketDataClient(onStatus, jest.fn(), createSocket, onConnectionError);

        client.connect();
        socket?.open();
        const retryDelays = [1000, 2000, 4000, 8000, 16000];
        retryDelays.forEach(delay => {
            socket?.serverClose();
            jest.advanceTimersByTime(delay);
            socket?.open();
        });
        socket?.serverClose();

        expect(createSocket).toHaveBeenCalledTimes(6);
        expect(onStatus).toHaveBeenLastCalledWith('disconnected');
        expect(onConnectionError).toHaveBeenLastCalledWith(
            new Error('Deriv market data is unavailable after five retries. Reload the page to try again.')
        );
        jest.advanceTimersByTime(60_000);
        expect(createSocket).toHaveBeenCalledTimes(6);

        client.disconnect();
        jest.useRealTimers();
    });
});
