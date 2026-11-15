#!/bin/bash
# Makes the sample documents the emulator test adds to Docs: one of every kind people send.
set -e
D=${1:-testdocs}; mkdir -p "$D"; cd "$D"
cat > src.html <<'H'
<html><body><h1>Clinic schedule</h1><p>The Roma clinic opens at 8 o'clock on Mondays &amp; Thursdays.</p><table><tr><td>Nurse</td><td>Mpho Lerotholi</td></tr><tr><td>Phone</td><td>5885 1234</td></tr></table><p>Bring your Bukana health booklet.</p></body></html>
H
printf 'Item,Price\nMaize meal 10kg,95\nParaffin 1L,22\n' > prices.csv
which soffice >/dev/null 2>&1 || { sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends libreoffice-writer-nogui libreoffice-calc-nogui > /dev/null; }
soffice --headless --convert-to odt --outdir . src.html > /dev/null 2>&1 || true
for f in docx doc rtf pdf; do soffice --headless --convert-to $f --outdir . src.odt > /dev/null 2>&1 || true; done
soffice --headless --convert-to xlsx --outdir . prices.csv > /dev/null 2>&1 || true
pip install --quiet python-pptx pillow 2>/dev/null || pip install --quiet --break-system-packages python-pptx pillow
python3 - <<'P'
from pptx import Presentation
from PIL import Image, ImageDraw, ImageFont
p = Presentation(); s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = 'Water safety'
s.placeholders[1].text = 'Boil river water for one minute before drinking.'; p.save('talk.pptx')
im = Image.new('RGB', (1200, 500), 'white'); d = ImageDraw.Draw(im)
try: f = ImageFont.truetype('DejaVuSans.ttf', 52)
except Exception: f = ImageFont.load_default()
for i, t in enumerate(['NOTICE: Village meeting', "Saturday 9 am at the chief's place.", 'Bring your ID book.']): d.text((60, 60 + i * 120), t, fill='black', font=f)
im.save('notice.jpg', quality=88)
P
ls | grep -v list.json | python3 -c "import sys,json;print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))" > list.json
ls -la; cat list.json
