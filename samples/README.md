# Samples

Tiny representative files for exercising each viewer in `apps/desktop`. Open this folder in the app and click through the tree.

```
samples/
├── media/
│   ├── images/   png · jpg · svg · webp · gif    → ImageView (color picker)
│   ├── audio/    wav · mp3 (silent stub)         → AudioView
│   └── video/    drop your own clips here        → VideoView
├── documents/    md · pdf · rtf · txt            → Markdown / PDF / source
├── data/         csv · tsv · jsonl · ndjson · arrow → DataGridView
├── code/         ts · js · py · go · rs · json · yaml · sql → Monaco
└── unknown/      .xyz / .bin                     → InfoView (default for unknown)
```

## Regenerating binary samples

The binary files (PNG, WAV, PDF, Arrow, etc.) are reproducible from `scripts/gen.mjs`:

```bash
node samples/scripts/gen.mjs
```

Re-run it any time you want fresh fixtures. Video and "real" MP3 are not generated — drop your own files in those folders.
