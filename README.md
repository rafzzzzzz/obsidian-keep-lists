# Keep Lists

Google Keep-style checklists for Obsidian.

Insert a list with the command **Keep Lists: Insert list**, or type a code block:

````
```keep
- [ ] list item 1
- [ ] list item 2
	- [ ] nested under item 2
- [x] done item
```
````

The block stores plain markdown checkboxes, so the note stays readable without the plugin.

- **+ List item** adds an item; **Enter** splits/adds below, **Backspace** on an empty item deletes it
- Drag the grip left of the checkbox to reorder; drag slightly **right** to nest, **left** to un-nest
- **Tab / Shift+Tab** nest / un-nest; ↑/↓ move between items
- Checked items move to the collapsible **completed** section; unchecking returns them to their old spot
- Checking a parent checks its nested items; pasting several lines creates several items
- Item text is markdown: it shows formatted (bold, headings, links…) and switches to raw markdown while you edit it.
  Your Obsidian hotkeys for Bold, Italic, Strikethrough, Highlight, Code, Math, Comment, Insert link,
  Insert wikilink, Set heading 1–6 / Remove heading and Clear formatting apply to the item being edited

Build & install into the vault: `npm install && npm run install-vault`
