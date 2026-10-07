# Descriptive View

Tags View for the values of the `descriptive` frontmatter property. A copy of
`obsidian-tags-view` with the source swapped from tags to that property.

- a tree of every value with the number of notes carrying it; `project/dormant`
  nests under `project`, whose count is every note under it
- four sort orders, nested values on/off, collapse/expand all, a filter box
- click a value to search `[descriptive:/^value(\/|$)/]` in a pane of its own
  below the view; the × closes it, and it closes when you switch tabs
- Settings → Hidden values; notes are never modified

Command: **Open descriptive view** (opens beside Tags View if it is open).

Install: `./install.sh` copies `main.js`, `manifest.json`, `styles.css` into
the vault folder named in `.dev-vault`. No build step.
