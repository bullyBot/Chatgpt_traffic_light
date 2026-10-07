from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
destination = root / 'artifacts' / 'chatgpt-traffic-light.zip'
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
    for path in sorted((root / 'dist').rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(root / 'dist'))
print(destination)
