import { render } from '@testing-library/react';
import { api_base } from '@/external/bot-skeleton';
import { MemoryRouter, Route, Routes } from 'react-router';
import Layout from '../index';

jest.mock('@/external/bot-skeleton', () => ({
    api_base: { api: null, init: jest.fn(() => Promise.resolve()) },
}));
jest.mock('@/hooks/useStore', () => ({ useStore: () => ({ quick_strategy: { is_open: false } }) }));
jest.mock('@deriv-com/ui', () => ({
    useDevice: () => ({ isDesktop: true, isMobile: false, isTablet: false }),
}));
jest.mock('@/components/shared', () => ({
    crypto_currencies_display_order: [],
    fiat_currencies_display_order: [],
}));
jest.mock('../header', () => () => null);
jest.mock('../footer', () => () => null);
jest.mock('../main-body', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);

const mockApiBase = api_base as unknown as {
    api: { connection: { readyState: number } } | null;
    init: jest.Mock;
};

describe('analysis route authentication initialization', () => {
    beforeEach(() => {
        mockApiBase.api = null;
        mockApiBase.init.mockClear();
        localStorage.clear();
    });

    const renderAt = (path: string) =>
        render(
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route element={<Layout />}>
                        <Route path='analysis' element={<div />} />
                    </Route>
                </Routes>
            </MemoryRouter>
        );

    it('initializes the API on direct analysis navigation', () => {
        renderAt('/analysis');

        expect(mockApiBase.init).toHaveBeenCalledTimes(1);
    });

    it('does not restart an API connection that is already active', () => {
        mockApiBase.api = { connection: { readyState: 1 } };

        renderAt('/analysis');

        expect(mockApiBase.init).not.toHaveBeenCalled();
    });
});
