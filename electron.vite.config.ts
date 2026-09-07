import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { buildDefines, loadCustomer, resolveCustomerId } from './scripts/customer'

/**
 * Which customer this run is for. `QSYS_CUSTOMER=acme npm run dev` switches
 * branding without touching any source; `build-customer.ts` sets the same var.
 */
const customerId = resolveCustomerId()
const customer = loadCustomer(customerId)
const defines = buildDefines(customer)

console.log(`[branding] ${customerId} -> ${customer.config.productName}`)

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Credentials, key material and the Core address exist only in this bundle.
    define: defines.main,
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // A sandboxed preload cannot be an ES module, so this one target is CJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },

  renderer: {
    root: 'src/renderer',
    // Note the absence of __CRED_BLOB__ / __KEY_* / core host here.
    define: defines.renderer,
    plugins: [react(), tailwind()],
    resolve: {
      alias: { ...shared, '@': resolve('src/renderer/src') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
