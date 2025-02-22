'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import FileItem from './fileItem';
import * as autoBox from './autocompletedInputBox'

const FIXED_URI: vscode.Uri = vscode.Uri.parse('dired://fixed_window');

export default class DiredProvider implements vscode.TextDocumentContentProvider {
    static scheme = 'dired'; // ex: dired://<directory>

    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    private _fixed_window: boolean;
    private _show_dot_files: boolean = true;
    private _buffers: string[]; // This is a temporary buffer. Reused by multiple tabs.

    constructor(fixed_window: boolean)
    {
        this._fixed_window = fixed_window;
    }

    dispose() {
        this._onDidChange.dispose();
    }

    get onDidChange() {
        return this._onDidChange.event;
    }

    get dirname() {
        const at = vscode.window.activeTextEditor;
        if (!at) {
            return undefined;
        }
        const doc = at.document;
        if (!doc) {
            return undefined;
        }
        const line0 = doc.lineAt(0).text;
        const dir = line0.substring(0, line0.length - 1);
        return dir;
    }

    toggleDotFiles() {
        this._show_dot_files = !this._show_dot_files;
        this.reload();
    }

    enter() {
        const f = this.getFile();
        if (!f) {
            return;
        }
        const uri = f.uri;
        if (!uri) {
            return;
        }
        if (uri.scheme !== DiredProvider.scheme) {
            this.showFile(uri);
            return;
        }
        this.openDir(f.path);
    }

    reload() {
        if (!this.dirname) {
            return;
        }
        this.createBuffer(this.dirname)
            .then(() => this._onDidChange.fire(this.uri));
    }

    async createDir(dirname: string) {
        if (this.dirname) {
            const p = path.join(this.dirname, dirname);
            let uri = vscode.Uri.file(p);
            await vscode.workspace.fs.createDirectory(uri);
            this.reload();
        }
    }

    async createFile(filename: string)
    {
        const uri = vscode.Uri.file(filename);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
        this.reload();
    }

    rename(newName: string) {
        const f = this.getFile();
        if (!f) {
            return;
        }
        if (this.dirname) {
            const src = path.join(this.dirname, f.fileName);
            const n = path.join(this.dirname, newName);
            const stat = fs.lstatSync(n);
            try {
                if (stat.isDirectory()) {
                    fs.renameSync(src, path.join(n, f.fileName));
                } else {
                    fs.renameSync(src, n);
                }
                this.reload();
                vscode.window.showInformationMessage(`${f.fileName} is renamed to ${n}`);
            } catch (err) {
                vscode.window.showInformationMessage(`copy failed: ${JSON.stringify(err)}`);
            }            
        }
    }

    copy(newName: string) {
        const f = this.getFile();
        if (!f) {
            return;
        }
        if (this.dirname) {
            const src = path.join(this.dirname, f.fileName);
            const n = path.join(this.dirname, newName);
            const stat = fs.lstatSync(n);
            try {
                if (stat.isDirectory()) {
                    fs.cpSync(src, path.join(n, f.fileName), {recursive: true});
                } else {
                    fs.cpSync(src, n, {recursive: true});
                }
                this.reload();
                vscode.window.showInformationMessage(`${f.fileName} is copied to ${n}`);
            } catch (err) {
                vscode.window.showInformationMessage(`copy failed: ${JSON.stringify(err)}`);
            }
        }
    }

    delete() {
        const f = this.getFile();
        console.log(`elete(): ${f}`);
        if (!f) {
            return;
        }
        if (this.dirname) {
            const n = path.join(this.dirname, f.fileName);
            const stat = fs.lstatSync(n);
            if (stat.isDirectory()) {
                try {
                    fs.rmdirSync(n);
                } catch (err) {
                    vscode.window.showInformationMessage(`Delete ${f.fileName} directory recursively?`, {modal: true}, "Yes", "No").then(item => {
                        if (item == "Yes") {
                            fs.rmdirSync(n, {recursive: true});
                        } else {
                            vscode.window.showErrorMessage(`Did/Could not delete ${n}: ${err}`);
                        }
                        this.reload();
                        vscode.window.showInformationMessage(`${n} was deleted`);
                    });
                }
            } else {
                fs.unlinkSync(n);
                this.reload();
                vscode.window.showInformationMessage(`${n} was deleted`);
            }
        }
    }

    select() {
        this.selectFiles(true);
    }

    unselect() {
        this.selectFiles(false);
    }

    goUpDir() {
        if (!this.dirname || this.dirname === "/") {
            return;
        }
        const p = path.join(this.dirname, "..");
        this.openDir(p);
    }

    openDir(path: string) {
        const f = new FileItem(path, "", true); // Incomplete FileItem just to get URI.
        const uri = f.uri;
        if (uri) {
            this.createBuffer(path)
                .then(() => vscode.workspace.openTextDocument(uri))
                .then(doc => vscode.window.showTextDocument(
                    doc,
                    this.getTextDocumentShowOptions(true)
                ));
        }
    }

    showFile(uri: vscode.Uri) {
        vscode.workspace.openTextDocument(uri).then(doc => {
            vscode.window.showTextDocument(doc, this.getTextDocumentShowOptions(false));
        });
        // TODO: show warning when open file failed
        // vscode.window.showErrorMessage(`Could not open file ${uri.fsPath}: ${err}`);
    }

    provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
        return this.render();
    }

    private get uri(): vscode.Uri {
        if (this.dirname) {
            const f = new FileItem(this.dirname, "", true); // Incomplete FileItem just to get URI.
            const uri = f.uri;
            if (uri) {
                return uri;
            }
        }
        return FIXED_URI;
    }

    private render(): Thenable<string> {
        return new Promise((resolve) => {
            resolve(this._buffers.join('\n'));
        });
    }

    private createBuffer(dirname: string): Thenable<string[]> {
        return new Promise((resolve) => {
            let files: FileItem[] = [];
            if (fs.lstatSync(dirname).isDirectory()) {
                try {
                    files = this.readDir(dirname);
                } catch (err) {
                    vscode.window.showErrorMessage(`Could not read ${dirname}: ${err}`);
                }
            }

            this._buffers = [
                dirname + ":", // header line
            ];
            this._buffers = this._buffers.concat(files.map((f) => f.line()));

            resolve(this._buffers);
        });
    }

    private readDir(dirname: string): FileItem[] {
        const files = [".", ".."].concat(fs.readdirSync(dirname));
        return <FileItem[]>files.map((filename) => {
            const p = path.join(dirname, filename);
            try {
                const stat = fs.lstatSync(p);
                return FileItem.create(dirname, filename, stat);
            } catch (err) {
                vscode.window.showErrorMessage(`Could not get stat of ${p}: ${err}`);
                return null;
            }
        }).filter((fileItem) => {
            if (fileItem) {
                if (this._show_dot_files) return true;
                let filename = fileItem.fileName;
                if (filename == '..' || filename == '.' ) return true;
                return filename.substring(0, 1) != '.';
            } else {
                return false;
            }
        });
    }

    private getFile(): FileItem | null {
        const at = vscode.window.activeTextEditor;
        if (!at) {
            return null;
        }
        const cursor = at.selection.active;
        if (cursor.line < 1) {
            return null;
        }
        const lineText = at.document.lineAt(cursor.line);
        if (this.dirname && lineText) {
            return FileItem.parseLine(this.dirname, lineText.text);
        }
        return null;
    }

    private selectFiles(value: boolean) {
        if (!this.dirname) {
            return;
        }
        const at = vscode.window.activeTextEditor;
        if (!at) {
            return;
        }
        const doc = at.document;
        if (!doc) {
            return;
        }
        this._buffers = [];
        for (let i = 0; i < doc.lineCount; i++) {
            this._buffers.push(doc.lineAt(i).text);
        }

        let start = 0;
        let end = 0;
        let allowSelectDot = false; // Want to copy emacs's behavior exactly

        if (at.selection.isEmpty) {
            const cursor = at.selection.active;
            if (cursor.line === 0) { // Select all
                start = 1;
                end = doc.lineCount;
            } else {
                allowSelectDot = true;
                start = cursor.line;
                end = cursor.line + 1;
                vscode.commands.executeCommand("cursorMove", { to: "down", by: "line" });
            }
        } else {
            start = at.selection.start.line;
            end = at.selection.end.line + 1;
        }

        for (let i = start; i < end; i++) {
            const f = FileItem.parseLine(this.dirname, this._buffers[i]);
            if (f.fileName === "." || f.fileName === "..") {
                if (!allowSelectDot) {
                    continue;
                }
            }
            f.select(value);
            this._buffers[i] = f.line();
        }
        const uri = this.uri;
        this._onDidChange.fire(uri);
    }

    private getTextDocumentShowOptions(fixed_window: boolean): vscode.TextDocumentShowOptions {
        const opts: vscode.TextDocumentShowOptions = {
            preview: fixed_window,
            viewColumn: vscode.ViewColumn.Active
        };
        return opts;
    }
}
