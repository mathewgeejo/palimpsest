import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // p5.js is a single large module; the app has no other heavy dependencies.
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      onwarn(warning, warn) {
        // p5's bundled zod dependency carries @__PURE__ comments Rollup cannot place; harmless.
        if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules/zod')) return;
        warn(warning);
      },
    },
  },
});
