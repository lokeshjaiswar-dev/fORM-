// Builds the classic-side half of the fp-bridge/2 conformance harness: the REAL classic step 2 host
// (FormPlusHost + bridgeParentV2 + bridgeProtocolV2 + legacyRecord + fieldsHandle + flag, from the classic checkout) into one
// browser script. Only two seams are replaced, because they are classic's data layer, not the bridge:
// the UploadService (options endpoints) and the legacy RenderElement (the fallback target).
//   CLASSIC_DIR   the classic checkout (default: ../classic next to the fORM- checkout)
//   HARNESS_OUT   output directory
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const classic = path.resolve(process.env.CLASSIC_DIR ?? path.resolve(here, '../../../../../../classic'));
const formplusDir = path.join(classic, 'src/modules/documents/upload/components/doc-properties/formplus');
const nm = (p) => path.join(classic, 'node_modules', p);

const stubSeams = {
  name: 'classic-host-seams',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === '@/api/services/upload.service') return path.join(here, 'upload.service.stub.js');
    if (source === '../FormElements' && importer?.endsWith('FormPlusHost.tsx')) return path.join(here, 'FormElements.stub.jsx');
    return null;
  },
};

export default defineConfig({
  configFile: false,
  root: here,
  logLevel: 'error',
  plugins: [stubSeams],
  esbuild: { jsx: 'automatic', tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } } },
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_PUBLIC_FORMPLUS_UPLOAD_URL': '(window.__FP_URL)',
    'process.env.NEXT_PUBLIC_FORMPLUS_UPLOAD': '"1"',
    'process.env.NEXT_PUBLIC_FORMPLUS_BASE_URL': '""',
  },
  resolve: {
    alias: [
      { find: /^react$/, replacement: nm('react') },
      { find: /^react\/jsx-runtime$/, replacement: nm('react/jsx-runtime') },
      { find: /^react-dom$/, replacement: nm('react-dom') },
      { find: /^react-dom\/client$/, replacement: nm('react-dom/client') },
      { find: '@classic-formplus', replacement: formplusDir },
    ],
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: process.env.HARNESS_OUT ?? path.join(here, '../../../node_modules/.tmp/classic-host-dist'),
    emptyOutDir: true,
    minify: false,
    lib: { entry: path.join(here, 'entry.jsx'), formats: ['iife'], name: 'ClassicHost', fileName: () => 'classic-host.js' },
  },
});
