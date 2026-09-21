# NotWallpaperEngine — Assets

Place your icons here:

| File | Size | Used for |
|---|---|---|
| `tray-icon.png` | 16×16 (32×32 for @2x) | Menu bar / system tray icon |
| `tray-icon@2x.png` | 32×32 | macOS retina tray icon |
| `icon.icns` | Multi-resolution | macOS app icon |
| `icon.ico` | Multi-resolution | Windows app icon |
| `icon.png` | 512×512 | Linux app icon |

## Quick icon generation (requires ImageMagick)

```bash
# From a 1024×1024 source PNG:
convert source.png -resize 512x512 icon.png
convert source.png -resize 16x16 tray-icon.png
convert source.png -resize 32x32 tray-icon@2x.png

# macOS .icns (requires iconutil):
mkdir icon.iconset
for size in 16 32 64 128 256 512; do
  convert source.png -resize ${size}x${size} icon.iconset/icon_${size}x${size}.png
  convert source.png -resize $((size*2))x$((size*2)) icon.iconset/icon_${size}x${size}@2x.png
done
iconutil -c icns icon.iconset -o icon.icns

# Windows .ico (requires ImageMagick):
convert source.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```
