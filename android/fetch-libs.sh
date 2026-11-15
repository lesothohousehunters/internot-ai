#!/bin/bash
# Fetches the libraries that read PDFs and the text in pictures into the app folder. The build runs this once.
set -e
A=$(cd "$1" && pwd); T=$(mktemp -d); cd "$T"
npm pack pdfjs-dist@3.11.174 tesseract.js@5.1.1 tesseract.js-core@5.1.1 @tesseract.js-data/eng@1.0.0 > /dev/null
for f in *.tgz; do mkdir -p "x/${f%.tgz}"; tar xzf "$f" -C "x/${f%.tgz}"; done
mkdir -p "$A/lib/pdfjs" "$A/lib/ocr"
cp x/pdfjs*/package/legacy/build/pdf.min.js x/pdfjs*/package/legacy/build/pdf.worker.min.js "$A/lib/pdfjs/"
cp x/tesseract.js-5*/package/dist/tesseract.min.js x/tesseract.js-5*/package/dist/worker.min.js "$A/lib/ocr/"
cp x/tesseract.js-core*/package/tesseract-core-lstm.wasm.js x/tesseract.js-core*/package/tesseract-core-simd-lstm.wasm.js "$A/lib/ocr/"
gunzip -c x/tesseract.js-data*/package/4.0.0_best_int/eng.traineddata.gz > "$A/lib/ocr/eng.traineddata"
ls -la "$A/lib/pdfjs" "$A/lib/ocr"
