import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createEcrClient, type EcrClient, type EcrClientOptions } from './client.js';

const EcrContext = createContext<EcrClient | null>(null);

export interface EcrProviderProps extends EcrClientOptions {
  /** A client to use; otherwise one is made from `baseUrl` and `fetch`. */
  client?: EcrClient;
  children?: ReactNode;
}

/** Makes the till server's client available to the hooks below it. */
export function EcrProvider({ client, baseUrl, fetch, children }: EcrProviderProps) {
  const value = useMemo(() => client ?? createEcrClient({ baseUrl, fetch }), [client, baseUrl, fetch]);
  return <EcrContext.Provider value={value}>{children}</EcrContext.Provider>;
}

/** The client of the nearest {@link EcrProvider}. */
export function useEcrClient(): EcrClient {
  const client = useContext(EcrContext);
  if (client === null) throw new Error('useEcrClient must be used inside <EcrProvider>');
  return client;
}
