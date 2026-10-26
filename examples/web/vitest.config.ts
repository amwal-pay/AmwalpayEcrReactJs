import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The page's own smoke test: `npx vitest run --root web` from examples/.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.tsx'],
    environment: 'jsdom',
  },
});
