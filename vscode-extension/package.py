#!/usr/bin/env python3
"""Build the dependency-free VSIX without npm downloads or OS temporary files."""
import json
import os
from pathlib import Path
import zipfile
from xml.sax.saxutils import escape

here = Path(__file__).resolve().parent
manifest = json.loads((here / 'package.json').read_text())
scratch = Path(os.environ.get('TYPST_SUMATRA_SCRATCH', here.parent / 'scratch')).resolve()
scratch.mkdir(parents=True, exist_ok=True)
output = scratch / f"{manifest['name']}-{manifest['version']}.vsix"
xml = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{manifest['name']}" Version="{manifest['version']}" Publisher="{manifest['publisher']}" />
    <DisplayName>{escape(manifest['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(manifest['description'])}</Description>
    <Tags>typst,sumatra,wsl,pdf,forward-search</Tags>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{manifest['engines']['vscode']}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" /></Assets>
</PackageManifest>'''
content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="cjs" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>'''
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', xml)
    archive.writestr('[Content_Types].xml', content_types)
    for name in ['package.json', 'extension.cjs', 'core.cjs']:
        archive.write(here / name, 'extension/' + name)
    archive.write(here.parent / 'README.md', 'extension/README.md')
print(output)
