import {
    getLastDigit,
    Over2Under7Bot,
    validateNativeBotConfig,
    type NativeBotApi,
    type NativeBotConfig,
} from '../over2-under7-bot';

class BotApiHarness {
    connection = new EventTarget() as EventTarget & { readyState: number };
    listeners = new Set<(message: { data: Record<string, any> }) => void>();
    requests: Array<Record<string, any>> = [];
    contractId = 1000;
    rejectProposal = false;
    rejectBuy = false;
    buyResponse: Promise<Record<string, any>> | null = null;
    emitInitialTick = true;
    availableContracts = ['DIGITOVER', 'DIGITUNDER'];
    send = jest.fn(async (request: Record<string, any>) => {
        this.requests.push(request);
        if (request.active_symbols) {
            return { active_symbols: [{ symbol: 'R_10', display_name: 'Volatility 10 Index', pip: 2, exchange_is_open: 1 }] };
        }
        if (request.contracts_for) {
            return { contracts_for: { available: this.availableContracts.map(contract_type => ({ contract_type })) } };
        }
        if (request.ticks_history) {
            return { history: { prices: ['123.45'], times: [1_700_000_000] } };
        }
        if (request.ticks) {
            return {
                subscription: { id: 'ticks-1' },
                ...(this.emitInitialTick ? { tick: { symbol: 'R_10', quote: 123.45, epoch: 1_700_000_001 } } : {}),
            };
        }
        if (request.proposal) {
            if (this.rejectProposal) return { error: { code: 'InvalidContractProposal', message: 'Proposal rejected.' } };
            return { proposal: { id: `proposal-${this.contractId}`, ask_price: request.amount } };
        }
        if (request.buy) {
            if (this.rejectBuy) return { error: { code: 'InsufficientBalance', message: 'Purchase rejected.' } };
            if (this.buyResponse) return this.buyResponse;
            this.contractId += 1;
            return { buy: { contract_id: this.contractId, buy_price: request.price } };
        }
        if (request.proposal_open_contract) {
            return {
                subscription: { id: `contract-${request.contract_id}` },
                proposal_open_contract: {
                    contract_id: request.contract_id,
                    status: 'open',
                    is_sold: 0,
                    buy_price: 1,
                },
            };
        }
        return {};
    });

    api(): NativeBotApi {
        this.connection.readyState = 1;
        return {
            authorized: true,
            activeLoginId: 'VRTC123',
            connection: this.connection,
            send: this.send,
            onMessage: () => ({
                subscribe: listener => {
                    this.listeners.add(listener);
                    return { unsubscribe: () => this.listeners.delete(listener) };
                },
            }),
        };
    }

    emit(data: Record<string, any>) {
        this.listeners.forEach(listener => listener({ data }));
    }
}

const validConfig = (overrides: Partial<NativeBotConfig> = {}): NativeBotConfig => ({
    symbol: 'R_10',
    currency: 'USD',
    accountId: 'VRTC123',
    accountType: 'demo',
    allowRealMoney: false,
    stake: 1,
    maxStake: 5,
    sessionLossLimit: 20,
    takeProfitLimit: 10,
    maxTrades: 10,
    maxAnalysisSeconds: 5,
    maxSessionSeconds: 30,
    historyLookback: 100,
    recoveryMultiplier: 2,
    ...overrides,
});

const flushPromises = async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

const startBot = async (
    harness: BotApiHarness,
    onUpdate = jest.fn(),
    config: NativeBotConfig = validConfig()
) => {
    const bot = new Over2Under7Bot(harness.api(), onUpdate);
    await bot.start(config);
    await flushPromises();
    return { bot, onUpdate };
};

describe('Over 2 to Under 7 native bot', () => {
    afterEach(() => jest.useRealTimers());

    it('validates demo-first configuration and requires explicit real authorization', () => {
        expect(validateNativeBotConfig(validConfig())).toBeNull();
        expect(validateNativeBotConfig(validConfig({ accountType: 'real' }))).toContain('Explicit real-money');
        expect(validateNativeBotConfig(validConfig({ maxStake: 0.5 }))).toContain('Maximum stake');
        expect(validateNativeBotConfig(validConfig({ maxAnalysisSeconds: 601 }))).toContain('Maximum analysis time');
        expect(getLastDigit(123.45, 2)).toBe(5);
    });

    it('discovers actual contracts and starts with the configured Over 2 proposal', async () => {
        const harness = new BotApiHarness();
        const { bot } = await startBot(harness);

        expect(bot.getSnapshot()).toMatchObject({ state: 'Open', strategy: 'DIGITOVER', tradeNumber: 1 });
        expect(bot.getSnapshot().availableContracts).toEqual(['DIGITOVER', 'DIGITUNDER']);
        expect(harness.requests.find(request => request.contracts_for)).toEqual({ contracts_for: 'R_10' });
        expect(harness.requests.find(request => request.proposal)).toMatchObject({
            proposal: 1,
            contract_type: 'DIGITOVER',
            barrier: '2',
            duration: 1,
            duration_unit: 't',
            underlying_symbol: 'R_10',
        });
        bot.stop();
    });

    it('switches to Under 7 only after a confirmed loss and resets after a confirmed win', async () => {
        const harness = new BotApiHarness();
        const { bot } = await startBot(harness);
        const firstContract = bot.getSnapshot().lastResult?.contractId ?? 1001;

        harness.emit({
            msg_type: 'proposal_open_contract',
            proposal_open_contract: { contract_id: firstContract, status: 'lost', is_sold: 1, profit: -1, buy_price: 1 },
            subscription: { id: `contract-${firstContract}` },
        });
        await flushPromises();
        expect(bot.getSnapshot()).toMatchObject({ state: 'Analyzing', strategy: 'DIGITUNDER', recoveryActive: true, stake: 2 });

        harness.emit({ msg_type: 'tick', tick: { symbol: 'R_10', quote: 123.44, epoch: 1_700_000_002 } });
        await flushPromises();
        const proposals = harness.requests.filter(request => request.proposal);
        expect(proposals[proposals.length - 1]).toMatchObject({
            contract_type: 'DIGITUNDER',
            barrier: '7',
            amount: 2,
        });
        expect(bot.getSnapshot().state).toBe('Open');

        const secondContract = 1002;
        harness.emit({
            msg_type: 'proposal_open_contract',
            proposal_open_contract: { contract_id: secondContract, status: 'won', is_sold: 1, profit: 0.8, buy_price: 2 },
            subscription: { id: `contract-${secondContract}` },
        });
        expect(bot.getSnapshot()).toMatchObject({ strategy: 'DIGITOVER', recoveryActive: false, stake: 1 });
        expect(bot.getSnapshot().totalProfit).toBeCloseTo(-0.2);
        bot.stop();
    });

    it('times out without buying when no qualifying tick arrives', async () => {
        jest.useFakeTimers();
        const harness = new BotApiHarness();
        harness.emitInitialTick = false;
        const bot = new Over2Under7Bot(harness.api(), jest.fn());
        await bot.start(validConfig());
        jest.advanceTimersByTime(5_000);

        expect(bot.getSnapshot()).toMatchObject({ state: 'Timed out', error: 'Timed out — no qualifying signal.' });
        expect(harness.requests.some(request => request.buy)).toBe(false);
    });

    it('stops when the maximum session duration expires', async () => {
        jest.useFakeTimers();
        const harness = new BotApiHarness();
        harness.emitInitialTick = false;
        const bot = new Over2Under7Bot(harness.api(), jest.fn());
        await bot.start(validConfig({ maxAnalysisSeconds: 60, maxSessionSeconds: 30 }));
        jest.advanceTimersByTime(30_000);

        expect(bot.getSnapshot()).toMatchObject({ state: 'Stopped', error: 'Maximum session duration reached.' });
        expect(harness.requests.some(request => request.buy)).toBe(false);
    });

    it('stops during analysis and never resumes on subsequent ticks', async () => {
        const harness = new BotApiHarness();
        harness.emitInitialTick = false;
        const bot = new Over2Under7Bot(harness.api(), jest.fn());
        await bot.start(validConfig());
        bot.stop();
        harness.emit({ msg_type: 'tick', tick: { symbol: 'R_10', quote: 123.45, epoch: 1_700_000_003 } });

        expect(bot.getSnapshot().state).toBe('Stopped');
        expect(harness.requests.some(request => request.buy)).toBe(false);
        expect(harness.requests.some(request => request.forget === 'ticks-1')).toBe(true);
    });

    it('rejects a market without both required contracts and fails closed on proposal and purchase rejection', async () => {
        const unavailable = new BotApiHarness();
        unavailable.availableContracts = ['DIGITOVER'];
        const unavailableBot = new Over2Under7Bot(unavailable.api(), jest.fn());
        await unavailableBot.start(validConfig());
        expect(unavailableBot.getSnapshot().state).toBe('Error');
        expect(unavailable.requests.some(request => request.buy)).toBe(false);

        const rejected = new BotApiHarness();
        rejected.rejectProposal = true;
        const rejectedBot = new Over2Under7Bot(rejected.api(), jest.fn());
        await rejectedBot.start(validConfig());
        await flushPromises();
        expect(rejectedBot.getSnapshot()).toMatchObject({ state: 'Rejected', error: 'InvalidContractProposal: Proposal rejected.' });
        expect(rejected.requests.some(request => request.buy)).toBe(false);

        const rejectedBuy = new BotApiHarness();
        rejectedBuy.rejectBuy = true;
        const rejectedBuyBot = new Over2Under7Bot(rejectedBuy.api(), jest.fn());
        await rejectedBuyBot.start(validConfig());
        await flushPromises();
        expect(rejectedBuyBot.getSnapshot()).toMatchObject({ state: 'Rejected', error: 'InsufficientBalance: Purchase rejected.' });
        expect(rejectedBuyBot.canStartAnotherSession()).toBe(true);
    });

    it('stops after the confirmed contract result when Stop is pressed while open', async () => {
        const harness = new BotApiHarness();
        const { bot } = await startBot(harness);
        bot.stop();
        harness.emit({
            msg_type: 'proposal_open_contract',
            proposal_open_contract: { contract_id: 1001, status: 'won', is_sold: 1, profit: 0.8, buy_price: 1 },
            subscription: { id: 'contract-1001' },
        });

        expect(bot.getSnapshot()).toMatchObject({ state: 'Won', lastResult: { status: 'won', profit: 0.8 } });
        expect(harness.requests.filter(request => request.buy)).toHaveLength(1);
    });

    it('prevents a second purchase after duplicate qualifying ticks', async () => {
        const harness = new BotApiHarness();
        const { bot } = await startBot(harness);
        harness.emit({ msg_type: 'tick', tick: { symbol: 'R_10', quote: 123.46, epoch: 1_700_000_002 } });
        harness.emit({ msg_type: 'tick', tick: { symbol: 'R_10', quote: 123.47, epoch: 1_700_000_003 } });
        await flushPromises();

        expect(harness.requests.filter(request => request.buy)).toHaveLength(1);
        bot.stop();
    });

    it('does not show an outcome when Deriv has not confirmed a numeric profit', async () => {
        const harness = new BotApiHarness();
        const { bot } = await startBot(harness);
        harness.emit({
            msg_type: 'proposal_open_contract',
            proposal_open_contract: {
                contract_id: 1001,
                status: 'won',
                is_sold: 1,
                profit: null,
                buy_price: 1,
                balance_after: null,
            },
        });

        expect(bot.getSnapshot()).toMatchObject({ state: 'Open', lastResult: null, totalProfit: 0 });
        bot.stop();
    });

    it('stops at trade, loss, take-profit, and recovery stake limits', async () => {
        const cases = [
            { config: validConfig({ maxTrades: 1 }), profit: -1, message: 'Maximum trade count reached.' },
            { config: validConfig({ sessionLossLimit: 0.5 }), profit: -1, message: 'Session loss limit reached.' },
            { config: validConfig({ takeProfitLimit: 0.5 }), profit: 1, message: 'Take-profit limit reached.' },
            { config: validConfig({ maxStake: 1.5 }), profit: -1, message: 'Recovery stake would exceed the configured maximum stake.' },
        ];

        for (const { config, profit, message } of cases) {
            const harness = new BotApiHarness();
            const { bot } = await startBot(harness, jest.fn(), config);
            harness.emit({
                msg_type: 'proposal_open_contract',
                proposal_open_contract: {
                    contract_id: 1001,
                    status: profit > 0 ? 'won' : 'lost',
                    is_sold: 1,
                    profit,
                    buy_price: 1,
                },
            });

            expect(bot.getSnapshot()).toMatchObject({ state: 'Stopped', error: message });
            expect(harness.requests.filter(request => request.proposal)).toHaveLength(1);
            bot.stop();
        }
    });

    it('locks restart when a stopped purchase response is uncertain until explicitly verified', async () => {
        let rejectBuy: (error: Error) => void = () => {};
        const harness = new BotApiHarness();
        harness.buyResponse = new Promise((_resolve, reject) => {
            rejectBuy = reject;
        });
        const { bot } = await startBot(harness);

        expect(bot.getSnapshot().state).toBe('Buying');
        bot.stop();
        expect(bot.canStartAnotherSession()).toBe(false);
        rejectBuy(new Error('Connection lost before confirmation.'));
        await flushPromises();

        expect(bot.getSnapshot().state).toBe('Error');
        expect(bot.hasUnresolvedExecution()).toBe(true);
        expect(bot.canStartAnotherSession()).toBe(false);
        bot.confirmNoUnresolvedTrade();
        expect(bot.hasUnresolvedExecution()).toBe(false);
        expect(bot.canStartAnotherSession()).toBe(true);
    });

    it('stops safely on a socket disconnect without retrying a purchase', async () => {
        const harness = new BotApiHarness();
        const { bot } = await startBot(harness);
        harness.connection.readyState = 3;
        harness.connection.dispatchEvent(new Event('close'));

        expect(bot.getSnapshot().state).toBe('Disconnected');
        expect(harness.requests.filter(request => request.buy)).toHaveLength(1);
        expect(bot.canStartAnotherSession()).toBe(false);
        harness.connection.readyState = 1;
        harness.emit({ msg_type: 'tick', tick: { symbol: 'R_10', quote: 123.46, epoch: 1_700_000_003 } });
        await flushPromises();
        expect(harness.requests.filter(request => request.buy)).toHaveLength(1);
        expect(bot.getSnapshot().state).toBe('Disconnected');
    });
});
