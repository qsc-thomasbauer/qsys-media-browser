/// <reference types="vite/client" />

/** The non-secret slice of customer config, stamped in at build time. */
declare const __CUSTOMER__: import('@shared/types').RendererConfig

interface Window {
  qsys: import('@shared/ipc').QsysApi
}
