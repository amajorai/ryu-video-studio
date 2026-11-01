# Bundled sticker licenses

The sticker library ships a small, license-clean SVG subset. `assets/catalog.json`
lists every sticker with its `source`; each source's credit line, license URL and
rights text live in `catalog.ts` (`STICKER_SOURCES`) and are recorded on an
imported sticker asset as its `origin` (`provider: "bundled"`), so the project
credits list them. No brand logos are included.

## Emoji: Twemoji (`assets/emoji/`, source `twemoji`)

- 304 emoji SVGs from Twemoji 15.0 (`@twemoji/svg@15.0.0`, the maintained
  fork at <https://github.com/jdecked/twemoji>), unmodified. File names are the
  Unicode code points.
- Graphics: Copyright 2019 Twitter, Inc and other contributors, licensed under
  [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Attribution required: "Twemoji graphics by Twitter, Inc and other
  contributors, licensed under CC-BY 4.0." Videos that publish a Twemoji sticker
  must keep this credit (the Credits panel lists it).
- Names and keywords come from `emojibase-data@17.0.0` (MIT,
  <https://github.com/milesj/emojibase>). Zero-width-joiner sequences, skin-tone
  variants and a few emoji (middle finger, cigarette, pile of poo) are excluded.

## Flags: flag-icons (`assets/flags/`, source `flag-icons`)

- 210 country flags (4:3) from `flag-icons@7.5.0`
  (<https://github.com/lipis/flag-icons>), unmodified. File names are ISO
  3166-1 alpha-2 codes.
- To keep the single-file Companion bundle small, flags whose SVG exceeds
  10 KB (detailed coats of arms, for example Spain, Mexico, Serbia) are not
  bundled.
- License: MIT.

```text
The MIT License (MIT)

Copyright (c) 2013 Panayiotis Lipiridis

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Shapes (`assets/shapes/`, source `ryu`)

- 30 original geometric shapes (circle, ring, polygons, stars, arrows,
  bubbles, banners, underline) drawn for Ryu Video Studio. They are part of the
  app and free to use in videos made with it; no third-party license applies.

## Updating the set

Replace files only from the pinned upstream versions above, keep each entry in
`assets/catalog.json` in sync with its file (`catalog.test.ts` checks that every
entry has a file and every file an entry), and update the counts here.
