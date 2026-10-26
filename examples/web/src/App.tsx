import { useEcrLog, useMeta } from '@amwalpay/ecr-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LogPanel } from './LogPanel';
import { TerminalsScreen } from './TerminalsScreen';
import { TransactionScreen, type ScreenHandle } from './TransactionScreen';
import { PageServices } from './ui';

const TITLE = 'Amwal ECR Example';
// Settings live on the Terminals screen (Android ECR-simulator / WPF parity).
const ROUTES = ['transaction', 'terminals'] as const;
type Route = (typeof ROUTES)[number];

function routeFromHash(): Route {
  const hash = location.hash.slice(1);
  return (ROUTES as readonly string[]).includes(hash) ? (hash as Route) : 'transaction';
}

export function App() {
  return (
    <PageServices>
      <Page />
    </PageServices>
  );
}

function Page() {
  const { meta, error, loading } = useMeta();
  const [route, setRoute] = useState<Route>(() => {
    // Old bookmarks / docs links to #settings → Terminals (where settings live).
    if (location.hash === '#settings') location.replace('#terminals');
    return routeFromHash();
  });
  const [logOpen, setLogOpen] = useState(false);
  const log = useEcrLog({ open: logOpen });
  const screens = {
    transaction: useRef<ScreenHandle>(null),
    terminals: useRef<ScreenHandle>(null),
  };
  const moveFocus = useRef(false);

  useEffect(() => {
    const onHash = () => {
      if (location.hash === '#settings') {
        location.replace('#terminals');
        return;
      }
      moveFocus.current = true;
      setRoute(routeFromHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Each visit: the title, a refresh (terminals or keys may have changed while away;
  // the config card must not be stale), and focus on the screen when the route changed.
  useEffect(() => {
    document.title = `${route[0]!.toUpperCase()}${route.slice(1)} · ${TITLE}`;
    if (!meta) return;
    screens[route].current?.refresh();
    if (moveFocus.current) {
      moveFocus.current = false;
      screens[route].current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, meta]);

  // Escape goes back from the terminals screen, like the WPF window. Not from a field, where
  // it would throw away what is being typed, and never under an open dialog, which uses it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || route === 'transaction' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open]') || (event.target as Element | null)?.closest?.('input, textarea, select')) return;
      location.hash = '#transaction';
    };
    // Keys may have been changed in another tab.
    const onVisible = () => {
      if (!document.hidden && route === 'transaction') screens.transaction.current?.refresh();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  const onFinished = useCallback(() => {
    void log.refresh();
  }, [log.refresh]);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>

      <header className="appbar">
        <h1>Amwal ECR Example</h1>
        <nav aria-label="Sections">
          <a href="#transaction" data-route="transaction" aria-current={route === 'transaction' ? 'page' : undefined}>Transaction</a>
          <a href="#terminals" data-route="terminals" aria-current={route === 'terminals' ? 'page' : undefined}>Terminals</a>
        </nav>
      </header>

      <main id="main">
        <p id="fatal" className="banner error" role="alert" hidden={!error}>
          {error ? 'The app could not be reached. Is it still running?' : ''}
        </p>
        {meta && !loading ? (
          <>
            <TransactionScreen ref={screens.transaction} meta={meta} active={route === 'transaction'} onFinished={onFinished} />
            <TerminalsScreen ref={screens.terminals} meta={meta} active={route === 'terminals'} />
          </>
        ) : null}
      </main>

      {/* Debug output: the SDK's diagnostics, last 500 lines. */}
      <LogPanel log={log} open={logOpen} onToggle={setLogOpen} />
    </>
  );
}
