"""Extract PDF word rectangles in PDF points, measured from the top left."""
import json
import subprocess
import sys
import xml.etree.ElementTree as ET

xml = subprocess.check_output(['pdftotext', '-bbox-layout', sys.argv[1], '-'])
root = ET.fromstring(xml)
pages = []
for element in root.iter():
    if element.tag.rsplit('}', 1)[-1] != 'page':
        continue
    words = []
    for word in element.iter():
        if word.tag.rsplit('}', 1)[-1] != 'word':
            continue
        box = [float(word.attrib[k]) for k in ['xMin', 'yMin', 'xMax', 'yMax']]
        if box[2] > box[0] and box[3] > box[1]:
            words.append(box + [''.join(word.itertext())])
    pages.append({'width': float(element.attrib['width']), 'height': float(element.attrib['height']), 'words': words})
json.dump(pages, sys.stdout, ensure_ascii=True, separators=(',', ':'))
