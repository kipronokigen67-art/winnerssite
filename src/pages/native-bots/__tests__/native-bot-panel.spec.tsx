import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import NativeBotPanel from '../native-bot-panel';

jest.mock('@/external/bot-skeleton', () => ({ api_base: { api: null } }));
jest.mock('@/hooks/useApiBase', () => ({ useApiBase: jest.fn() }));
jest.mock('@/hooks/useStore', () => ({ useStore: () => ({ client: { checkAndRegenerateWebSocket: jest.fn() } }) }));
jest.mock('@deriv/quill-icons/Illustration', () => ({ DerivLightBotBuilderIcon: () => <span aria-hidden='true'>bot</span> }));

const mockUseApiBase = useApiBase as jest.Mock;
const mockApiBase = api_base as unknown as { api: Record<string, any> | null };

const makeApi = (failBuy = false) => {
    const connection = Object.assign(new EventTarget(), { readyState: 1 });
    const listeners = new Set<(message: { data: Record<string, any> }) => void>();
    const requests: Array<Record<string, any>> = [];
    const send = jest.fn(async (request: Record<string, any>) => {
        requests.push(request);
        if (request.active_symbols) {
            return { active_symbols: [{ symbol: 'R_10', display_name: 'Volatility 10 Index', pip: 2, exchange_is_open: 1 }] };
        }
        if (request.contracts_for) {
            return { contracts_for: { available: [{ contract_type: 'DIGITOVER' }, { contract_type: 'DIGITUNDER' }] } };
        }
        if (request.ticks_history) return { history: { prices: ['123.45'], times: [1_700_000_000] } };
        if (request.ticks) {
            return { subscription: { id: 'ticks-1' }, tick: { symbol: 'R_10', quote: 123.45, epoch: 1_700_000_001 } };
        }
        if (request.proposal) return { proposal: { id: 'proposal-1', ask_price: request.amount } };
        if (request.buy) {
            if (failBuy) throw new Error('Connection lost before purchase confirmation.');
            return { buy: { contract_id: 1001, buy_price: request.price } };
        }
        if (request.proposal_open_contract) {
            return { subscription: { id: 'contract-1' }, proposal_open_contract: { contract_id: 1001, status: 'open', is_sold: 0 } };
        }
        return {};
    });
    return {
        connection,
        requests,
        send,
        onMessage: () => ({
            subscribe: (listener: (message: { data: Record<string, any> }) => void) => {
                listeners.add(listener);
                return { unsubscribe: () => listeners.delete(listener) };
            },
        }),
    };
};

describe('native bot dashboard panel', () => {
    beforeEach(() => {
        mockUseApiBase.mockReturnValue({
            isAuthorized: true,
            connectionStatus: 'opened',
            activeLoginid: 'VRTC123',
            accountList: [{ loginid: 'VRTC123', currency: 'USD', balance: 100, is_virtual: 1 }],
        });
        mockApiBase.api = makeApi();
    });

    it('requires account selection and exposes finite analysis/risk controls', async () => {
        render(<NativeBotPanel />);

        expect(screen.getByRole('heading', { name: 'Over 2 → Under 7 recovery' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Start Bot' })).toBeDisabled();
        expect(screen.getByLabelText('Max signal wait (seconds)')).toHaveValue(30);
        expect(screen.getByRole('button', { name: 'Stop Bot' })).toBeDisabled();
        await screen.findByRole('option', { name: /Volatility 10 Index/ });
    });

    it('starts the native demo bot using discovered market data and exposes Stop', async () => {
        render(<NativeBotPanel />);
        fireEvent.change(screen.getByLabelText('Deriv account'), { target: { value: 'VRTC123' } });
        await screen.findByRole('option', { name: /Volatility 10 Index/ });
        fireEvent.click(screen.getByRole('button', { name: 'Start Bot' }));

        await waitFor(() => expect(screen.getByText('Open')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: 'Stop Bot' })).toBeEnabled();
        expect((mockApiBase.api as ReturnType<typeof makeApi>).requests.some(request => request.proposal)).toBe(true);
        expect((mockApiBase.api as ReturnType<typeof makeApi>).requests.some(request => request.buy)).toBe(true);
    });

    it('requires manual verification before restarting after an uncertain purchase response', async () => {
        mockApiBase.api = makeApi(true);
        render(<NativeBotPanel />);
        fireEvent.change(screen.getByLabelText('Deriv account'), { target: { value: 'VRTC123' } });
        await screen.findByRole('option', { name: /Volatility 10 Index/ });
        fireEvent.click(screen.getByRole('button', { name: 'Start Bot' }));

        const verifyButton = await screen.findByRole('button', { name: 'I verified there is no unresolved trade' });
        expect(screen.getByRole('button', { name: 'Start Bot' })).toBeDisabled();
        fireEvent.click(verifyButton);
        expect(screen.getByRole('button', { name: 'Start Bot' })).toBeEnabled();
    });
});
