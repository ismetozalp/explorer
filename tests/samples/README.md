# Explorer preview test samples

Synthetic sample files for manually exercising every file type that the
Explorer Cockpit plugin can preview (per its detectors in `js/utils.js`).
Everything here was **generated locally** (ffmpeg, Python stdlib, hand-written
XML/SVG) — nothing was downloaded from the internet, and no real user files
were copied in.

Two subfolders exist purely to reduce clutter and give you folders to test
navigation/selection with: `video/` (19 files) and `audio/` (7 files).
Everything else is flat in this directory.

> Note: three files were already present in this directory before this batch
> was generated — `CleanShot 2026-07-06 at 09.04.01.png`,
> `file_example_MP4_1920_18MG.mp4`, `file_example_PNG_3MB.png`. They were left
> untouched (not created or modified by this run) and are not covered below.

## Images — `isImage` → image preview

| File | What it is | Verified |
|---|---|---|
| `sample.png` | 320x240 PNG test pattern | ffprobe: png, 320x240 |
| `sample.jpg` | 320x240 JPEG test pattern | ffprobe: mjpeg, 320x240 |
| `sample.jpeg` | Same as .jpg, alternate extension | ffprobe: mjpeg, 320x240 |
| `sample.gif` | 320x240 GIF test pattern | ffprobe: gif, 320x240 |
| `sample.webp` | 320x240 WebP test pattern | ffprobe: webp, 320x240 |
| `sample.bmp` | 320x240 BMP test pattern | ffprobe: bmp, 320x240 |
| `sample.avif` | 320x240 AVIF (AV1 still picture) | ffprobe: av1, 320x240 |
| `sample.ico` | 64x64 hand-built ICO, wrapping an embedded PNG (modern ICO format) | Header fields (type=1, count=1, 32bpp) verified by struct-parsing the file; ffprobe reads the embedded PNG stream at 64x64 |
| `sample.svg` | Hand-written vector test pattern with colored squares, a circle and text | Parses as well-formed XML |

## PDF — `isPdf` → PDF preview

| File | What it is | Verified |
|---|---|---|
| `sample.pdf` | Hand-built single-page PDF (`%PDF-1.4` … `%%EOF`, correct xref offsets computed in Python), with visible title/body text and a filled rectangle | `pdfinfo` parses it (1 page, 612x792pt); `pdftotext` extracts the exact text; `pdftoppm` renders it to a PNG; Ghostscript processes it without error |

## Video — `isVideo`

`isVideoNative` (`mp4`, `m4v`, `webm`) plays directly in the browser
`<video>` tag. The rest go through Explorer's ffmpeg transcode/remux preview
path — some are already H.264/AAC and only need remuxing, others need a real
transcode.

**Explorer 3.1.6 note:** `sample.ogv` was moved from the native row to the
ffmpeg-remux row below. `.ogv` almost always carries Theora video, and
modern Chrome dropped its Theora decoder — the container-level
`canPlayType('video/ogg')` check still answers "maybe", so a naive
native-eligibility list let the file through to a bare `<video>` and it
played audio with a permanently black picture. `isVideoNative()` no longer
includes `ogv`; it now takes the ffmpeg path like `.ogm` already did.

| File | Codec / container | Preview path | Verified (ffprobe) |
|---|---|---|---|
| `video/sample.mp4` | H.264 + AAC, mp4 | native `<video>` | 320x240, 4.0s |
| `video/sample.m4v` | H.264 + AAC, mp4-family | native `<video>` | 320x240, 4.0s |
| `video/sample.webm` | VP9 + Opus, webm | native `<video>` | 320x240, 4.0s |
| `video/sample.mkv` | H.264 + AAC, matroska | ffmpeg remux | 320x240, 4.0s |
| `video/sample.mov` | H.264 + AAC, quicktime | ffmpeg remux | 320x240, 4.0s |
| `video/sample.m2ts` | H.264 + AAC, mpegts | ffmpeg remux | 320x240, 4.0s |
| `video/sample.mts` | H.264 + AAC, mpegts | ffmpeg remux | 320x240, 4.0s |
| `video/sample.ogv` | Theora + Vorbis, ogg | ffmpeg transcode (3.1.6; was native) | 320x240, 4.0s |
| `video/sample.avi` | MPEG-4 (Xvid-family) + MP3, avi | ffmpeg transcode | 320x240, 4.0s |
| `video/sample.divx` | MPEG-4 tagged DIVX + MP3, avi | ffmpeg transcode | 320x240, 4.0s |
| `video/sample.wmv` | WMV2 + WMAv2, asf | ffmpeg transcode | 320x240, 4.1s |
| `video/sample.asf` | WMV2 + WMAv2, asf | ffmpeg transcode | 320x240, 4.1s |
| `video/sample.flv` | FLV1 + MP3, flv | ffmpeg transcode | 320x240, 4.0s |
| `video/sample.mpg` | MPEG-2 + MP2, mpeg-ps | ffmpeg transcode | 320x240, 4.0s |
| `video/sample.mpeg` | MPEG-2 + MP2, mpeg-ps | ffmpeg transcode | 320x240, 4.0s |
| `video/sample.vob` | MPEG-2 + MP2, DVD mpeg-ps (with nav packets) | ffmpeg transcode | 320x240, 4.0s |
| `video/sample.3gp` | H.263 + AMR-NB, 3gp (176x144, the standard low-res 3GP profile) | ffmpeg transcode | 176x144, 4.0s |
| `video/sample.ogm` | Theora + Vorbis, ogg (`.ogm` extension) | ffmpeg transcode | 320x240, 4.0s |
| `video/sample.rm` | RealVideo 1.0 (rv10) + AC3, RealMedia | ffmpeg transcode | 320x240, 4.0s |

**Not generated: `.rmvb`.** ffmpeg only ships one RealMedia muxer (`rm`); there
is no distinct `rmvb` muxer. Writing a `.rmvb`-named copy of the `.rm` output
would just be an `.rm` file with a relabeled extension, which the task
explicitly said not to ship as if it were genuinely that format. Skipped.

## Audio — `isAudio`

| File | Codec / container | Verified (ffprobe) |
|---|---|---|
| `audio/sample.mp3` | MP3 (libmp3lame) | 44.1kHz, 3.0s |
| `audio/sample.wav` | PCM s16le, WAV | 44.1kHz, 3.0s |
| `audio/sample.ogg` | Vorbis, ogg | 44.1kHz, 3.0s |
| `audio/sample.flac` | FLAC | 44.1kHz, 3.0s |
| `audio/sample.m4a` | AAC, mp4-family | 44.1kHz, 3.0s |
| `audio/sample.aac` | AAC, raw ADTS | 44.1kHz, 3.0s |
| `audio/sample.opus` | Opus, ogg | 48kHz, 3.0s |

All are a 3-second, 440Hz sine tone — recognizable and unambiguous when played.

## Markdown — `isMarkdown` → rendered Markdown preview

| File | What it is |
|---|---|
| `sample.md` | Headings, a list, bold/italic/inline code, a fenced code block, a table, and a link |
| `sample.markdown` | Same idea, alternate extension, so both spellings are covered |

## Word — `isDocx` → rendered document preview

| File | What it is | Verified |
|---|---|---|
| `sample.docx` | Minimal OOXML Word document (`[Content_Types].xml`, `_rels/.rels`, `word/document.xml`) with a title and two visible body paragraphs | Valid zip (`testzip()` clean); all three required parts present; every XML part is well-formed |

## Spreadsheets — `isSpreadsheet` → spreadsheet preview

| File | What it is | Verified |
|---|---|---|
| `sample.xlsx` | Minimal OOXML workbook with **two sheets** ("Fruit", "Numbers"), inline-string cells, a few rows each — exercises the sheet picker | Valid zip; `[Content_Types].xml`, both `_rels`, `xl/workbook.xml`, and both `xl/worksheets/sheetN.xml` present and well-formed |
| `sample.ods` | Minimal ODF spreadsheet with **two tables** ("Sheet1", "Sheet2") in `content.xml`, plus `styles.xml` and `meta.xml` | Valid zip; `mimetype` confirmed to be the **first** zip entry and **stored uncompressed** (`compress_type == ZIP_STORED`), as the ODF spec requires; `META-INF/manifest.xml`, `content.xml`, `styles.xml`, `meta.xml` all present and well-formed. Regenerated once already — the first cut only had `mimetype`/`manifest.xml`/`content.xml` and SheetJS (Explorer's spreadsheet renderer) requires `styles.xml` too, failing with `Could not render spreadsheet: Cannot find file styles.xml in zip`. Verified for real, not just structurally: loaded through Explorer's own renderer path in Node (`XLSX.read()` + `XLSX.utils.sheet_to_html()` from the vendored `js/xlsx.full.min.js`) — both sheets render with their actual cell values and no exception. |
| `sample.csv` | 5 data rows, header row, mixed text/numeric columns | Non-empty, human-readable |

**Not generated: `sample.xls` and `sample.xlsb`.** Legacy binary `.xls` is the
OLE2/CFBF + BIFF8 record format and `.xlsb` is a distinct binary
SpreadsheetML record format — both require substantially more than
hand-written XML-in-a-zip to produce correctly, and no library for either
(e.g. `xlwt`, `pyxlsb`) was available (Python stdlib only, per the task
constraints). Rather than ship a mislabeled or malformed file, both were
skipped.

## Text-like — `isTextLike` → syntax-highlighted text preview

| File | What it is |
|---|---|
| `sample.txt` | Plain prose |
| `sample.log` | Timestamped log lines (INFO/DEBUG/WARN/ERROR) |
| `sample.conf` | INI-style app config |
| `sample.ini` | INI file |
| `sample.json` | Nested JSON (object, array, numbers, booleans) — validated with `json.load` |
| `sample.yaml` / `sample.yml` | YAML mapping + list + nesting, both common extensions |
| `sample.xml` | Well-formed XML catalog document |
| `sample.html` | Small styled HTML page |
| `sample.css` | CSS custom properties + selectors |
| `sample.js` | Small JS script — validated with `node --check` |
| `sample.ts` | Small TypeScript snippet (interface + typed function) |
| `sample.py` | Small Python script — validated with `python3 -m py_compile` |
| `sample.sh` | Small Bash script — validated with `bash -n` |
| `sample.sql` | CREATE TABLE / INSERT / SELECT |
| `Makefile` | Extension-less filename, detected by name not extension |
| `.gitignore` | Dotfile with no base name, only a leading-dot "extension" |

## Not generated (summary)

- **`sample.rmvb`** — no dedicated ffmpeg RMVB muxer exists (only `rm`); a
  renamed `.rm` file would be mislabeled, so it was skipped.
- **`sample.xls`**, **`sample.xlsb`** — legacy binary spreadsheet formats
  (OLE2/BIFF8 and binary SpreadsheetML respectively) are impractical to
  hand-build correctly with Python stdlib alone; skipped rather than risk a
  malformed file.

Every other file in the authoritative type list from `js/utils.js` is present
and was verified (structurally, and where possible by actually
decoding/rendering it) before being left in place.
