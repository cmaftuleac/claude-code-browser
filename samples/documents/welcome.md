# Welcome to Claude Code Browser

A short Markdown sample to exercise the **rendered** view. Switch to *Source* with the toolbar above to see the raw text.

## Headings, emphasis, links

> This is a blockquote. The renderer should style it with a left border.

Inline emphasis: *italic*, **bold**, ***bold italic***, ~~strikethrough~~, `inline code`, and [a link](https://anthropic.com).

## Lists

- Apples
- Oranges
  - Mandarins
  - Tangerines
- Pears

1. First
2. Second
3. Third

## Task list

- [x] Wire up MarkdownView
- [x] Hook the toolbar's Source / Rendered toggle
- [ ] Ship to production

## Code

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

```python
def greet(name: str) -> str:
    return f"Hello, {name}!"
```

## Table

| Format   | Viewer       | Notes                          |
|----------|--------------|--------------------------------|
| Markdown | MarkdownView | GFM with code highlighting     |
| CSV      | DataGridView | Virtualized rows               |
| Parquet  | DataGridView | Chunked, byte-range reads      |
| Image    | ImageView    | Click-to-pick color sampler    |
| PDF      | PdfView      | Lazy per-page canvas rendering |

## Math-ish

Just a paragraph with inline `code` and a divider below.

---

Last paragraph. End of file.
