/**
 * pdf.js worker setup. Vite resolves the worker entry to a real worker bundle
 * via the `?url` import; pdf.js loads it via `workerSrc`.
 *
 * Importing this module configures pdf.js globally. PdfView imports it once.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
