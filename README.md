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

Build & install into the vault: `npm install && npm run install-vault`
