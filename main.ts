import {
	Command,
	Editor,
	Keymap,
	KeymapContext,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownRenderer,
	MarkdownView,
	Menu,
	MenuItem,
	Notice,
	Plugin,
	Scope,
	TFile,
	editorLivePreviewField,
	setIcon,
} from "obsidian";
import { Text } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

interface Item {
	text: string;
	checked: boolean;
	indent: 0 | 1;
}

const INDENT_PX = 28;
const NEST_THRESHOLD = 20;
const LINE_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s?(.*)$/;

// Where to put the caret after our own write re-renders the block.
let pendingFocus: { path: string; lineStart: number; idx: number; caret: number; end?: number; at: number } | null =
	null;
// Completed-section collapse state, per block.
const collapsed = new Map<string, boolean>();

function parse(source: string): Item[] {
	const items: Item[] = [];
	for (const line of source.split("\n")) {
		if (!line.trim()) continue;
		const m = LINE_RE.exec(line);
		if (m) {
			items.push({ text: m[3], checked: m[2] !== " ", indent: m[1].length > 0 ? 1 : 0 });
		} else {
			items.push({ text: line.trim().replace(/^[-*+]\s+/, ""), checked: false, indent: 0 });
		}
	}
	normalize(items);
	return items;
}

function serialize(items: Item[]): string {
	return items.map((i) => `${i.indent ? "\t" : ""}- [${i.checked ? "x" : " "}] ${i.text}`).join("\n");
}

function normalize(items: Item[]) {
	if (items.length) items[0].indent = 0;
}

// An item plus, if it is top-level, the nested items that follow it.
function groupLength(items: Item[], idx: number): number {
	if (items[idx].indent === 1) return 1;
	let n = 1;
	while (idx + n < items.length && items[idx + n].indent === 1) n++;
	return n;
}

function getSelectionRange(el: HTMLElement): [number, number] {
	const sel = el.win.getSelection();
	const len = el.textContent?.length ?? 0;
	if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return [len, len];
	const range = sel.getRangeAt(0);
	const offset = (node: Node, off: number) => {
		const pre = el.doc.createRange();
		pre.selectNodeContents(el);
		pre.setEnd(node, off);
		return pre.toString().length;
	};
	return [offset(range.startContainer, range.startOffset), offset(range.endContainer, range.endOffset)];
}

function getCaret(el: HTMLElement): number {
	return getSelectionRange(el)[0];
}

// Switches the row to its raw-markdown editing view and selects start..end.
function setSelection(el: HTMLElement, start: number, end: number) {
	el.closest(".keep-row")?.addClass("keep-editing");
	el.normalize();
	el.focus();
	const sel = el.win.getSelection();
	if (!sel) return;
	const range = el.doc.createRange();
	const node = el.firstChild;
	if (node && node.nodeType === Node.TEXT_NODE) {
		const len = node.textContent?.length ?? 0;
		range.setStart(node, Math.min(start, len));
		range.setEnd(node, Math.min(end, len));
	} else {
		range.selectNodeContents(el);
		range.collapse(false);
	}
	sel.removeAllRanges();
	sel.addRange(range);
}

function setCaret(el: HTMLElement, caret: number) {
	setSelection(el, caret, caret);
}

interface Edit {
	text: string;
	start: number;
	end: number;
}

// Wraps the selection in a marker like **, or removes it if already wrapped.
function toggleWrap(text: string, start: number, end: number, mark: string): Edit {
	const before = text.slice(0, start);
	const sel = text.slice(start, end);
	const after = text.slice(end);
	const n = mark.length;
	// "*" next to "**" is bold, not italics.
	const isBoldEdge = mark === "*" && before.endsWith("**") && !before.endsWith("***");
	if (before.endsWith(mark) && after.startsWith(mark) && !isBoldEdge) {
		return { text: before.slice(0, -n) + sel + after.slice(n), start: start - n, end: end - n };
	}
	if (sel.length >= 2 * n && sel.startsWith(mark) && sel.endsWith(mark)) {
		return { text: before + sel.slice(n, -n) + after, start, end: end - 2 * n };
	}
	return { text: before + mark + sel + mark + after, start: start + n, end: end + n };
}

const HEADING_RE = /^#{1,6}\s+/;

// Sets the heading level (0 removes it); setting the current level toggles it off.
function setHeading(text: string, start: number, end: number, level: number): Edit {
	const old = HEADING_RE.exec(text)?.[0] ?? "";
	const same = old.trim().length === level;
	const prefix = level > 0 && !same ? "#".repeat(level) + " " : "";
	const delta = prefix.length - old.length;
	return {
		text: prefix + text.slice(old.length),
		start: Math.max(prefix.length, start + delta),
		end: Math.max(prefix.length, end + delta),
	};
}

const WRAPS: Record<string, string> = {
	"editor:toggle-bold": "**",
	"editor:toggle-italics": "*",
	"editor:toggle-strikethrough": "~~",
	"editor:toggle-highlight": "==",
	"editor:toggle-code": "`",
	"editor:toggle-inline-math": "$",
	"editor:toggle-comments": "%%",
};

// Right-click menu for an item, laid out like Obsidian's editor menu.
const MENU: { title: string; icon: string; items: [id: string, title: string, icon: string][] }[] = [
	{
		title: "Format",
		icon: "type",
		items: [
			["editor:toggle-bold", "Bold", "bold"],
			["editor:toggle-italics", "Italic", "italic"],
			["editor:toggle-strikethrough", "Strikethrough", "strikethrough"],
			["editor:toggle-highlight", "Highlight", "highlighter"],
			["editor:toggle-code", "Code", "code"],
			["editor:toggle-inline-math", "Math", "sigma"],
			["editor:toggle-comments", "Comment", "percent"],
			["editor:clear-formatting", "Clear formatting", "eraser"],
		],
	},
	{
		title: "Paragraph",
		icon: "pilcrow",
		items: [
			...[1, 2, 3, 4, 5, 6].map((n): [string, string, string] => [`editor:set-heading-${n}`, `Heading ${n}`, `heading-${n}`]),
			["editor:set-heading-0", "Body", "pilcrow"],
		],
	},
	{
		title: "Insert",
		icon: "plus",
		items: [
			["editor:insert-link", "Markdown link", "link"],
			["editor:insert-wikilink", "Wikilink", "link-2"],
		],
	},
];

// Editor commands the text field already handles natively.
const NATIVE = new Set(["editor:undo", "editor:redo", "editor:copy", "editor:cut", "editor:paste"]);

function applyCommand(id: string, text: string, start: number, end: number): Edit | null {
	if (id in WRAPS) return toggleWrap(text, start, end, WRAPS[id]);
	const heading = /^editor:set-heading-(\d)$/.exec(id);
	if (heading) return setHeading(text, start, end, Number(heading[1]));
	const before = text.slice(0, start);
	const sel = text.slice(start, end);
	const after = text.slice(end);
	if (id === "editor:insert-link") {
		const caret = sel ? start + sel.length + 3 : start + 1;
		return { text: `${before}[${sel}]()${after}`, start: caret, end: caret };
	}
	if (id === "editor:insert-wikilink") {
		return { text: `${before}[[${sel}]]${after}`, start: start + 2, end: end + 2 };
	}
	if (id === "editor:clear-formatting") {
		const strip = (s: string) => s.replace(/\*\*|__|~~|==|%%|[*_`$]/g, "");
		if (sel) {
			const cleared = strip(sel);
			return { text: before + cleared + after, start, end: start + cleared.length };
		}
		const cleared = strip(text.replace(HEADING_RE, ""));
		return { text: cleared, start: cleared.length, end: cleared.length };
	}
	return null;
}

function isFence(line: string) {
	return /^\s*(```|~~~)/.test(line);
}

// The keep block containing `pos`, from the start of its opening fence to the end of its closing fence.
function keepBlockAt(doc: Text, pos: number): { from: number; to: number } | null {
	let open: { from: number; fence: string; keep: boolean } | null = null;
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		if (!open && line.from > pos) return null;
		const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line.text);
		if (!m) continue;
		if (!open) {
			open = { from: line.from, fence: m[1], keep: /^\s*keep(\s|$)/.test(m[2]) };
		} else if (m[1][0] === open.fence[0] && m[1].length >= open.fence.length && !m[2].trim()) {
			if (open.from <= pos && pos < line.to) return open.keep ? { from: open.from, to: line.to } : null;
			open = null;
		}
	}
	return null;
}

// Live Preview shows a code block's raw source while the focused editor's cursor is inside it.
// A note that starts with a keep list opens with the cursor on its first line, so whenever the
// editor gets a new document or gains focus with the cursor in a keep block, park the cursor just
// past the block. Moving into the block with the arrow keys still reveals the source.
const parkCursorOutsideLists = ViewPlugin.fromClass(
	class {
		constructor(view: EditorView) {
			this.check(view);
		}
		update(u: ViewUpdate) {
			if (u.focusChanged) this.check(u.view);
		}
		check(view: EditorView) {
			queueMicrotask(() => {
				if (!view.hasFocus || !view.state.field(editorLivePreviewField, false)) return;
				const { doc, selection } = view.state;
				const head = selection.main.head;
				const block = keepBlockAt(doc, head);
				if (!block) return;
				// Obsidian opens a note by scrolling to the cursor at the very start, but once the list
				// renders that position is the whole list widget, and the editor scrolls to its bottom.
				// Undo that and pin the scroll position; otherwise just keep where the user is.
				if (head === 0) view.scrollDOM.scrollTop = 0;
				view.dispatch({
					selection: { anchor: block.to < doc.length ? block.to + 1 : block.to },
					effects: view.scrollSnapshot(),
				});
			});
		}
	},
);

class KeepList {
	private items: Item[];
	private activeEl!: HTMLElement;
	private dirty = false;
	private menuOpen = false;
	private component: MarkdownRenderChild;

	constructor(
		private plugin: KeepListsPlugin,
		private root: HTMLElement,
		source: string,
		private ctx: MarkdownPostProcessorContext,
	) {
		this.items = parse(source);
		this.component = new MarkdownRenderChild(root);
		ctx.addChild(this.component);
		plugin.lists.set(root, this);
		this.root.addClass("keep-list");
		// Keep focus in the text field when clicking controls, so a blur
		// doesn't write (and re-render) before the click lands.
		this.root.addEventListener("mousedown", (e) => {
			e.stopPropagation();
			if (!(e.target as HTMLElement).closest(".keep-text")) e.preventDefault();
		});
		// Our own menu instead of the note editor's, whose actions would
		// land in the note rather than in the item.
		this.root.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const row = (e.target as HTMLElement).closest<HTMLElement>(".keep-row");
			const text = row?.querySelector<HTMLElement>(".keep-text");
			if (row && text) this.showMenu(e, row, text);
		});
		this.render();
		this.restoreFocus();
	}

	private get key() {
		const info = this.ctx.getSectionInfo(this.root);
		return `${this.ctx.sourcePath}:${info?.lineStart ?? 0}`;
	}

	private render() {
		const root = this.root;
		root.empty();
		this.activeEl = root.createDiv("keep-active");

		this.items.forEach((item, idx) => {
			if (!item.checked) this.renderRow(this.activeEl, item, idx, false);
		});

		const add = root.createDiv("keep-add");
		setIcon(add.createSpan("keep-add-icon"), "plus");
		add.createSpan({ text: "List item", cls: "keep-add-label" });
		add.addEventListener("click", () => this.addItem());

		const done = this.items.map((item, idx) => ({ item, idx })).filter((d) => d.item.checked);
		if (done.length) {
			const key = this.key;
			const isCollapsed = collapsed.get(key) ?? false;
			const section = root.createDiv("keep-completed");
			const header = section.createDiv("keep-completed-header");
			setIcon(header.createSpan("keep-chevron"), isCollapsed ? "chevron-right" : "chevron-down");
			header.createSpan({ text: `${done.length} completed item${done.length === 1 ? "" : "s"}` });
			header.addEventListener("click", () => {
				collapsed.set(key, !isCollapsed);
				this.render();
			});
			if (!isCollapsed) {
				const list = section.createDiv("keep-completed-list");
				for (const d of done) this.renderRow(list, d.item, d.idx, true);
			}
		}
	}

	private renderRow(parent: HTMLElement, item: Item, idx: number, completed: boolean) {
		const row = parent.createDiv("keep-row");
		row.dataset.idx = String(idx);
		if (item.indent && !completed) row.addClass("keep-nested");
		if (completed) row.addClass("keep-checked");

		const handle = row.createSpan("keep-handle");
		if (!completed) {
			setIcon(handle, "grip-vertical");
			handle.addEventListener("pointerdown", (e) => this.startDrag(e, idx, row));
		}

		const cb = row.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox keep-checkbox" });
		cb.checked = item.checked;
		cb.addEventListener("change", () => this.toggle(idx, cb.checked));

		if (HEADING_RE.test(item.text)) row.addClass("keep-heading-row");

		// Formatted view, swapped for the raw markdown while editing.
		const shown = row.createDiv("keep-rendered");
		this.renderMarkdown(shown, item.text);
		shown.addEventListener("click", (e) => {
			const link = (e.target as HTMLElement).closest("a");
			if (link) {
				if (link.hasClass("internal-link")) {
					e.preventDefault();
					const href = link.dataset.href ?? link.getAttr("href") ?? "";
					void this.plugin.app.workspace.openLinkText(href, this.ctx.sourcePath, Keymap.isModEvent(e));
				}
				return;
			}
			setCaret(text, item.text.length);
		});

		const text = row.createDiv("keep-text");
		text.contentEditable = "plaintext-only";
		text.textContent = item.text;
		// Don't let the surrounding editor handle typing inside the list.
		for (const ev of ["keydown", "keyup", "keypress", "beforeinput", "input", "paste", "copy", "cut"]) {
			text.addEventListener(ev, (e) => e.stopPropagation());
		}
		text.addEventListener("input", () => {
			item.text = (text.textContent ?? "").replace(/\n/g, " ");
			this.dirty = true;
		});
		text.addEventListener("keydown", (e) => this.onKey(e, idx, text, completed));
		text.addEventListener("paste", (e) => this.onPaste(e, idx, text));
		text.addEventListener("blur", (e) => {
			row.removeClass("keep-editing");
			row.toggleClass("keep-heading-row", HEADING_RE.test(item.text));
			this.renderMarkdown(shown, item.text);
			const next = e.relatedTarget as Node | null;
			if (this.dirty && !this.menuOpen && !(next && this.root.contains(next))) this.save();
		});

		const del = row.createDiv({ cls: "keep-delete", attr: { "aria-label": "Delete item" } });
		setIcon(del, "x");
		del.addEventListener("click", () => this.remove(idx));
	}

	private renderMarkdown(el: HTMLElement, markdown: string) {
		el.empty();
		void MarkdownRenderer.render(this.plugin.app, markdown, el, this.ctx.sourcePath, this.component);
	}

	// Runs an editor command (bold, heading, ...) against the item being edited.
	// Returns false to stop Obsidian from running it on the note's editor.
	onCommand(id: string, cmd: Command | null, el: HTMLElement): boolean | undefined {
		if (NATIVE.has(id)) return true;
		const idx = Number(el.closest<HTMLElement>(".keep-row")?.dataset.idx);
		const item = this.items[idx];
		if (!item) return;
		const [start, end] = getSelectionRange(el);
		const edit = applyCommand(id, item.text, start, end);
		if (edit) {
			item.text = edit.text;
			el.textContent = edit.text;
			setSelection(el, edit.start, edit.end);
			this.dirty = true;
			return false;
		}
		// Any other command that acts on an editor would hit the note behind
		// the list, so swallow it.
		if (cmd && (cmd.editorCallback || cmd.editorCheckCallback)) return false;
	}

	private showMenu(e: MouseEvent, row: HTMLElement, el: HTMLElement) {
		const idx = Number(row.dataset.idx);
		const item = this.items[idx];
		if (!row.hasClass("keep-editing")) setCaret(el, item.text.length);
		const [start, end] = getSelectionRange(el);
		const selected = item.text.slice(start, end);
		const replaceSelection = (insert: string) => {
			const caret = start + insert.length;
			this.applyEdit(idx, { text: item.text.slice(0, start) + insert + item.text.slice(end), start: caret, end: caret });
		};

		const menu = new Menu();
		if (selected) {
			menu.addItem((i) =>
				i.setTitle("Cut").setIcon("scissors").onClick(() => {
					void navigator.clipboard.writeText(selected);
					replaceSelection("");
				}),
			);
			menu.addItem((i) => i.setTitle("Copy").setIcon("copy").onClick(() => navigator.clipboard.writeText(selected)));
		}
		menu.addItem((i) =>
			i.setTitle("Paste").setIcon("clipboard-paste").onClick(async () => {
				replaceSelection((await navigator.clipboard.readText()).replace(/\r?\n/g, " "));
			}),
		);
		menu.addSeparator();
		for (const group of MENU) {
			menu.addItem((parent) => {
				parent.setTitle(group.title).setIcon(group.icon);
				// setSubmenu is internal; fall back to a flat menu without it.
				const sub = (parent as MenuItem & { setSubmenu?: () => Menu }).setSubmenu?.() ?? menu;
				for (const [id, title, icon] of group.items) {
					sub.addItem((i) =>
						i.setTitle(title).setIcon(icon).onClick(() => {
							const edit = applyCommand(id, item.text, start, end);
							if (edit) this.applyEdit(idx, edit);
						}),
					);
				}
			});
		}

		// Don't save (and re-render) on blur while the menu is open, or the
		// chosen action would land on a list that no longer exists.
		this.menuOpen = true;
		menu.onHide(() => {
			this.menuOpen = false;
			if (this.dirty && !this.root.contains(this.root.doc.activeElement)) this.save();
		});
		menu.showAtMouseEvent(e);
	}

	private applyEdit(idx: number, edit: Edit) {
		this.items[idx].text = edit.text;
		this.save({ idx, caret: edit.start, end: edit.end });
	}

	private visibleRows(): HTMLElement[] {
		return Array.from(this.root.querySelectorAll<HTMLElement>(".keep-row"));
	}

	private onKey(e: KeyboardEvent, idx: number, el: HTMLElement, completed: boolean) {
		const item = this.items[idx];
		if (e.key === "Enter") {
			e.preventDefault();
			if (completed) {
				el.blur();
				return;
			}
			const caret = getCaret(el);
			const full = item.text;
			item.text = full.slice(0, caret);
			this.items.splice(idx + 1, 0, { text: full.slice(caret), checked: false, indent: item.indent });
			this.save({ idx: idx + 1, caret: 0 });
		} else if (e.key === "Backspace" && item.text === "") {
			e.preventDefault();
			const rows = this.visibleRows();
			const pos = rows.findIndex((r) => r.dataset.idx === String(idx));
			const prev = pos > 0 ? Number(rows[pos - 1].dataset.idx) : -1;
			this.items.splice(idx, 1);
			normalize(this.items);
			const target = prev > idx ? prev - 1 : prev;
			this.save(target >= 0 ? { idx: target, caret: this.items[target].text.length } : undefined);
		} else if (e.key === "Tab" && !completed) {
			e.preventDefault();
			const caret = getCaret(el);
			if (e.shiftKey) item.indent = 0;
			else if (idx > 0 && groupLength(this.items, idx) === 1) item.indent = 1;
			this.save({ idx, caret });
		} else if (e.key === "Escape") {
			el.blur();
		} else if (e.key.toLowerCase() === "a" && Keymap.isModifier(e, "Mod") && !e.shiftKey && !e.altKey) {
			// The browser would select the whole note; select just this item.
			e.preventDefault();
			setSelection(el, 0, el.textContent?.length ?? 0);
		} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			const rows = this.visibleRows();
			const pos = rows.findIndex((r) => r.dataset.idx === String(idx));
			const next = rows[pos + (e.key === "ArrowUp" ? -1 : 1)];
			const nextText = next?.querySelector<HTMLElement>(".keep-text");
			if (nextText) {
				e.preventDefault();
				setCaret(nextText, getCaret(el));
			}
		}
	}

	// Pasting several lines creates one item per line, like Keep.
	private onPaste(e: ClipboardEvent, idx: number, el: HTMLElement) {
		e.preventDefault();
		const lines = (e.clipboardData?.getData("text/plain") ?? "")
			.split(/\r?\n/)
			.map((l) => l.replace(/^\s*[-*+]\s+(\[[ xX]\]\s*)?/, "").trimEnd())
			.filter((l) => l.trim());
		if (!lines.length) return;
		const caret = getCaret(el);
		const item = this.items[idx];
		const before = item.text.slice(0, caret);
		const after = item.text.slice(caret);
		if (lines.length === 1) {
			item.text = before + lines[0] + after;
			el.textContent = item.text;
			setCaret(el, before.length + lines[0].length);
			this.dirty = true;
			return;
		}
		item.text = before + lines[0];
		const added: Item[] = lines.slice(1).map((text) => ({ text, checked: false, indent: item.indent }));
		const last = added[added.length - 1];
		const caretAt = last.text.length;
		last.text += after;
		this.items.splice(idx + 1, 0, ...added);
		this.save({ idx: idx + added.length, caret: caretAt });
	}

	private addItem() {
		this.items.push({ text: "", checked: false, indent: 0 });
		this.save({ idx: this.items.length - 1, caret: 0 });
	}

	private remove(idx: number) {
		this.items.splice(idx, 1);
		normalize(this.items);
		this.save();
	}

	private toggle(idx: number, checked: boolean) {
		const item = this.items[idx];
		item.checked = checked;
		if (item.indent === 0) {
			// Checking/unchecking a parent takes its nested items along.
			const n = groupLength(this.items, idx);
			for (let i = idx + 1; i < idx + n; i++) this.items[i].checked = checked;
		} else if (!checked) {
			// Unchecking a nested item brings its parent back too.
			for (let i = idx - 1; i >= 0; i--) {
				if (this.items[i].indent === 0) {
					this.items[i].checked = false;
					break;
				}
			}
		}
		this.save();
	}

	private startDrag(e: PointerEvent, idx: number, row: HTMLElement) {
		if (e.button !== 0) return;
		e.preventDefault();
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);

		const len = groupLength(this.items, idx);
		const block = this.items.slice(idx, idx + len);
		const hasChildren = len > 1;
		const origIndent = this.items[idx].indent;

		const rows = Array.from(this.activeEl.querySelectorAll<HTMLElement>(".keep-row"));
		const blockRows = rows.filter((r) => block.includes(this.items[Number(r.dataset.idx)]));
		const others = rows
			.filter((r) => !blockRows.includes(r))
			.map((r) => ({ row: r, item: this.items[Number(r.dataset.idx)] }));
		const firstBlockPos = rows.indexOf(row);
		const origSlot = others.filter((o) => rows.indexOf(o.row) < firstBlockPos).length;

		const indicator = this.activeEl.createDiv("keep-drop-indicator");
		blockRows.forEach((r) => r.addClass("keep-dragging"));
		this.root.addClass("keep-is-dragging");

		const startX = e.clientX;
		const startY = e.clientY;
		let slot = origSlot;
		let indent: 0 | 1 = origIndent;

		const onMove = (ev: PointerEvent) => {
			const dx = ev.clientX - startX;
			const dy = ev.clientY - startY;
			slot = others.filter((o) => {
				const r = o.row.getBoundingClientRect();
				return r.top + r.height / 2 < ev.clientY;
			}).length;
			// Dragging slightly right nests the item; slightly left un-nests it.
			indent = dx > NEST_THRESHOLD ? 1 : dx < -NEST_THRESHOLD ? 0 : origIndent;
			if (hasChildren || slot === 0) indent = 0;

			const shift = (indent - origIndent) * INDENT_PX;
			blockRows.forEach((r) => (r.style.transform = `translate(${shift}px, ${dy}px)`));

			const box = this.activeEl.getBoundingClientRect();
			let y: number;
			if (others.length === 0) y = row.getBoundingClientRect().top - box.top;
			else if (slot < others.length) y = others[slot].row.getBoundingClientRect().top - box.top;
			else y = others[others.length - 1].row.getBoundingClientRect().bottom - box.top;
			indicator.style.top = `${y - 1}px`;
			indicator.style.left = `${8 + indent * INDENT_PX}px`;
		};

		const onUp = () => {
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
			handle.removeEventListener("pointercancel", onUp);
			this.root.removeClass("keep-is-dragging");

			if ((slot === origSlot && indent === origIndent) || others.length === 0) {
				this.render();
				return;
			}
			const rest = this.items.filter((i) => !block.includes(i));
			let pos: number;
			if (slot < others.length) {
				pos = rest.indexOf(others[slot].item);
			} else {
				pos = rest.indexOf(others[others.length - 1].item) + 1;
				// Dropping at the end as a top-level item: don't adopt the
				// previous item's completed children.
				if (indent === 0) while (pos < rest.length && rest[pos].indent === 1) pos++;
			}
			block[0].indent = indent;
			rest.splice(pos, 0, ...block);
			this.items = rest;
			normalize(this.items);
			this.save();
		};

		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
		handle.addEventListener("pointercancel", onUp);
		onMove(e);
	}

	private restoreFocus() {
		const p = pendingFocus;
		if (!p || p.path !== this.ctx.sourcePath || Date.now() - p.at > 1000) return;
		this.root.win.requestAnimationFrame(() => {
			if (!this.root.isConnected) return;
			const info = this.ctx.getSectionInfo(this.root);
			if (info && info.lineStart !== p.lineStart) return;
			const el = this.root.querySelector<HTMLElement>(`.keep-row[data-idx="${p.idx}"] .keep-text`);
			if (el) setSelection(el, p.caret, p.end ?? p.caret);
		});
	}

	private save(focus?: { idx: number; caret: number; end?: number }) {
		this.dirty = false;
		const info = this.ctx.getSectionInfo(this.root);
		if (!info) {
			new Notice("Keep Lists: couldn't locate this list in the note.");
			return;
		}
		const { lineStart, lineEnd } = info;
		if (focus) pendingFocus = { path: this.ctx.sourcePath, lineStart, ...focus, at: Date.now() };
		// Show the change right away; the write will re-render it anyway.
		this.render();
		this.restoreFocus();
		this.write(lineStart, lineEnd).catch((err) => {
			console.error("Keep Lists: couldn't save the list", err);
			new Notice("Keep Lists: couldn't save the list.");
		});
	}

	private async write(lineStart: number, lineEnd: number) {
		const body = serialize(this.items);
		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		if (!(file instanceof TFile)) return;

		const editor = this.findEditor(file);
		if (editor) {
			if (!isFence(editor.getLine(lineStart)) || !isFence(editor.getLine(lineEnd))) return this.staleNotice();
			editor.replaceRange(
				this.items.length ? body + "\n" : "",
				{ line: lineStart + 1, ch: 0 },
				{ line: lineEnd, ch: 0 },
			);
		} else {
			await this.plugin.app.vault.process(file, (data) => {
				const lines = data.split("\n");
				if (!isFence(lines[lineStart] ?? "") || !isFence(lines[lineEnd] ?? "")) {
					this.staleNotice();
					return data;
				}
				lines.splice(lineStart + 1, lineEnd - lineStart - 1, ...(this.items.length ? body.split("\n") : []));
				return lines.join("\n");
			});
		}
	}

	private staleNotice() {
		new Notice("Keep Lists: the note changed underneath this list; please try again.");
	}

	private findEditor(file: TFile): Editor | null {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === file.path && view.getMode() === "source") {
				return view.editor;
			}
		}
		return null;
	}
}

// Internal API: the baked list of every command hotkey (custom + default).
interface HotkeyManager {
	bake(): void;
	bakedHotkeys: { modifiers: string | null; key: string | null }[];
	bakedIds: string[];
}

export default class KeepListsPlugin extends Plugin {
	lists = new WeakMap<HTMLElement, KeepList>();
	private scope!: Scope;
	private scopePushed = false;

	async onload() {
		// While an item is being edited, route the user's formatting hotkeys to it.
		this.scope = new Scope(this.app.scope);
		this.scope.register(null, null, (evt, ctx) => this.onKey(ctx));
		const watchFocus = (doc: Document) => {
			this.registerDomEvent(doc, "focusin", (e) => {
				if (isItemText(e.target) && !this.scopePushed) {
					this.app.keymap.pushScope(this.scope);
					this.scopePushed = true;
				}
			});
			this.registerDomEvent(doc, "focusout", (e) => {
				if (!isItemText(e.relatedTarget)) this.popScope();
			});
		};
		const docs = new Set<Document>([activeDocument]);
		this.app.workspace.iterateAllLeaves((leaf) => docs.add(leaf.getContainer().doc));
		docs.forEach(watchFocus);
		this.registerEvent(this.app.workspace.on("window-open", (win) => watchFocus(win.doc)));

		this.registerMarkdownCodeBlockProcessor("keep", (source, el, ctx) => {
			new KeepList(this, el, source, ctx);
		});
		this.registerEditorExtension(parkCursorOutsideLists);

		this.addCommand({
			id: "insert-keep-list",
			name: "Insert list",
			editorCallback: (editor) => {
				const line = editor.getCursor().line;
				const text = editor.getLine(line);
				const prefix = text.trim() ? "\n" : "";
				editor.replaceRange(`${prefix}\`\`\`keep\n- [ ] \n\`\`\`\n`, { line, ch: text.length });
			},
		});
	}

	onunload() {
		this.popScope();
	}

	private popScope() {
		if (!this.scopePushed) return;
		this.app.keymap.popScope(this.scope);
		this.scopePushed = false;
	}

	private onKey(ctx: KeymapContext): boolean | undefined {
		const el = activeDocument.activeElement;
		if (!isItemText(el)) return;
		const list = this.lists.get(el.closest<HTMLElement>(".keep-list")!);
		const hm = (this.app as unknown as { hotkeyManager?: HotkeyManager }).hotkeyManager;
		if (!list || !hm) return;
		hm.bake();
		const i = hm.bakedHotkeys.findIndex(
			(h) =>
				(h.modifiers === null || h.modifiers === ctx.modifiers) &&
				(!h.key || h.key === ctx.vkey || h.key.toLowerCase() === ctx.key?.toLowerCase()),
		);
		if (i < 0) return;
		const id = hm.bakedIds[i];
		const commands = (this.app as unknown as { commands: { findCommand(id: string): Command | undefined } }).commands;
		return list.onCommand(id, commands.findCommand(id) ?? null, el);
	}
}

function isItemText(el: EventTarget | null): el is HTMLElement {
	return el instanceof HTMLElement && el.hasClass("keep-text");
}
