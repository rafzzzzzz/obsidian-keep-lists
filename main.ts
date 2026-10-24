import {
	Editor,
	MarkdownPostProcessorContext,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	setIcon,
} from "obsidian";

interface Item {
	text: string;
	checked: boolean;
	indent: 0 | 1;
}

const INDENT_PX = 28;
const NEST_THRESHOLD = 20;
const LINE_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s?(.*)$/;

// Where to put the caret after our own write re-renders the block.
let pendingFocus: { path: string; lineStart: number; idx: number; caret: number; at: number } | null = null;
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

function getCaret(el: HTMLElement): number {
	const sel = window.getSelection();
	if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return el.textContent?.length ?? 0;
	const range = sel.getRangeAt(0);
	const pre = document.createRange();
	pre.selectNodeContents(el);
	pre.setEnd(range.startContainer, range.startOffset);
	return pre.toString().length;
}

function setCaret(el: HTMLElement, caret: number) {
	el.focus();
	const sel = window.getSelection();
	if (!sel) return;
	const range = document.createRange();
	const node = el.firstChild;
	if (node && node.nodeType === Node.TEXT_NODE) {
		range.setStart(node, Math.min(caret, node.textContent?.length ?? 0));
		range.collapse(true);
	} else {
		range.selectNodeContents(el);
		range.collapse(false);
	}
	sel.removeAllRanges();
	sel.addRange(range);
}

function isFence(line: string) {
	return /^\s*(```|~~~)/.test(line);
}

class KeepList {
	private items: Item[];
	private activeEl!: HTMLElement;
	private dirty = false;

	constructor(
		private plugin: KeepListsPlugin,
		private root: HTMLElement,
		source: string,
		private ctx: MarkdownPostProcessorContext,
	) {
		this.items = parse(source);
		this.root.addClass("keep-list");
		// Keep focus in the text field when clicking controls, so a blur
		// doesn't write (and re-render) before the click lands.
		this.root.addEventListener("mousedown", (e) => {
			e.stopPropagation();
			if (!(e.target as HTMLElement).closest(".keep-text")) e.preventDefault();
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
			const next = e.relatedTarget as Node | null;
			if (this.dirty && !(next && this.root.contains(next))) this.save();
		});

		const del = row.createDiv({ cls: "keep-delete", attr: { "aria-label": "Delete item" } });
		setIcon(del, "x");
		del.addEventListener("click", () => this.remove(idx));
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
		requestAnimationFrame(() => {
			if (!this.root.isConnected) return;
			const info = this.ctx.getSectionInfo(this.root);
			if (info && info.lineStart !== p.lineStart) return;
			const el = this.root.querySelector<HTMLElement>(`.keep-row[data-idx="${p.idx}"] .keep-text`);
			if (el) setCaret(el, p.caret);
		});
	}

	private async save(focus?: { idx: number; caret: number }) {
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

export default class KeepListsPlugin extends Plugin {
	async onload() {
		this.registerMarkdownCodeBlockProcessor("keep", (source, el, ctx) => {
			new KeepList(this, el, source, ctx);
		});

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
}
