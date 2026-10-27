/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** optional hosted Withings token broker (worker/withings-broker.js) and the app it holds */
  readonly VITE_WITHINGS_BROKER_URL?: string
  readonly VITE_WITHINGS_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
