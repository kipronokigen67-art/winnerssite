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
        const client = new DerivMarketDataClient('app-id', onStatus, jest.fn(), () => {
            attempts += 1;
            if (attempts === 1) throw new Error('WebSocket unavailable');
            socket = new FakeSocket();
            return socket as unknown as WebSocket;
        }, onConnectionError);

        client.connect();
        expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
        expect(onConnectionError).toHaveBeenLastCalledWith(new Error('WebSocket unavailable'));
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

    it('loads live volatility symbols without authorizing or requesting a trade', async () => {
        let socket: FakeSocket | undefined;
        const client = new DerivMarketDataClient('public-app-id', jest.fn(), jest.fn(), url => {
            expect(new URL(url).searchParams.get('app_id')).toBe('public-app-id');
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
                    display_name: 'Volatility 10 Index',
                    market: 'synthetic_index',
                    symbol: 'R_10',
                },
                { display_name: 'EUR/USD', market: 'forex', symbol: 'frxEURUSD' },
            ],
        });

        await expect(symbolsRequest).resolves.toEqual([
            { display_name: 'Volatility 10 Index', market: 'synthetic_index', symbol: 'R_10', pip: undefined, submarket: undefined },
        ]);
        expect(socket?.sent.every(message => !('authorize' in message) && !('buy' in message))).toBe(true);
        client.disconnect();
    });

    it('shares a tick subscription and releases it once', async () => {
        let socket: FakeSocket | undefined;
        const onTick = jest.fn();
        const client = new DerivMarketDataClient('app-id', jest.fn(), onTick, () => {
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
            'app-id',
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
            new Error('Deriv market-data connection closed. Reconnecting.')
        );

        client.disconnect();
        expect(onStatus).toHaveBeenLastCalledWith('disconnected');
    });

    it('rejects pending requests when the public feed sends malformed JSON', async () => {
        let socket: FakeSocket | undefined;
        const client = new DerivMarketDataClient('app-id', jest.fn(), jest.fn(), () => {
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

    it('filters volatility markets from the dynamically returned active-symbol list', () => {
        expect(
            getVolatilitySymbols([
                { display_name: 'Volatility 25 (1s) Index', symbol: 'R_25' },
                { display_name: 'Boom 500 Index', symbol: 'BOOM500' },
            ]).map(({ symbol }) => symbol)
        ).toEqual(['R_25']);
    });
});
