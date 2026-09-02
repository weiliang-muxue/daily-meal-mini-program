# Lucide TabBar icon sources

These SVG files are copied verbatim from the official `lucide-static@1.38.0`
npm package published by the Lucide project. The package metadata identifies
the upstream repository as <https://github.com/lucide-icons/lucide> and the
license as ISC.

| Tab | PNG basename | Official Lucide icon | Official package URL | SHA-256 |
| --- | --- | --- | --- | --- |
| Meal plan | `plan` | `utensils` | <https://unpkg.com/lucide-static@1.38.0/icons/utensils.svg> | `3ba28ffa3126d19070ac5ef7ab8577befabd3a7e95e6df3949b6bd66b19fff6d` |
| Records | `record` | `activity` | <https://unpkg.com/lucide-static@1.38.0/icons/activity.svg> | `9701a434c3dee60d1fd4f3d369d3f3620a24c07900c38eb7d22fa53befb935f8` |
| Shopping | `shopping` | `shopping-basket` | <https://unpkg.com/lucide-static@1.38.0/icons/shopping-basket.svg> | `77e48d67ef88bc5943c315a8f1c4ee75afb3f3d400b5686ddc6fc20cda7150c3` |
| Profile | `profile` | `user-round` | <https://unpkg.com/lucide-static@1.38.0/icons/user-round.svg> | `29bec8f705bfd6e86bfc4deb9f8968f21367afc55b154eee1ec6222199c300c5` |

The PNG files are deterministic raster renderings of these official paths on
an 81 x 81 transparent canvas. Unselected icons center the SVG at 63 x 63
pixels and use `#6d7770` with the upstream 2-unit stroke. Selected icons use a
centered 63 x 63 pixel solid `#176b46` circular state container and render the
same official SVG geometry at 39 x 39 pixels in white with its upstream
2-unit stroke.

Lucide is an outline icon family and does not publish a separate official
filled set. The `-selected.png` files therefore use a filled state container
around the same official geometry instead of inventing filled icon paths or
mixing another icon family. This makes selection discernible by both shape
and color.

Rasterization method: the source SVG is embedded unchanged in an 81 x 81 HTML
viewport, sized and colored with CSS, then captured by installed Chromium in
headless mode with a transparent default background and device scale factor
1. The selected state container is CSS, not a replacement icon path. No
runtime dependency is added to the mini program.
