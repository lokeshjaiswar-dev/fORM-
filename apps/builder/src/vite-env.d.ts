/// <reference types="vite/client" />

/*
 * Build-time switches of the embed pages (all optional; unset = the hardened default).
 *
 * VITE_FP_LEGACY_DESCRIPTOR  '1' = the M2 build (SEC-DESIGN 1.12): also accepts a `#fp=` descriptor and reads the user's DMS token from
 *                            the cookie as before. The legacy modules (embed/legacy/**) are reached only by a dynamic import behind
 *                            this flag, so a default build contains none of them.
 * VITE_FP_DEV_OVERRIDES      '1' = dev builds: `?fp_profile=` and `#fpt=...&fpv=<verifier>`. Dead code in production.
 */
interface ImportMetaEnv {
  readonly VITE_FP_LEGACY_DESCRIPTOR?: string;
  readonly VITE_FP_DEV_OVERRIDES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
