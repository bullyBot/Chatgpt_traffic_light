from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import shutil

root = Path(__file__).resolve().parent.parent
destination = root / 'artifacts' / 'chatgpt-traffic-light.zip'
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
    for path in sorted((root / 'dist').rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(root / 'dist'))
print(destination)
version = json.loads((root / 'dist' / 'manifest.json').read_text(encoding='utf-8'))['version']
release = root / 'releases' / f'chatgpt-traffic-light-v{version}.zip'
release.parent.mkdir(exist_ok=True)
shutil.copyfile(destination, release)
print(release)
